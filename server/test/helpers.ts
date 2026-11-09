import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';

export interface TestServer {
  base: string;
  wsBase: string;
  cfg: Config;
  close: () => Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const cfg = loadConfig(
    { ...process.env, NODE_ENV: 'test', TURN_URLS: 'turn:turn.example.com:3478?transport=udp', TURN_SECRET: 'test-turn-secret-0123456789' },
    { registerPerHour: 1000, logLevel: 'silent', ...overrides },
  );
  const { app } = await buildApp(cfg);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}`, cfg, close: () => app.close() };
}

export async function api<T = any>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

export interface TestDevice {
  deviceId: string;
  fingerprint: string;
  publicKey: string;
  privateKey: KeyObject;
  token: string;
  sign: (msg: string) => string;
}

export function newKeyPair(): { publicKey: string; privateKey: KeyObject; sign: (m: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    publicKey: Buffer.from(raw).toString('base64'),
    privateKey,
    sign: (m: string) => sign(null, Buffer.from(m, 'utf8'), privateKey).toString('base64'),
  };
}

export async function newDevice(base: string, name = 'PC Teste'): Promise<TestDevice> {
  const kp = newKeyPair();
  const reg = await api(base, 'POST', '/api/v1/devices/register', { publicKey: kp.publicKey, name, os: 'Windows 11', appVersion: '0.1.0' });
  if (reg.status !== 200) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  const ch = await api(base, 'POST', '/api/v1/auth/device/challenge', { deviceId: reg.body.deviceId });
  const tok = await api(base, 'POST', '/api/v1/auth/device/token', {
    challengeId: ch.body.challengeId,
    deviceId: reg.body.deviceId,
    signature: kp.sign(`nexo-auth-v1:${ch.body.nonce}:${reg.body.deviceId}`),
  });
  if (tok.status !== 200) throw new Error(`token ${tok.status} ${JSON.stringify(tok.body)}`);
  return { deviceId: reg.body.deviceId, fingerprint: reg.body.fingerprint, ...kp, token: tok.body.token };
}

/** Cliente WS de teste que enfileira mensagens e permite aguardar por tipo. */
export class WsClient {
  ws!: WebSocket;
  messages: any[] = [];
  closeCode: number | null = null;
  private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  private closeWaiters: Array<(c: number) => void> = [];

  static async open(wsBase: string, token: string): Promise<WsClient> {
    const c = new WsClient();
    c.ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const i = c.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) c.waiters.splice(i, 1)[0]!.resolve(m);
      else c.messages.push(m);
    });
    c.ws.on('close', (code) => {
      c.closeCode = code;
      c.closeWaiters.forEach((r) => r(code));
    });
    await new Promise<void>((res, rej) => {
      c.ws.once('open', () => res());
      c.ws.once('error', rej);
    });
    return c;
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  next(type: string, pred: (m: any) => boolean = () => true, timeoutMs = 4000): Promise<any> {
    const match = (m: any) => m.type === type && pred(m);
    const i = this.messages.findIndex(match);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred: match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`timeout aguardando '${type}'. Recebidas: ${JSON.stringify(this.messages.map((x) => x.type))}`));
        }
      }, timeoutMs);
    });
  }

  /** Garante que nenhuma mensagem do tipo chegue dentro do intervalo. */
  async none(type: string, ms = 300): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    if (this.messages.some((m) => m.type === type)) throw new Error(`mensagem inesperada '${type}'`);
  }

  closed(timeoutMs = 4000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      this.closeWaiters.push(resolve);
      setTimeout(() => reject(new Error('timeout aguardando close')), timeoutMs);
    });
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
