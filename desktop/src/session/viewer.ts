// Viewer side of a session: WebRTC answerer (PROTOCOL.md §4).
import {
  sdpSigningMessage,
  type HostControlMsg,
  type IceCandidateJson,
  type QualityPreset,
  type SessionStartedPayload,
  type SignalData,
  type ViewerControlMsg,
} from '../net/protocol';
import type { Platform } from '../platform/types';
import { emptyStats, getApp, patchViewer, upsertTransfer, type Stats } from '../store/app';
import { uid } from '../lib/format';
import { ViewerFiles } from './files';

export interface ViewerDeps {
  platform: Platform;
  sendSignal: (data: SignalData) => void;
  /** Viewer decided the session must end (security failure, bye, …). */
  onFatal: (reason: string, message?: string) => void;
  onChat: (text: string) => void;
}

function sortH264First(codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  const score = (c: RTCRtpCodec) => {
    if (c.mimeType.toLowerCase() !== 'video/h264') return 0;
    const f = c.sdpFmtpLine ?? '';
    let s = 10;
    if (/packetization-mode=1/.test(f)) s += 5;
    if (/profile-level-id=42e01f/i.test(f)) s += 3;
    else if (/profile-level-id=42/i.test(f)) s += 2;
    return s;
  };
  return codecs
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

export function qualityLevel(s: Pick<Stats, 'rttMs' | 'fps' | 'packetLoss' | 'pingMs'>): 0 | 1 | 2 | 3 | 4 {
  const rtt = s.rttMs ?? s.pingMs;
  if (rtt == null) return 0;
  let level: 1 | 2 | 3 | 4 = rtt < 60 ? 4 : rtt < 130 ? 3 : rtt < 260 ? 2 : 1;
  if (s.packetLoss != null && s.packetLoss > 0.05 && level > 1) level = (level - 1) as 1 | 2 | 3;
  if (s.fps != null && s.fps > 0 && s.fps < 8 && level > 1) level = (level - 1) as 1 | 2 | 3;
  return level;
}

export class ViewerSession {
  readonly sessionId: string;
  readonly files: ViewerFiles;
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private closed = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private discTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRestart = 0;
  private restartAttempts = 0;
  private prevBytes: { bytes: number; t: number; lost: number; recv: number } | null = null;
  private pingSeq = 1;
  private gotHello = false;
  private passwordTried = false;

  constructor(
    private info: SessionStartedPayload,
    private deps: ViewerDeps,
  ) {
    this.sessionId = info.sessionId;
    this.files = new ViewerFiles(deps.platform, (patch) =>
      patchViewer((v) => ({ transfers: upsertTransfer(v.transfers, patch) })),
    );
  }

  start(): void {
    this.createPc();
    this.deps.sendSignal({ kind: 'ready' });
    this.statsTimer = setInterval(() => void this.pollStats(), 1000);
    this.pingTimer = setInterval(() => {
      this.sendControl({ t: 'ping', id: this.pingSeq++, ts: Date.now() });
    }, 2000);
  }

  /** Called when the signaling layer reconnected and the session is still active. */
  resume(): void {
    const st = this.pc?.connectionState;
    if (!this.pc || st === 'failed' || st === 'closed') {
      this.createPc();
      this.deps.sendSignal({ kind: 'ready' });
    } else if (st !== 'connected') {
      this.requestRestart(true);
    }
  }

  private createPc() {
    this.pc?.close();
    this.pendingIce = [];
    const pc = new RTCPeerConnection({ iceServers: this.info.iceServers as RTCIceServer[] });
    this.pc = pc;
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || this.pc !== pc) return;
      const c = ev.candidate.toJSON();
      const candidate: IceCandidateJson = {
        candidate: c.candidate ?? '',
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? null,
      };
      this.deps.sendSignal({ kind: 'ice', candidate });
    };
    pc.ontrack = (ev) => {
      if (this.pc !== pc) return;
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      patchViewer({ stream });
    };
    pc.ondatachannel = (ev) => {
      if (this.pc !== pc) return;
      if (ev.channel.label === 'control') this.attachControl(ev.channel);
      else if (ev.channel.label === 'files') this.files.attach(ev.channel);
    };
    pc.onconnectionstatechange = () => this.onPcState(pc);
  }

  private onPcState(pc: RTCPeerConnection) {
    if (this.pc !== pc || this.closed) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      if (this.discTimer) clearTimeout(this.discTimer);
      this.discTimer = null;
      this.restartAttempts = 0;
      const cur = getApp().viewer?.status;
      if (cur === 'reconnecting') patchViewer({ status: this.gotHello ? 'streaming' : 'connecting' });
    } else if (st === 'disconnected') {
      if (!this.discTimer) {
        this.discTimer = setTimeout(() => {
          this.discTimer = null;
          if (this.pc === pc && pc.connectionState !== 'connected') this.requestRestart();
        }, 4000);
      }
    } else if (st === 'failed') {
      this.requestRestart();
    }
  }

  private requestRestart(force = false) {
    if (this.closed) return;
    const now = Date.now();
    if (!force && now - this.lastRestart < 6000) return;
    this.lastRestart = now;
    this.restartAttempts++;
    patchViewer({ status: 'reconnecting' });
    if (this.restartAttempts > 6) {
      this.deps.onFatal('connection_failed');
      return;
    }
    this.deps.sendSignal({ kind: 'restart_request' });
  }

  private signalChain: Promise<void> = Promise.resolve();

  /** Signals are processed strictly in arrival order (ICE must not overtake its offer). */
  handleSignal(data: SignalData): Promise<void> {
    const run = this.signalChain.then(() => this.processSignal(data));
    this.signalChain = run.catch((e) => console.error('[viewer] signal', e));
    return run;
  }

  private async processSignal(data: SignalData): Promise<void> {
    if (this.closed) return;
    if (data.kind === 'offer') {
      const ok = await this.deps.platform.verify(
        this.info.peer.publicKey,
        sdpSigningMessage(this.sessionId, 'offer', data.sdp),
        data.sig ?? '',
      );
      if (!ok) {
        this.deps.onFatal('bad_signature');
        return;
      }
      // A non-restart offer on an already negotiated PC means the host rebuilt its PC.
      if (!this.pc || (!data.restart && this.pc.remoteDescription)) this.createPc();
      const pc = this.pc!;
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      this.preferH264(pc);
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const sdp = pc.localDescription?.sdp ?? answer.sdp ?? '';
      const sig = await this.deps.platform.sign(sdpSigningMessage(this.sessionId, 'answer', sdp));
      this.deps.sendSignal({ kind: 'answer', sdp, sig });
    } else if (data.kind === 'ice') {
      const init: RTCIceCandidateInit = {
        candidate: data.candidate.candidate,
        sdpMid: data.candidate.sdpMid ?? undefined,
        sdpMLineIndex: data.candidate.sdpMLineIndex ?? undefined,
      };
      if (!this.pc || !this.pc.remoteDescription) this.pendingIce.push(init);
      else await this.pc.addIceCandidate(init).catch((e) => console.warn('[viewer] ice', e));
    }
  }

  private preferH264(pc: RTCPeerConnection) {
    try {
      const caps = RTCRtpReceiver.getCapabilities?.('video');
      if (!caps) return;
      const sorted = sortH264First(caps.codecs);
      for (const tr of pc.getTransceivers()) {
        if (tr.receiver.track?.kind === 'video' && typeof tr.setCodecPreferences === 'function') {
          tr.setCodecPreferences(sorted);
        }
      }
    } catch (e) {
      console.warn('[viewer] setCodecPreferences', e);
    }
  }

  private attachControl(dc: RTCDataChannel) {
    this.control = dc;
    dc.onopen = () => this.sendViewport();
    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: HostControlMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onControl(msg);
    };
  }

  private onControl(msg: HostControlMsg) {
    switch (msg.t) {
      case 'auth_required': {
        const pw = getApp().pendingPassword;
        if (pw && !this.passwordTried) {
          this.passwordTried = true;
          this.authenticate(pw);
        } else {
          patchViewer({ status: 'auth', authBusy: false });
        }
        break;
      }
      case 'auth_result': {
        if (msg.ok) {
          patchViewer({ authError: null, authBusy: false, status: this.gotHello ? 'streaming' : 'connecting' });
        } else {
          const blocked = msg.reason === 'blocked' || msg.attemptsLeft === 0;
          patchViewer({
            status: 'auth',
            authBusy: false,
            authError: blocked ? 'blocked' : `left:${msg.attemptsLeft ?? ''}`,
          });
        }
        break;
      }
      case 'hello': {
        this.gotHello = true;
        const s = getApp().viewer;
        patchViewer({
          status: 'streaming',
          monitors: msg.monitors,
          currentMonitor: msg.current,
          permissions: msg.permissions,
          hostName: msg.hostName,
          authError: null,
        });
        if (s) this.sendControl({ t: 'quality', preset: s.quality, fps: s.fps });
        this.sendViewport();
        break;
      }
      case 'monitor_changed':
        patchViewer((v) => ({
          currentMonitor: msg.index,
          monitors: v.monitors.map((m) => (m.index === msg.index ? { ...m, width: msg.width, height: msg.height } : m)),
        }));
        break;
      case 'stats':
        patchViewer((v) => ({ stats: { ...v.stats, hostFps: msg.fps, encodeMs: msg.encodeMs } }));
        break;
      case 'pong': {
        const pingMs = Math.max(0, Date.now() - msg.ts);
        patchViewer((v) => {
          const stats = { ...v.stats, pingMs };
          return { stats: { ...stats, level: qualityLevel(stats) } };
        });
        break;
      }
      case 'chat':
        this.deps.onChat(msg.text);
        patchViewer((v) => ({
          chat: [...v.chat, { id: msg.id || uid(), from: 'peer', text: msg.text, ts: msg.ts || Date.now() }],
          unread: v.unread + 1,
        }));
        break;
      case 'perm':
        patchViewer({ permissions: msg.permissions });
        break;
      case 'bye':
        this.deps.onFatal(msg.reason || 'peer_ended');
        break;
      default:
        break;
    }
  }

  sendControl(msg: ViewerControlMsg): boolean {
    if (!this.control || this.control.readyState !== 'open') return false;
    this.control.send(JSON.stringify(msg));
    return true;
  }

  /** Input events are dropped locally when the host did not grant `input`. */
  sendInput(msg: ViewerControlMsg): void {
    const v = getApp().viewer;
    if (!v || !v.permissions.input || v.status !== 'streaming') return;
    this.sendControl(msg);
  }

  authenticate(password: string): void {
    patchViewer({ authBusy: true });
    if (!this.sendControl({ t: 'auth', password })) patchViewer({ authBusy: false });
  }

  setQuality(preset: QualityPreset, fps: number): void {
    patchViewer({ quality: preset, fps });
    this.sendControl({ t: 'quality', preset, fps });
  }

  selectMonitor(index: number): void {
    this.sendControl({ t: 'monitor', index });
  }

  private viewport = { w: 0, h: 0 };
  setViewport(w: number, h: number): void {
    this.viewport = { w: Math.round(w), h: Math.round(h) };
    this.sendViewport();
  }
  private sendViewport() {
    if (this.viewport.w > 0) this.sendControl({ t: 'viewport', ...this.viewport });
  }

  sendChat(text: string): void {
    const msg = { t: 'chat' as const, id: uid(), text, ts: Date.now() };
    if (this.sendControl(msg)) {
      patchViewer((v) => ({ chat: [...v.chat, { id: msg.id, from: 'me', text, ts: msg.ts }] }));
    }
  }

  private async pollStats() {
    const pc = this.pc;
    if (!pc || this.closed) return;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    let inbound: any = null;
    let pair: any = null;
    let selectedPairId: string | undefined;
    const byId = new Map<string, any>();
    report.forEach((s: any) => {
      byId.set(s.id, s);
      if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
      if (s.type === 'transport' && s.selectedCandidatePairId) selectedPairId = s.selectedCandidatePairId;
    });
    if (selectedPairId) pair = byId.get(selectedPairId);
    if (!pair) {
      report.forEach((s: any) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
      });
    }
    const next: Partial<Stats> = {};
    if (pair) {
      if (typeof pair.currentRoundTripTime === 'number') next.rttMs = Math.round(pair.currentRoundTripTime * 1000);
      const l = byId.get(pair.localCandidateId);
      const r = byId.get(pair.remoteCandidateId);
      const relay = l?.candidateType === 'relay' || r?.candidateType === 'relay';
      next.route = relay ? 'relay' : 'p2p';
    }
    if (inbound) {
      next.fps = typeof inbound.framesPerSecond === 'number' ? Math.round(inbound.framesPerSecond) : next.fps ?? null;
      next.width = inbound.frameWidth ?? null;
      next.height = inbound.frameHeight ?? null;
      const now = performance.now();
      const bytes = inbound.bytesReceived ?? 0;
      const lost = inbound.packetsLost ?? 0;
      const recv = inbound.packetsReceived ?? 0;
      if (this.prevBytes) {
        const dt = (now - this.prevBytes.t) / 1000;
        if (dt > 0) next.bitrateKbps = Math.round(((bytes - this.prevBytes.bytes) * 8) / 1000 / dt);
        const dl = lost - this.prevBytes.lost;
        const dr = recv - this.prevBytes.recv;
        next.packetLoss = dl + dr > 0 ? Math.max(0, dl) / (dl + dr) : 0;
      }
      this.prevBytes = { bytes, t: now, lost, recv };
    }
    patchViewer((v) => {
      const stats = { ...v.stats, ...next };
      return { stats: { ...stats, level: qualityLevel(stats) } };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.discTimer) clearTimeout(this.discTimer);
    this.files.close();
    try {
      this.control?.close();
    } catch {
      /* ignore */
    }
    this.pc?.close();
    this.pc = null;
  }
}

export const initialViewerStats = emptyStats;
