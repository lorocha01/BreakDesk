import { Emitter } from '../lib/emitter';
import type { ClientMessage, ServerMessage } from './protocol';

export type SignalingState = 'offline' | 'connecting' | 'online';

type Events = {
  state: SignalingState;
  message: ServerMessage;
  latency: number;
  /** Closed with 4001 because another instance of this device connected. */
  replaced: void;
  /** Closed with 4401: token rejected. */
  unauthorized: void;
};

export class Signaling extends Emitter<Events> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  state: SignalingState = 'offline';
  latency: number | null = null;

  constructor(private getUrl: () => Promise<string>) {
    super();
  }

  private setState(s: SignalingState) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  start(): void {
    this.stopped = false;
    this.backoff = 1000;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'bye');
    this.setState('offline');
  }

  /** Reconnect immediately (e.g. user pressed "retry" or server URL changed). */
  reconnectNow(): void {
    this.stop();
    this.start();
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const delay = this.backoff + Math.random() * 300;
    this.backoff = Math.min(this.backoff * 2, 15_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.open();
    }, delay);
  }

  private async open() {
    if (this.stopped) return;
    this.setState('connecting');
    let url: string;
    try {
      url = await this.getUrl();
    } catch (e) {
      console.warn('[signaling] cannot obtain url/token', e);
      this.setState('offline');
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.warn('[signaling] bad url', e);
      this.setState('offline');
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.backoff = 1000;
        this.setState('online');
        this.ping();
      } else if (msg.type === 'pong') {
        this.latency = Math.max(0, Date.now() - msg.ts);
        this.emit('latency', this.latency);
      }
      this.emit('message', msg);
    };
    ws.onopen = () => {
      this.clearPing();
      this.pingTimer = setInterval(() => this.ping(), 10_000);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPing();
      this.setState('offline');
      if (ev.code === 4001) {
        this.emit('replaced', undefined);
        this.stopped = true;
        return;
      }
      if (ev.code === 4401) this.emit('unauthorized', undefined);
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private ping() {
    this.send({ type: 'ping', ts: Date.now() });
  }
}

export function wsUrlFrom(httpBase: string, token: string): string {
  const u = new URL(httpBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + '/ws';
  u.search = `token=${encodeURIComponent(token)}`;
  return u.toString();
}
