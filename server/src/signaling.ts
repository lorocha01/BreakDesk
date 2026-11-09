import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Audit } from './audit.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Tokens } from './tokens.js';
import { iceServersFor } from './turn.js';

/* ------------------------------------------------------------------ tipos */

type Mode = 'attended' | 'unattended';
type FinalStatus = 'rejected' | 'cancelled' | 'timeout' | 'ended';

export interface Permissions {
  input: boolean;
  files: boolean;
  chat: boolean;
}

interface PartyInfo {
  deviceId: string;
  name: string;
  os: string;
  fingerprint: string;
  publicKey: string;
}

interface Conn {
  ws: WebSocket;
  deviceId: string;
  ip: string;
  lastSeen: number;
  replaced: boolean;
  queue: Promise<void>;
}

interface Session {
  id: string;
  viewer: PartyInfo;
  host: PartyInfo;
  mode: Mode;
  status: 'pending' | 'active';
  permissions: Permissions | null;
  pendingTimer?: NodeJS.Timeout;
  graceTimers: Map<string, NodeJS.Timeout>;
}

export const WS_CLOSE_REPLACED = 4001;
export const WS_CLOSE_UNAUTHORIZED = 4401;

/* ------------------------------------------------------------- validação */

const DeviceId = z.string().regex(/^[1-9][0-9]{8}$/);
const SessionId = z.uuid();
const PermissionsSchema = z.object({ input: z.boolean(), files: z.boolean(), chat: z.boolean() });
const ReqId = z.union([z.string().max(64), z.number()]);

const ClientMsg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), ts: z.number().optional() }),
  z.object({
    type: z.literal('connect'),
    reqId: ReqId,
    targetId: DeviceId,
    mode: z.enum(['attended', 'unattended']),
    viewerName: z.string().trim().max(80).optional(),
  }),
  z.object({ type: z.literal('cancel'), sessionId: SessionId }),
  z.object({ type: z.literal('accept'), sessionId: SessionId, permissions: PermissionsSchema }),
  z.object({ type: z.literal('reject'), sessionId: SessionId, reason: z.string().max(40).optional() }),
  z.object({
    type: z.literal('signal'),
    sessionId: SessionId,
    data: z.looseObject({ kind: z.string().min(1).max(32) }),
  }),
  z.object({ type: z.literal('end'), sessionId: SessionId, reason: z.string().max(40).optional() }),
  z.object({
    type: z.literal('audit'),
    sessionId: SessionId.optional(),
    event: z.string().regex(/^[a-z0-9_.]{1,48}$/),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
]);
type ClientMsg = z.infer<typeof ClientMsg>;

/* ------------------------------------------------------------------- hub */

export class SignalingHub {
  private wss: WebSocketServer;
  private conns = new Map<string, Conn>();
  private sessions = new Map<string, Session>();
  private connectHits = new Map<string, number[]>();
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private cfg: Config,
    private db: Db,
    private tokens: Tokens,
    private audit: Audit,
    private log: FastifyBaseLogger,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxMessageBytes });
  }

  /** Marca como encerradas sessões que ficaram abertas (o estado vive em memória). */
  async recoverOnStartup(): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET status='ended', ended_at=now(), end_reason='server_restart',
              duration_sec = CASE WHEN accepted_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM now()-accepted_at))::int END
        WHERE status IN ('pending','active')`,
    );
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    this.heartbeat = setInterval(() => this.beat(), this.cfg.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  isOnline(deviceId: string): boolean {
    return this.conns.has(deviceId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.sessions.values()) this.clearTimers(s);
    this.sessions.clear();
    for (const c of this.conns.values()) c.ws.terminate();
    this.conns.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  /* --------------------------------------------------------- conexão */

  private clientIp(req: IncomingMessage): string {
    if (this.cfg.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? '';
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // clientes nativos (ex.: agente Rust) não enviam Origin
    return this.cfg.corsOrigins.includes('*') || this.cfg.corsOrigins.includes(origin);
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || this.closed) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!this.originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') ?? '';
    const deviceId = token ? await this.tokens.verify(token, 'device') : null;
    let info: PartyInfo | null = null;
    if (deviceId) info = await this.loadParty(deviceId).catch(() => null);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!info) {
        ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      this.onConnection(ws, info, this.clientIp(req));
    });
  }

  private async loadParty(deviceId: string): Promise<PartyInfo | null> {
    const r = await this.db.query<{ id: string; name: string; os: string; fingerprint: string; public_key: Buffer }>(
      'SELECT id, name, os, fingerprint, public_key FROM devices WHERE id=$1',
      [deviceId],
    );
    const d = r.rows[0];
    return d ? { deviceId: d.id, name: d.name, os: d.os, fingerprint: d.fingerprint, publicKey: d.public_key.toString('base64') } : null;
  }

  private onConnection(ws: WebSocket, info: PartyInfo, ip: string): void {
    const id = info.deviceId;
    const prev = this.conns.get(id);
    if (prev) {
      prev.replaced = true;
      prev.ws.close(WS_CLOSE_REPLACED, 'replaced');
    }
    const conn: Conn = { ws, deviceId: id, ip, lastSeen: Date.now(), replaced: false, queue: Promise.resolve() };
    this.conns.set(id, conn);
    void this.db.query('UPDATE devices SET last_seen_at=now() WHERE id=$1', [id]).catch(() => {});

    this.send(id, { type: 'welcome', deviceId: id, serverTime: Date.now() });

    const resumed: Record<string, unknown>[] = [];
    for (const s of this.sessions.values()) {
      if (s.status !== 'active') continue;
      const role = s.viewer.deviceId === id ? 'viewer' : s.host.deviceId === id ? 'host' : null;
      if (!role) continue;
      const t = s.graceTimers.get(id);
      if (t) {
        clearTimeout(t);
        s.graceTimers.delete(id);
      }
      const { type: _t, ...payload } = this.startedPayload(s, role, true);
      resumed.push(payload);
      this.send(this.peerOf(s, id).deviceId, { type: 'peer_status', sessionId: s.id, online: true });
    }
    this.send(id, { type: 'active_sessions', sessions: resumed });

    ws.on('pong', () => {
      conn.lastSeen = Date.now();
    });
    ws.on('message', (data, isBinary) => {
      conn.lastSeen = Date.now();
      if (isBinary) {
        this.send(id, { type: 'error', code: 'BAD_REQUEST', message: 'Somente mensagens JSON de texto.' }, conn);
        return;
      }
      let parsed: ClientMsg;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        this.send(id, { type: 'error', code: 'BAD_REQUEST', message: 'JSON inválido.' }, conn);
        return;
      }
      const r = ClientMsg.safeParse(raw);
      if (!r.success) {
        const reqId = (raw as { reqId?: unknown })?.reqId;
        const sessionId = (raw as { sessionId?: unknown })?.sessionId;
        this.send(
          id,
          {
            type: 'error',
            code: 'BAD_REQUEST',
            message: 'Mensagem inválida.',
            ...(typeof reqId === 'string' || typeof reqId === 'number' ? { reqId } : {}),
            ...(typeof sessionId === 'string' ? { sessionId } : {}),
          },
          conn,
        );
        return;
      }
      parsed = r.data;
      conn.queue = conn.queue
        .then(() => this.handle(conn, parsed))
        .catch((err) => {
          this.log.error({ err, type: parsed.type }, 'erro ao processar mensagem de sinalização');
          this.send(id, { type: 'error', code: 'INTERNAL', message: 'Erro interno.' }, conn);
        });
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => {
      /* 'close' será emitido em seguida */
    });
  }

  private onClose(conn: Conn): void {
    const id = conn.deviceId;
    if (this.conns.get(id) === conn) this.conns.delete(id);
    if (conn.replaced || this.closed) return;
    void this.db.query('UPDATE devices SET last_seen_at=now() WHERE id=$1', [id]).catch(() => {});
    for (const s of [...this.sessions.values()]) {
      const isViewer = s.viewer.deviceId === id;
      const isHost = s.host.deviceId === id;
      if (!isViewer && !isHost) continue;
      const peer = this.peerOf(s, id).deviceId;
      if (s.status === 'pending') {
        if (isViewer) void this.finish(s, 'cancelled', 'viewer_offline', [[peer, 'cancelled']]);
        else void this.finish(s, 'ended', 'peer_lost', [[peer, 'peer_lost']]);
        continue;
      }
      this.send(peer, { type: 'peer_status', sessionId: s.id, online: false });
      const timer = setTimeout(() => {
        s.graceTimers.delete(id);
        if (!this.conns.has(id) && this.sessions.get(s.id) === s) {
          void this.finish(s, 'ended', 'peer_lost', [[peer, 'peer_lost']]);
        }
      }, this.cfg.peerGraceMs);
      timer.unref();
      s.graceTimers.set(id, timer);
    }
  }

  private beat(): void {
    const now = Date.now();
    for (const c of this.conns.values()) {
      if (now - c.lastSeen > this.cfg.heartbeatTimeoutMs) {
        c.ws.terminate();
        continue;
      }
      try {
        c.ws.ping();
      } catch {
        /* ignorado */
      }
    }
  }

  /* -------------------------------------------------------- mensagens */

  private async handle(conn: Conn, msg: ClientMsg): Promise<void> {
    const me = conn.deviceId;
    switch (msg.type) {
      case 'ping':
        this.send(me, { type: 'pong', ts: msg.ts ?? null, serverTime: Date.now() }, conn);
        return;
      case 'connect':
        return this.onConnect(conn, msg);
      case 'cancel': {
        const s = this.sessionFor(conn, msg.sessionId, 'viewer');
        if (!s) return;
        if (s.status !== 'pending') return this.err(conn, 'FORBIDDEN', 'Sessão não está pendente.', { sessionId: s.id });
        await this.finish(s, 'cancelled', 'cancelled', [
          [s.host.deviceId, 'cancelled'],
          [me, 'cancelled'],
        ]);
        return;
      }
      case 'accept': {
        const s = this.sessionFor(conn, msg.sessionId, 'host');
        if (!s) return;
        if (s.status !== 'pending') return this.err(conn, 'FORBIDDEN', 'Sessão não está pendente.', { sessionId: s.id });
        if (s.pendingTimer) clearTimeout(s.pendingTimer);
        s.pendingTimer = undefined;
        s.status = 'active';
        s.permissions = msg.permissions;
        await this.db.query(`UPDATE sessions SET status='active', accepted_at=now(), permissions=$2 WHERE id=$1`, [
          s.id,
          s.permissions,
        ]);
        await this.audit.write({
          event: 'session_accepted',
          actorDevice: me,
          subjectDevice: s.viewer.deviceId,
          sessionId: s.id,
          ip: conn.ip,
          detail: { permissions: s.permissions, mode: s.mode },
        });
        this.send(s.viewer.deviceId, this.startedPayload(s, 'viewer', false));
        this.send(s.host.deviceId, this.startedPayload(s, 'host', false));
        return;
      }
      case 'reject': {
        const s = this.sessionFor(conn, msg.sessionId, 'host');
        if (!s) return;
        if (s.status !== 'pending') return this.err(conn, 'FORBIDDEN', 'Sessão não está pendente.', { sessionId: s.id });
        await this.finish(s, 'rejected', msg.reason ?? 'user', [[s.viewer.deviceId, 'rejected']], {
          actorDevice: me,
          ip: conn.ip,
        });
        return;
      }
      case 'signal': {
        const s = this.sessionFor(conn, msg.sessionId);
        if (!s) return;
        if (s.status !== 'active') return this.err(conn, 'FORBIDDEN', 'Sessão ainda não foi aceita.', { sessionId: s.id });
        const peer = this.peerOf(s, me).deviceId;
        if (!this.send(peer, { type: 'signal', sessionId: s.id, from: me, data: msg.data })) {
          this.err(conn, 'TARGET_OFFLINE', 'O outro dispositivo está offline no momento.', { sessionId: s.id });
        }
        return;
      }
      case 'end': {
        const s = this.sessionFor(conn, msg.sessionId);
        if (!s) return;
        const peer = this.peerOf(s, me).deviceId;
        const reason = msg.reason ?? 'ended';
        if (s.status === 'pending' && s.viewer.deviceId === me) {
          await this.finish(s, 'cancelled', reason, [
            [peer, 'cancelled'],
            [me, 'cancelled'],
          ]);
        } else if (s.status === 'pending') {
          await this.finish(s, 'rejected', reason, [
            [peer, 'rejected'],
            [me, 'rejected'],
          ]);
        } else {
          await this.finish(
            s,
            'ended',
            reason,
            [
              [peer, 'peer_ended'],
              [me, reason],
            ],
            { actorDevice: me, ip: conn.ip },
          );
        }
        return;
      }
      case 'audit': {
        const s = msg.sessionId ? this.sessions.get(msg.sessionId) : undefined;
        const party = s && (s.viewer.deviceId === me || s.host.deviceId === me) ? s : undefined;
        await this.audit.write({
          event: `client.${msg.event}`,
          actorDevice: me,
          subjectDevice: party ? this.peerOf(party, me).deviceId : null,
          sessionId: msg.sessionId ?? null,
          ip: conn.ip,
          detail: msg.detail ?? {},
        });
        return;
      }
    }
  }

  private takeConnect(deviceId: string): boolean {
    const now = Date.now();
    const arr = (this.connectHits.get(deviceId) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= this.cfg.connectPerMinute) {
      this.connectHits.set(deviceId, arr);
      return false;
    }
    arr.push(now);
    this.connectHits.set(deviceId, arr);
    return true;
  }

  private async onConnect(conn: Conn, msg: Extract<ClientMsg, { type: 'connect' }>): Promise<void> {
    const me = conn.deviceId;
    const reqId = msg.reqId;
    if (!this.takeConnect(me)) {
      await this.audit.write({ event: 'rate_limited', actorDevice: me, subjectDevice: msg.targetId, ip: conn.ip, detail: { kind: 'connect' } });
      return this.err(conn, 'RATE_LIMITED', 'Muitas tentativas de conexão. Aguarde um minuto.', { reqId });
    }
    if (msg.targetId === me) return this.err(conn, 'SELF', 'Não é possível conectar ao próprio dispositivo.', { reqId });
    const host = await this.loadParty(msg.targetId);
    if (!host) return this.err(conn, 'NOT_FOUND', 'ID não encontrado.', { reqId });
    if (!this.conns.has(host.deviceId)) return this.err(conn, 'TARGET_OFFLINE', 'O dispositivo está offline.', { reqId });
    let pendingForHost = 0;
    for (const s of this.sessions.values()) if (s.status === 'pending' && s.host.deviceId === host.deviceId) pendingForHost++;
    if (pendingForHost >= this.cfg.maxPendingPerHost) {
      return this.err(conn, 'BUSY', 'O dispositivo tem muitas solicitações pendentes.', { reqId });
    }
    const viewerBase = await this.loadParty(me);
    if (!viewerBase) return this.err(conn, 'FORBIDDEN', 'Dispositivo de origem não existe.', { reqId });
    const viewer: PartyInfo = { ...viewerBase, name: msg.viewerName || viewerBase.name };

    const s: Session = {
      id: randomUUID(),
      viewer,
      host,
      mode: msg.mode,
      status: 'pending',
      permissions: null,
      graceTimers: new Map(),
    };
    await this.db.query(
      `INSERT INTO sessions (id, viewer_id, host_id, viewer_name, host_name, mode, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [s.id, viewer.deviceId, host.deviceId, viewer.name, host.name, s.mode],
    );
    this.sessions.set(s.id, s);
    s.pendingTimer = setTimeout(() => {
      if (this.sessions.get(s.id) === s && s.status === 'pending') {
        void this.finish(s, 'timeout', 'timeout', [
          [s.viewer.deviceId, 'timeout'],
          [s.host.deviceId, 'timeout'],
        ]);
      }
    }, this.cfg.pendingTimeoutMs);
    s.pendingTimer.unref();

    await this.audit.write({
      event: 'connect_request',
      actorDevice: me,
      subjectDevice: host.deviceId,
      sessionId: s.id,
      ip: conn.ip,
      detail: { mode: s.mode },
    });
    this.send(me, {
      type: 'connect_pending',
      reqId,
      sessionId: s.id,
      target: { deviceId: host.deviceId, name: host.name, os: host.os, fingerprint: host.fingerprint },
    });
    this.send(host.deviceId, { type: 'incoming', sessionId: s.id, mode: s.mode, viewer });
  }

  /* -------------------------------------------------------- utilitários */

  private startedPayload(s: Session, role: 'viewer' | 'host', resumed: boolean): Record<string, unknown> {
    const self = role === 'viewer' ? s.viewer : s.host;
    const peer = role === 'viewer' ? s.host : s.viewer;
    return {
      type: 'session_started',
      sessionId: s.id,
      role,
      mode: s.mode,
      peer,
      permissions: s.permissions,
      iceServers: iceServersFor(this.cfg, self.deviceId).iceServers,
      ...(resumed ? { resumed: true } : {}),
    };
  }

  private peerOf(s: Session, deviceId: string): PartyInfo {
    return s.viewer.deviceId === deviceId ? s.host : s.viewer;
  }

  /** Busca a sessão garantindo que o remetente participa dela (e, opcionalmente, com o papel exigido). */
  private sessionFor(conn: Conn, sessionId: string, role?: 'viewer' | 'host'): Session | null {
    const s = this.sessions.get(sessionId);
    const me = conn.deviceId;
    const ok = s && (role ? s[role].deviceId === me : s.viewer.deviceId === me || s.host.deviceId === me);
    if (!s || !ok) {
      this.err(conn, 'NOT_FOUND', 'Sessão não encontrada.', { sessionId });
      return null;
    }
    return s;
  }

  private clearTimers(s: Session): void {
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
    for (const t of s.graceTimers.values()) clearTimeout(t);
    s.graceTimers.clear();
  }

  private async finish(
    s: Session,
    status: FinalStatus,
    endReason: string,
    notify: Array<[string, string]>,
    actor: { actorDevice?: string; ip?: string } = {},
  ): Promise<void> {
    if (this.sessions.get(s.id) !== s) return; // já finalizada
    this.sessions.delete(s.id);
    this.clearTimers(s);
    for (const [deviceId, reason] of notify) this.send(deviceId, { type: 'session_ended', sessionId: s.id, reason });
    const r = await this.db.query<{ duration_sec: number }>(
      `UPDATE sessions SET status=$2, ended_at=now(), end_reason=$3,
              duration_sec = CASE WHEN accepted_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM now()-accepted_at))::int END
        WHERE id=$1 RETURNING duration_sec`,
      [s.id, status, endReason],
    );
    await this.audit.write({
      event: `session_${status}`,
      actorDevice: actor.actorDevice ?? s.viewer.deviceId,
      subjectDevice: actor.actorDevice === s.host.deviceId ? s.viewer.deviceId : s.host.deviceId,
      sessionId: s.id,
      ip: actor.ip ?? null,
      detail: { reason: endReason, durationSec: r.rows[0]?.duration_sec ?? 0 },
    });
  }

  private err(conn: Conn, code: string, message: string, extra: Record<string, unknown> = {}): void {
    this.send(conn.deviceId, { type: 'error', ...extra, code, message }, conn);
  }

  /** Envia para o socket atual do dispositivo (ou um específico). Retorna false se offline. */
  private send(deviceId: string, msg: Record<string, unknown>, conn?: Conn): boolean {
    const c = conn ?? this.conns.get(deviceId);
    if (!c || c.ws.readyState !== WebSocket.OPEN) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }
}
