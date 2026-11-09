// Host-side orchestration (desktop only). The media/input engine lives in Rust;
// this module relays signaling between the server and the Rust engine (PROTOCOL.md §5).
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import {
  sdpSigningMessage,
  type ClientMessage,
  type PeerInfo,
  type Permissions,
  type SessionStartedPayload,
  type SignalData,
} from '../net/protocol';
import type { Platform } from '../platform/types';
import { t } from '../i18n';
import { chime } from '../lib/sound';
import { uid } from '../lib/format';
import {
  getApp,
  notify,
  patchHost,
  setApp,
  upsertTransfer,
  type HostRunState,
  type IncomingRequest,
} from '../store/app';
import { trustStatus, pinPeer } from './trust';

export interface IndicatorState {
  active: boolean;
  peerName: string;
  peerId: string;
  startedAt: number;
  state: HostRunState;
  unread: number;
}

export class HostController {
  private unlisten: Array<() => void> = [];
  private stopping = new Set<string>();
  /** Serializes host_start and host_signal so Rust never sees a signal before its session exists. */
  private chain: Promise<void> = Promise.resolve();

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn);
    this.chain = run.catch((e) => console.error('[host]', e));
    return run;
  }

  constructor(
    private platform: Platform,
    private send: (msg: ClientMessage) => boolean,
  ) {}

  get supported(): boolean {
    return !!this.platform.host;
  }

  async init(): Promise<void> {
    const host = this.platform.host;
    if (!host) return;
    const on = async (ev: Parameters<typeof host.listen>[0], cb: (p: any) => void) => {
      try {
        this.unlisten.push(await host.listen(ev, cb));
      } catch (e) {
        console.warn('[host] listen failed', ev, e);
      }
    };
    await on('host://offer', (p: { sessionId: string; sdp: string; restart?: boolean }) => void this.onOffer(p));
    await on('host://ice', (p: { sessionId: string; candidate: any }) => {
      if (getApp().host?.sessionId !== p.sessionId) return;
      this.send({ type: 'signal', sessionId: p.sessionId, data: { kind: 'ice', candidate: p.candidate } });
    });
    await on('host://state', (p: { sessionId: string; state: HostRunState; detail?: string }) => {
      if (getApp().host?.sessionId !== p.sessionId) return;
      patchHost({ state: p.state });
      if (p.state === 'closed') {
        this.send({ type: 'end', sessionId: p.sessionId, reason: p.detail || 'ended' });
        this.finish(p.sessionId, p.detail || 'ended', true);
      }
      this.pushIndicator();
    });
    await on('host://chat', (p: { sessionId: string; id: string; text: string; ts: number }) => {
      const h = getApp().host;
      if (!h || h.sessionId !== p.sessionId) return;
      patchHost((x) => ({
        chat: [...x.chat, { id: p.id || uid(), from: 'peer', text: p.text, ts: p.ts || Date.now() }],
        unread: x.unread + 1,
      }));
      notify('info', t.notif.chatFrom(h.peer.name || h.peer.deviceId), p.text);
      this.platform.notify(t.notif.chatFrom(h.peer.name || h.peer.deviceId), p.text);
      this.pushIndicator();
    });
    await on(
      'host://transfer',
      (p: {
        sessionId: string;
        id: string | number;
        direction: 'upload' | 'download';
        name: string;
        bytes: number;
        total: number;
        state: 'active' | 'done' | 'cancelled' | 'error';
        message?: string;
      }) => {
        if (getApp().host?.sessionId !== p.sessionId) return;
        patchHost((x) => ({
          transfers: upsertTransfer(x.transfers, {
            id: `h${p.id}`,
            direction: p.direction,
            name: p.name,
            bytes: p.bytes,
            total: p.total,
            state: p.state,
            message: p.message,
          }),
        }));
        if (p.state === 'done') notify('success', t.notif.transferDone, p.name, { toast: false });
        if (p.state === 'error') notify('error', t.notif.transferFailed, p.message || p.name);
      },
    );
    await on('host://auth', (p: { sessionId: string; ok: boolean; viewerId: string }) => {
      this.send({
        type: 'audit',
        sessionId: p.sessionId,
        event: p.ok ? 'unattended_auth_ok' : 'unattended_auth_failed',
        detail: { viewerId: p.viewerId },
      });
      if (p.ok) notify('warning', t.notif.unattendedAccess, `ID ${p.viewerId}`);
      else notify('warning', t.notif.authFailed, `ID ${p.viewerId}`);
    });
    await on('host://ended', (p: { sessionId: string; reason: string }) => {
      if (getApp().host?.sessionId !== p.sessionId) return;
      this.send({ type: 'end', sessionId: p.sessionId, reason: p.reason });
      this.finish(p.sessionId, p.reason, true);
    });

    // Indicator window → main window
    this.unlisten.push(await listen('indicator://hello', () => this.pushIndicator()));
    this.unlisten.push(await listen('indicator://end', () => void this.end('user')));
    this.unlisten.push(
      await listen('indicator://open-chat', async () => {
        await this.showMain();
        setApp({ view: 'home' });
        window.dispatchEvent(new CustomEvent('nexo:open-host-chat'));
      }),
    );
  }

  private async showMain() {
    try {
      const w = getCurrentWindow();
      await w.show();
      await w.unminimize();
      await w.setFocus();
    } catch {
      /* window API not permitted */
    }
  }

  // ---- signaling from server -------------------------------------------------

  onIncoming(sessionId: string, mode: 'attended' | 'unattended', viewer: PeerInfo): void {
    const s = getApp();
    if (!this.supported) {
      this.send({ type: 'reject', sessionId, reason: 'not_allowed' });
      return;
    }
    if (s.host) {
      this.send({ type: 'reject', sessionId, reason: 'busy' });
      return;
    }
    const trust = trustStatus(viewer);
    if (trust === 'mismatch') {
      this.send({ type: 'reject', sessionId, reason: 'key_mismatch' });
      setApp({
        securityAlert: { deviceId: viewer.deviceId, expected: s.settings.trustedKeys[viewer.deviceId]?.fingerprint ?? '', got: viewer.fingerprint },
      });
      notify('error', t.notif.keyChanged, t.errors.keyMismatch);
      return;
    }
    if (mode === 'unattended') {
      const u = s.settings.unattended;
      const allowed = u.enabled && u.hasPassword && (u.allowedDeviceIds.length === 0 || u.allowedDeviceIds.includes(viewer.deviceId));
      if (allowed) {
        // Password is verified end-to-end by the Rust engine over the data channel.
        this.send({ type: 'accept', sessionId, permissions: s.settings.defaultPermissions });
      } else {
        this.send({ type: 'reject', sessionId, reason: 'not_allowed' });
        this.send({ type: 'audit', sessionId, event: 'unattended_refused', detail: { viewerId: viewer.deviceId } });
      }
      return;
    }
    const req: IncomingRequest = { sessionId, mode, viewer, receivedAt: Date.now(), known: trust === 'known' };
    setApp((st) => ({ incoming: [...st.incoming.filter((r) => r.sessionId !== sessionId), req] }));
    chime();
    notify('info', t.notif.incoming, `${viewer.name || 'ID'} · ${viewer.deviceId}`, { toast: false });
    this.platform.notify(t.notif.incoming, `${viewer.name || ''} (${viewer.deviceId})`);
    void this.showMain();
  }

  accept(sessionId: string, permissions: Permissions): void {
    setApp((st) => ({ incoming: st.incoming.filter((r) => r.sessionId !== sessionId) }));
    if (getApp().host) {
      this.send({ type: 'reject', sessionId, reason: 'busy' });
      return;
    }
    this.send({ type: 'accept', sessionId, permissions });
  }

  reject(sessionId: string, reason = 'user'): void {
    setApp((st) => ({ incoming: st.incoming.filter((r) => r.sessionId !== sessionId) }));
    this.send({ type: 'reject', sessionId, reason });
  }

  onStarted(p: SessionStartedPayload): Promise<void> {
    return this.serial(() => this.doStart(p));
  }

  private async doStart(p: SessionStartedPayload): Promise<void> {
    const host = this.platform.host;
    const cur = getApp().host;
    if (cur && cur.sessionId === p.sessionId) return; // resumed, engine still running
    if (!host || cur) {
      this.send({ type: 'end', sessionId: p.sessionId, reason: 'busy' });
      return;
    }
    if (p.resumed) {
      // App restarted while a session was active: do not silently resume hosting.
      this.send({ type: 'end', sessionId: p.sessionId, reason: 'ended' });
      return;
    }
    if (trustStatus(p.peer) === 'mismatch') {
      this.send({ type: 'end', sessionId: p.sessionId, reason: 'key_mismatch' });
      return;
    }
    await pinPeer(p.peer);
    setApp({
      host: {
        sessionId: p.sessionId,
        peer: p.peer,
        mode: p.mode,
        permissions: p.permissions,
        state: 'connecting',
        startedAt: Date.now(),
        chat: [],
        unread: 0,
        transfers: [],
      },
    });
    notify('info', t.notif.connected, t.hosting.beingAccessed(p.peer.name || p.peer.deviceId));
    try {
      await host.start({
        sessionId: p.sessionId,
        mode: p.mode,
        iceServers: p.iceServers,
        permissions: p.permissions,
        viewer: { deviceId: p.peer.deviceId, name: p.peer.name },
      });
    } catch (e) {
      console.error('[host] start failed', e);
      notify('error', t.errors.generic, String(e));
      this.send({ type: 'end', sessionId: p.sessionId, reason: 'connection_failed' });
      this.finish(p.sessionId, 'connection_failed', false);
      return;
    }
    void this.openIndicator();
  }

  onSignal(sessionId: string, data: SignalData): Promise<void> {
    return this.serial(() => this.doSignal(sessionId, data));
  }

  private async doSignal(sessionId: string, data: SignalData): Promise<void> {
    const h = getApp().host;
    const host = this.platform.host;
    if (!h || !host || h.sessionId !== sessionId) return;
    if (data.kind === 'answer') {
      const ok = await this.platform.verify(h.peer.publicKey, sdpSigningMessage(sessionId, 'answer', data.sdp), data.sig ?? '');
      if (!ok) {
        notify('error', t.notif.keyChanged, t.errors.badSignature);
        await this.end('bad_signature');
        return;
      }
    }
    if (data.kind === 'offer') return; // host never accepts offers
    try {
      await host.signal(sessionId, data);
    } catch (e) {
      console.warn('[host] signal', e);
    }
  }

  private async onOffer(p: { sessionId: string; sdp: string; restart?: boolean }) {
    if (getApp().host?.sessionId !== p.sessionId) return;
    const sig = await this.platform.sign(sdpSigningMessage(p.sessionId, 'offer', p.sdp));
    this.send({ type: 'signal', sessionId: p.sessionId, data: { kind: 'offer', sdp: p.sdp, sig, restart: !!p.restart } });
  }

  onSessionEnded(sessionId: string, reason: string): void {
    setApp((st) => ({ incoming: st.incoming.filter((r) => r.sessionId !== sessionId) }));
    if (getApp().host?.sessionId === sessionId) this.finish(sessionId, reason, false);
  }

  onPeerStatus(sessionId: string, online: boolean): void {
    if (getApp().host?.sessionId !== sessionId) return;
    if (!online) patchHost({ state: 'reconnecting' });
    this.pushIndicator();
  }

  async end(reason = 'user'): Promise<void> {
    const h = getApp().host;
    if (!h) return;
    this.send({ type: 'end', sessionId: h.sessionId, reason });
    this.finish(h.sessionId, reason, false);
  }

  sendChat(text: string): void {
    const h = getApp().host;
    if (!h || !this.platform.host) return;
    const id = uid();
    void this.platform.host.sendChat(h.sessionId, text).catch((e) => console.warn(e));
    patchHost((x) => ({ chat: [...x.chat, { id, from: 'me', text, ts: Date.now() }] }));
  }

  async setPermissions(permissions: Permissions): Promise<void> {
    const h = getApp().host;
    if (!h || !this.platform.host) return;
    patchHost({ permissions });
    try {
      await this.platform.host.setPermissions(h.sessionId, permissions);
    } catch (e) {
      console.warn(e);
    }
  }

  private finish(sessionId: string, reason: string, engineAlreadyStopped: boolean) {
    if (this.stopping.has(sessionId)) return;
    this.stopping.add(sessionId);
    const h = getApp().host;
    if (!engineAlreadyStopped && this.platform.host) {
      void this.platform.host.stop(sessionId, reason).catch(() => {});
    }
    if (h && h.sessionId === sessionId) {
      setApp({ host: null });
      notify('info', t.notif.disconnected, `${h.peer.name || h.peer.deviceId} · ${t.endReasons[reason] ?? reason}`);
    }
    void this.closeIndicator();
    setTimeout(() => this.stopping.delete(sessionId), 5000);
  }

  // ---- always-on-top session indicator --------------------------------------

  indicatorState(): IndicatorState {
    const h = getApp().host;
    return h
      ? { active: true, peerName: h.peer.name, peerId: h.peer.deviceId, startedAt: h.startedAt, state: h.state, unread: h.unread }
      : { active: false, peerName: '', peerId: '', startedAt: 0, state: 'closed', unread: 0 };
  }

  pushIndicator(): void {
    if (!this.supported) return;
    void emit('indicator://state', this.indicatorState()).catch(() => {});
  }

  private async openIndicator() {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const existing = await WebviewWindow.getByLabel('indicator');
      if (existing) {
        await existing.show();
        this.pushIndicator();
        return;
      }
      const width = 440;
      let x: number | undefined;
      let y: number | undefined;
      try {
        const m = await primaryMonitor();
        if (m) {
          const sf = m.scaleFactor || 1;
          x = Math.round(m.position.x / sf + m.size.width / sf / 2 - width / 2);
          y = Math.round(m.position.y / sf + 12);
        }
      } catch {
        /* default position */
      }
      const w = new WebviewWindow('indicator', {
        url: 'index.html#/indicator',
        title: 'Nexo — sessão ativa',
        width,
        height: 56,
        x,
        y,
        center: x == null,
        resizable: false,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focus: false,
        shadow: true,
      });
      w.once('tauri://error', (e) => console.warn('[indicator] create failed', e));
      w.once('tauri://created', () => setTimeout(() => this.pushIndicator(), 300));
    } catch (e) {
      console.warn('[indicator] unavailable', e);
    }
  }

  private async closeIndicator() {
    this.pushIndicator();
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const w = await WebviewWindow.getByLabel('indicator');
      await w?.close();
    } catch {
      /* ignore */
    }
  }
}
