// App controller: boot, device registration/auth, signaling dispatch, outgoing sessions.
import { Api, ApiError } from '../net/api';
import { Signaling, wsUrlFrom } from '../net/signaling';
import { DEFAULT_SERVER_URL, isPublicServer } from '../net/protocol';
import type { ClientMessage, Mode, ServerMessage, SessionStartedPayload, Settings } from '../net/protocol';
import type { DiscoveredServer } from '../platform/types';
import { platform } from '../platform';
import { t } from '../i18n';
import { digitsOnly, uid } from '../lib/format';
import { emptyStats, getApp, notify, patchViewer, rememberRecent, setApp } from '../store/app';
import { HostController } from './host';
import { persistSettings } from './settings';
import { pinPeer, trustStatus } from './trust';
import { ViewerSession } from './viewer';
import { applyTheme } from '../theme';

class Controller {
  readonly api: Api;
  readonly sig: Signaling;
  readonly host: HostController;
  viewer: ViewerSession | null = null;
  private registerTimer: ReturnType<typeof setTimeout> | null = null;
  private registerBackoff = 2000;
  private wasOnline = false;
  private booting: Promise<void> | null = null;
  private hostname = '';
  private os = '';
  private appVersion = '';

  constructor() {
    this.api = new Api(
      () => this.serverUrl(),
      (m) => platform.sign(m),
    );
    this.sig = new Signaling(async () => {
      const token = await this.api.deviceToken();
      return wsUrlFrom(this.serverUrl(), token);
    });
    this.host = new HostController(platform, (m) => this.send(m));
    this.sig.on('state', (state) => {
      platform.log?.('info', `sinalização: ${state}`);
      setApp({ conn: state });
      if (state === 'online') {
        setApp({ serverError: null });
        if (this.wasOnline === false && getApp().booted) {
          // only toast on recoveries, not on first connect
        }
        this.wasOnline = true;
      } else if (state === 'offline' && this.wasOnline) {
        this.wasOnline = false;
        notify('warning', t.notif.serverOffline, undefined, { toast: false });
      }
    });
    this.sig.on('latency', (latency) => setApp({ latency }));
    this.sig.on('message', (m) => this.onMessage(m));
    this.sig.on('unauthorized', () => this.api.resetAuth());
    this.sig.on('replaced', () => {
      setApp({ serverError: 'Este dispositivo foi conectado em outra janela.' });
    });
  }

  send(msg: ClientMessage): boolean {
    return this.sig.send(msg);
  }

  boot(): Promise<void> {
    this.booting ??= (async () => {
      // O núcleo nativo pode ainda estar inicializando: tenta de novo por alguns segundos.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.doBoot();
          return;
        } catch (e) {
          platform.log?.('error', `boot (tentativa ${attempt}): ${String(e)}`);
          if (attempt >= 20) {
            setApp({ booted: true, serverError: `Erro ao iniciar: ${String(e)}` });
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    return this.booting;
  }

  private async doBoot() {
    let settings = await platform.loadSettings();
    // Instalador gerado com servidor público (VITE_NEXO_SERVER=https://...): passa a usá-lo,
    // inclusive em instalações antigas que estavam em modo rede local (http://). Só uma vez
    // por endereço, para respeitar quem escolher outro servidor depois.
    if (isPublicServer(DEFAULT_SERVER_URL)) {
      const mark = 'nexo.publicServerApplied';
      let applied: string | null = null;
      try {
        applied = localStorage.getItem(mark);
      } catch {
        /* sem storage */
      }
      if (applied !== DEFAULT_SERVER_URL) {
        if (settings.serverUrl !== DEFAULT_SERVER_URL && !isPublicServer(settings.serverUrl)) {
          settings = await persistSettings({ ...settings, serverUrl: DEFAULT_SERVER_URL });
          platform.log?.('info', `servidor público aplicado: ${DEFAULT_SERVER_URL}`);
        }
        try {
          localStorage.setItem(mark, DEFAULT_SERVER_URL);
        } catch {
          /* sem storage */
        }
      }
    }
    setApp({ settings });
    applyTheme(settings.theme);
    try {
      const identity = await platform.identity();
      setApp({ identity });
    } catch (e) {
      console.error('[boot] identity', e);
      setApp({ serverError: 'Falha ao carregar a identidade do dispositivo.' });
    }
    try {
      const info = await platform.deviceInfo();
      this.hostname = info.hostname;
      this.os = info.os;
      this.appVersion = info.appVersion;
    } catch {
      this.hostname = 'Computador';
      this.os = 'Desconhecido';
      this.appVersion = __APP_VERSION__;
    }
    try {
      if (platform.canHost) await this.host.init();
    } catch (e) {
      platform.log?.('error', `host.init: ${String(e)}`);
    }
    // A interface aparece imediatamente; a procura do servidor roda em segundo plano.
    setApp({ booted: true });
    void this.bootNetwork(settings.serverUrl);
  }

  private async bootNetwork(_serverUrl: string) {
    if (platform.canHost) {
      setApp({ conn: 'connecting' });
      this.lastDiscovery = Date.now();
      await this.resolveServer(await this.discover());
    }
    void this.registerLoop();
  }

  /**
   * Caminho efetivo até o servidor (não salvo): o endereço da rede local quando o servidor
   * configurado (público) está nesta mesma rede — mais rápido e não depende do roteador.
   */
  private effectiveUrl: string | null = null;

  serverUrl(): string {
    return this.effectiveUrl ?? getApp().settings.serverUrl;
  }

  /**
   * Escolhe o servidor a partir da descoberta na rede local. Devolve true se mudou algo.
   *  - Servidor da rede anuncia o endereço público configurado -> usa a rede local (efetivo).
   *  - Modo rede local (http://) -> adota o servidor canônico da rede e, se ele tiver endereço
   *    público (PC servidor com acesso pela internet), salva o público para quando sair da rede.
   *  - Nada encontrado -> volta ao endereço configurado.
   */
  private async resolveServer(found: DiscoveredServer[]): Promise<boolean> {
    platform.log?.('info', `descoberta: ${JSON.stringify(found)}`);
    const before = this.serverUrl();
    const configured = getApp().settings.serverUrl;
    const same = found.find((s) => s.publicUrl && s.publicUrl === configured);
    if (same) {
      this.effectiveUrl = same.url;
    } else if (!isPublicServer(configured) && found[0]) {
      const canon = found[0];
      const save = canon.publicUrl || canon.url;
      if (save !== configured) {
        await persistSettings({ serverUrl: save });
        if (canon.publicUrl) notify('success', t.status.serverFound, canon.publicUrl);
      }
      this.effectiveUrl = canon.publicUrl ? canon.url : null;
    } else {
      this.effectiveUrl = null;
    }
    const after = this.serverUrl();
    if (after !== before) platform.log?.('info', `servidor efetivo: ${after}`);
    return after !== before;
  }

  get deviceName(): string {
    return getApp().settings.deviceName.trim() || this.hostname || 'Computador';
  }

  get osName(): string {
    return this.os;
  }

  get version(): string {
    return this.appVersion || __APP_VERSION__;
  }

  private async registerLoop() {
    if (this.registerTimer) clearTimeout(this.registerTimer);
    this.registerTimer = null;
    const identity = getApp().identity;
    if (!identity) return;
    setApp({ conn: 'connecting' });
    try {
      const r = await this.api.register(identity.publicKey, this.deviceName, this.os, this.version);
      setApp({ deviceId: r.deviceId, serverError: null });
      platform.log?.('info', `registrado como ID ${r.deviceId} em ${this.serverUrl()}`);
      this.registerBackoff = 2000;
      this.sig.start();
    } catch (e) {
      const unreachable = e instanceof ApiError && e.status === 0;
      const msg = unreachable ? t.status.serverUnreachable : (e as Error).message;
      platform.log?.('warn', `registro em ${this.serverUrl()} falhou: ${String(e)}`);
      setApp({ conn: 'offline', serverError: msg });
      // Servidor local/LAN fora do ar: procura um servidor Nexo na rede e passa a usá-lo sozinho.
      if (unreachable && (await this.autoDiscover())) return;
      this.registerTimer = setTimeout(() => void this.registerLoop(), this.registerBackoff);
      this.registerBackoff = Math.min(this.registerBackoff * 2, 30_000);
    }
  }

  private lastDiscovery = 0;

  /** Servidor inalcançável: procura de novo na rede (troca de rede, servidor mudou de IP...). */
  private async autoDiscover(): Promise<boolean> {
    if (!platform.canHost) return false;
    if (Date.now() - this.lastDiscovery < 8000) return false;
    this.lastDiscovery = Date.now();
    const changed = await this.resolveServer(await this.discover());
    if (changed) {
      this.api.resetAuth();
      this.sig.stop();
    }
    return changed;
  }

  async discover(): Promise<DiscoveredServer[]> {
    try {
      // Tempo-limite de segurança: a procura nunca pode travar o app.
      const timeout = new Promise<DiscoveredServer[]>((r) => setTimeout(() => r([]), 4000));
      return await Promise.race([platform.discoverServers(1500), timeout]);
    } catch (e) {
      platform.log?.('warn', `descoberta falhou: ${String(e)}`);
      return [];
    }
  }

  /** User pressed retry or changed server. */
  retry(): void {
    this.registerBackoff = 2000;
    this.sig.stop();
    this.api.resetAuth();
    void this.registerLoop();
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const prev = getApp().settings;
    if (patch.theme && patch.theme !== prev.theme) applyTheme(patch.theme);
    await persistSettings(patch);
    if (patch.serverUrl !== undefined && patch.serverUrl !== prev.serverUrl) {
      this.effectiveUrl = null;
      setApp({ deviceId: null });
      this.retry();
    } else if (patch.deviceName !== undefined && patch.deviceName !== prev.deviceName) {
      this.api.updateMe({ name: this.deviceName }).catch(() => {});
    }
  }

  // ---- outgoing ------------------------------------------------------------

  connect(targetRaw: string, mode: Mode, password?: string): void {
    const targetId = digitsOnly(targetRaw);
    const s = getApp();
    if (s.viewer || s.outgoing) return;
    if (s.conn !== 'online') {
      notify('error', t.errors.notConnected);
      return;
    }
    const reqId = uid();
    setApp({
      outgoing: { reqId, targetId, mode, sessionId: null, targetName: null, status: 'sending', error: null },
      pendingPassword: mode === 'unattended' && password ? password : null,
    });
    rememberRecent({ deviceId: targetId });
    if (!this.send({ type: 'connect', reqId, targetId, mode, viewerName: this.deviceName })) {
      setApp({ outgoing: { reqId, targetId, mode, sessionId: null, targetName: null, status: 'error', error: t.errors.notConnected } });
    }
  }

  cancelOutgoing(): void {
    const o = getApp().outgoing;
    if (o?.sessionId && (o.status === 'pending' || o.status === 'sending')) this.send({ type: 'cancel', sessionId: o.sessionId });
    setApp({ outgoing: null, pendingPassword: null });
  }

  endViewer(reason = 'user'): void {
    const v = getApp().viewer;
    if (!v) return;
    this.send({ type: 'end', sessionId: v.sessionId, reason });
    this.finishViewer(reason);
  }

  private finishViewer(reason: string, message?: string) {
    const v = getApp().viewer;
    this.viewer?.close();
    this.viewer = null;
    if (v) {
      const label = message ?? t.endReasons[reason] ?? reason;
      notify(reason === 'bad_signature' || reason === 'key_mismatch' ? 'error' : 'info', t.notif.disconnected, `${v.peer.name || v.peer.deviceId} · ${label}`);
    }
    setApp({ viewer: null, pendingPassword: null });
    void platform.setFullscreen(false).catch(() => {});
  }

  private startViewer(p: SessionStartedPayload) {
    const trust = trustStatus(p.peer);
    if (trust === 'mismatch') {
      this.send({ type: 'end', sessionId: p.sessionId, reason: 'key_mismatch' });
      setApp({
        outgoing: null,
        securityAlert: { deviceId: p.peer.deviceId, expected: getApp().settings.trustedKeys[p.peer.deviceId]?.fingerprint ?? '', got: p.peer.fingerprint },
      });
      notify('error', t.notif.keyChanged, t.errors.keyMismatch);
      return;
    }
    void pinPeer(p.peer);
    const settings = getApp().settings;
    setApp({
      outgoing: null,
      viewer: {
        sessionId: p.sessionId,
        peer: p.peer,
        mode: p.mode,
        status: 'connecting',
        monitors: [],
        currentMonitor: 0,
        permissions: p.permissions,
        stats: { ...emptyStats },
        chat: [],
        unread: 0,
        transfers: [],
        startedAt: Date.now(),
        authError: null,
        authBusy: false,
        peerOffline: false,
        endReason: null,
        quality: settings.quality,
        fps: settings.fps,
        stream: null,
        hostName: null,
      },
    });
    rememberRecent({ deviceId: p.peer.deviceId, name: p.peer.name, os: p.peer.os });
    notify('success', t.notif.connected, `${p.peer.name || ''} · ${p.peer.deviceId}`.trim(), { toast: false });
    const sessionId = p.sessionId;
    const vs = new ViewerSession(p, {
      platform,
      sendSignal: (data) => this.send({ type: 'signal', sessionId, data }),
      onFatal: (reason, message) => {
        if (this.viewer !== vs) return;
        this.send({ type: 'end', sessionId, reason });
        this.finishViewer(reason, message);
      },
      onChat: (text) => platform.notify(t.notif.chatFrom(p.peer.name || p.peer.deviceId), text),
    });
    this.viewer = vs;
    vs.start();
  }

  // ---- dispatch --------------------------------------------------------------

  private onMessage(m: ServerMessage) {
    switch (m.type) {
      case 'welcome':
        if (m.deviceId) setApp({ deviceId: m.deviceId });
        break;
      case 'active_sessions':
        for (const s of m.sessions) {
          if (s.role === 'viewer') {
            if (this.viewer && this.viewer.sessionId === s.sessionId) this.viewer.resume();
            else if (!this.viewer) this.startViewer({ ...s, resumed: true });
            else this.send({ type: 'end', sessionId: s.sessionId, reason: 'busy' });
          } else {
            void this.host.onStarted({ ...s, resumed: true });
          }
        }
        break;
      case 'connect_pending': {
        const o = getApp().outgoing;
        if (o && o.reqId === m.reqId) {
          setApp({ outgoing: { ...o, sessionId: m.sessionId, targetName: m.target?.name ?? null, status: 'pending' } });
          rememberRecent({ deviceId: m.target.deviceId, name: m.target.name, os: m.target.os });
        }
        break;
      }
      case 'error': {
        const o = getApp().outgoing;
        const text = (t.errors as Record<string, string>)[m.code] ?? m.message ?? t.errors.generic;
        if (o && (m.reqId === o.reqId || (m.sessionId && m.sessionId === o.sessionId))) {
          setApp({ outgoing: { ...o, status: 'error', error: text } });
        } else {
          notify('error', text);
        }
        break;
      }
      case 'incoming':
        this.host.onIncoming(m.sessionId, m.mode, m.viewer);
        break;
      case 'session_started': {
        const { type: _ignored, ...payload } = m;
        if (payload.role === 'viewer') {
          const o = getApp().outgoing;
          if (this.viewer && this.viewer.sessionId === payload.sessionId) {
            this.viewer.resume();
          } else if ((o && o.sessionId === payload.sessionId) || payload.resumed || !this.viewer) {
            this.startViewer(payload);
          } else {
            this.send({ type: 'end', sessionId: payload.sessionId, reason: 'busy' });
          }
        } else {
          void this.host.onStarted(payload);
        }
        break;
      }
      case 'signal':
        if (this.viewer && this.viewer.sessionId === m.sessionId) {
          this.viewer.handleSignal(m.data).catch((e) => console.error('[viewer] signal', e));
        } else {
          void this.host.onSignal(m.sessionId, m.data);
        }
        break;
      case 'peer_status':
        if (getApp().viewer?.sessionId === m.sessionId) {
          patchViewer({ peerOffline: !m.online });
        }
        this.host.onPeerStatus(m.sessionId, m.online);
        break;
      case 'session_ended': {
        const o = getApp().outgoing;
        if (o && o.sessionId === m.sessionId) {
          if (m.reason === 'rejected' || m.reason === 'not_allowed' || m.reason === 'user' || m.reason === 'busy' || m.reason === 'key_mismatch') {
            setApp({
              outgoing: {
                ...o,
                status: 'rejected',
                error: m.reason === 'busy' ? t.errors.BUSY : m.reason === 'not_allowed' ? t.endReasons.not_allowed : null,
              },
            });
          } else if (m.reason === 'timeout') {
            setApp({ outgoing: { ...o, status: 'timeout' } });
          } else if (m.reason !== 'cancelled') {
            setApp({ outgoing: { ...o, status: 'error', error: t.endReasons[m.reason] ?? m.reason } });
          }
        }
        if (this.viewer && this.viewer.sessionId === m.sessionId) this.finishViewer(m.reason);
        this.host.onSessionEnded(m.sessionId, m.reason);
        break;
      }
      default:
        break;
    }
  }
}

export const controller = new Controller();
