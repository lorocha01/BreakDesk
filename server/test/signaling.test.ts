import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, newDevice, sleep, startServer, WsClient, type TestDevice, type TestServer } from './helpers.js';

let srv: TestServer;
const clients: WsClient[] = [];
const PERMS = { input: true, files: false, chat: true };

beforeAll(async () => {
  srv = await startServer({ pendingTimeoutMs: 400, peerGraceMs: 400 });
});
afterAll(async () => {
  clients.forEach((c) => c.close());
  await srv.close();
});

async function online(d: TestDevice): Promise<WsClient> {
  const c = await WsClient.open(srv.wsBase, d.token);
  clients.push(c);
  const w = await c.next('welcome');
  expect(w.deviceId).toBe(d.deviceId);
  await c.next('active_sessions');
  return c;
}

async function pair() {
  const viewer = await newDevice(srv.base, 'Viewer PC');
  const host = await newDevice(srv.base, 'Host PC');
  return { viewer, host, vws: await online(viewer), hws: await online(host) };
}

async function request(vws: WsClient, hws: WsClient, hostId: string, mode = 'attended') {
  const reqId = `r${Math.random()}`;
  vws.send({ type: 'connect', reqId, targetId: hostId, mode, viewerName: 'Suporte TI' });
  const pending = await vws.next('connect_pending', (m) => m.reqId === reqId);
  const incoming = await hws.next('incoming', (m) => m.sessionId === pending.sessionId);
  return { pending, incoming, sessionId: pending.sessionId as string };
}

describe('fluxo completo de sessão', () => {
  it('connect → incoming → accept → started → signal ↔ → end → histórico + auditoria', async () => {
    const { viewer, host, vws, hws } = await pair();
    const { pending, incoming, sessionId } = await request(vws, hws, host.deviceId);
    expect(pending.target).toEqual({ deviceId: host.deviceId, name: 'Host PC', os: 'Windows 11', fingerprint: host.fingerprint });
    expect(incoming).toMatchObject({
      mode: 'attended',
      viewer: { deviceId: viewer.deviceId, name: 'Suporte TI', fingerprint: viewer.fingerprint, publicKey: viewer.publicKey },
    });

    hws.send({ type: 'accept', sessionId, permissions: PERMS });
    const sv = await vws.next('session_started');
    const sh = await hws.next('session_started');
    expect(sv).toMatchObject({ sessionId, role: 'viewer', mode: 'attended', permissions: PERMS, peer: { deviceId: host.deviceId, publicKey: host.publicKey } });
    expect(sh).toMatchObject({ sessionId, role: 'host', permissions: PERMS, peer: { deviceId: viewer.deviceId } });
    expect(sv.iceServers.find((s: any) => s.username).username).toMatch(new RegExp(`:${viewer.deviceId}$`));
    expect(sh.iceServers.find((s: any) => s.username).username).toMatch(new RegExp(`:${host.deviceId}$`));

    vws.send({ type: 'signal', sessionId, data: { kind: 'ready' } });
    expect(await hws.next('signal')).toEqual({ type: 'signal', sessionId, from: viewer.deviceId, data: { kind: 'ready' } });
    hws.send({ type: 'signal', sessionId, data: { kind: 'offer', sdp: 'v=0...', sig: 'abc' } });
    expect((await vws.next('signal')).data).toEqual({ kind: 'offer', sdp: 'v=0...', sig: 'abc' });
    vws.send({ type: 'signal', sessionId, data: { kind: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } } });
    expect((await hws.next('signal')).data.kind).toBe('ice');

    await sleep(1100);
    vws.send({ type: 'end', sessionId });
    expect(await hws.next('session_ended')).toEqual({ type: 'session_ended', sessionId, reason: 'peer_ended' });
    expect((await vws.next('session_ended')).sessionId).toBe(sessionId);

    await sleep(100);
    const hist = await api(srv.base, 'GET', '/api/v1/sessions', undefined, host.token);
    const row = hist.body.sessions.find((s: any) => s.id === sessionId);
    expect(row).toMatchObject({ viewerId: viewer.deviceId, hostId: host.deviceId, role: 'host', status: 'ended', mode: 'attended', viewerName: 'Suporte TI', hostName: 'Host PC' });
    expect(row.durationSec).toBeGreaterThanOrEqual(1);
    expect(row.acceptedAt).toBeTruthy();
    expect(row.endedAt).toBeTruthy();
    const vh = await api(srv.base, 'GET', '/api/v1/sessions?limit=5', undefined, viewer.token);
    expect(vh.body.sessions[0]).toMatchObject({ id: sessionId, role: 'viewer' });

    const audit = await api(srv.base, 'GET', '/api/v1/audit', undefined, host.token);
    const events = audit.body.events.filter((e: any) => e.sessionId === sessionId).map((e: any) => e.event);
    expect(events).toEqual(expect.arrayContaining(['connect_request', 'session_accepted', 'session_ended']));
  });

  it('sinal antes do aceite é proibido e terceiros não acessam a sessão', async () => {
    const { host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    vws.send({ type: 'signal', sessionId, data: { kind: 'ready' } });
    expect((await vws.next('error')).code).toBe('FORBIDDEN');
    const intruder = await online(await newDevice(srv.base));
    intruder.send({ type: 'accept', sessionId, permissions: PERMS });
    expect(await intruder.next('error')).toMatchObject({ code: 'NOT_FOUND', sessionId });
    vws.send({ type: 'accept', sessionId, permissions: PERMS }); // viewer não pode aceitar
    expect((await vws.next('error')).code).toBe('NOT_FOUND');
    vws.send({ type: 'cancel', sessionId });
  });

  it('cliente pode registrar evento de auditoria', async () => {
    const { host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    hws.send({ type: 'accept', sessionId, permissions: PERMS });
    await hws.next('session_started');
    hws.send({ type: 'audit', sessionId, event: 'auth_failed', detail: { attempts: 1 } });
    await sleep(150);
    const a = await api(srv.base, 'GET', '/api/v1/audit', undefined, host.token);
    expect(a.body.events.find((e: any) => e.event === 'client.auth_failed')).toMatchObject({ sessionId, detail: { attempts: 1 } });
    hws.send({ type: 'end', sessionId });
  });
});

describe('recusa, cancelamento e expiração', () => {
  it('reject', async () => {
    const { host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    hws.send({ type: 'reject', sessionId, reason: 'user' });
    expect(await vws.next('session_ended')).toEqual({ type: 'session_ended', sessionId, reason: 'rejected' });
    await sleep(100);
    const h = await api(srv.base, 'GET', '/api/v1/sessions', undefined, host.token);
    expect(h.body.sessions[0]).toMatchObject({ id: sessionId, status: 'rejected', endReason: 'user', durationSec: 0 });
  });

  it('cancel', async () => {
    const { host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    vws.send({ type: 'cancel', sessionId });
    expect(await hws.next('session_ended')).toEqual({ type: 'session_ended', sessionId, reason: 'cancelled' });
    hws.send({ type: 'accept', sessionId, permissions: PERMS });
    expect((await hws.next('error')).code).toBe('NOT_FOUND');
  });

  it('timeout de pendência', async () => {
    const { host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    expect((await vws.next('session_ended')).reason).toBe('timeout');
    expect((await hws.next('session_ended')).reason).toBe('timeout');
    await sleep(100);
    const h = await api(srv.base, 'GET', '/api/v1/sessions', undefined, host.token);
    expect(h.body.sessions.find((s: any) => s.id === sessionId).status).toBe('timeout');
  });
});

describe('erros de conexão e limites', () => {
  it('alvo offline, inexistente e o próprio ID', async () => {
    const viewer = await newDevice(srv.base);
    const offline = await newDevice(srv.base);
    const vws = await online(viewer);
    vws.send({ type: 'connect', reqId: 1, targetId: offline.deviceId, mode: 'attended' });
    expect(await vws.next('error')).toMatchObject({ reqId: 1, code: 'TARGET_OFFLINE' });
    vws.send({ type: 'connect', reqId: 2, targetId: '100000001', mode: 'attended' });
    expect(await vws.next('error')).toMatchObject({ reqId: 2, code: 'NOT_FOUND' });
    vws.send({ type: 'connect', reqId: 3, targetId: viewer.deviceId, mode: 'attended' });
    expect(await vws.next('error')).toMatchObject({ reqId: 3, code: 'SELF' });
    vws.send({ type: 'connect', reqId: 4, targetId: 'abc', mode: 'attended' });
    expect(await vws.next('error')).toMatchObject({ reqId: 4, code: 'BAD_REQUEST' });
  });

  it('limite de 10 conexões por minuto', async () => {
    const viewer = await newDevice(srv.base);
    const offline = await newDevice(srv.base);
    const vws = await online(viewer);
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) {
      vws.send({ type: 'connect', reqId: i, targetId: offline.deviceId, mode: 'attended' });
      codes.push((await vws.next('error', (m) => m.reqId === i)).code);
    }
    expect(codes.slice(0, 10).every((c) => c === 'TARGET_OFFLINE')).toBe(true);
    expect(codes[10]).toBe('RATE_LIMITED');
  });

  it('máximo de 3 solicitações pendentes por host', async () => {
    const host = await newDevice(srv.base);
    const hws = await online(host);
    const viewers = await Promise.all([0, 1, 2, 3].map(() => newDevice(srv.base)));
    const results: string[] = [];
    for (const v of viewers) {
      const vws = await online(v);
      vws.send({ type: 'connect', reqId: 'x', targetId: host.deviceId, mode: 'unattended' });
      const m = await Promise.race([vws.next('connect_pending'), vws.next('error')]);
      results.push(m.type === 'error' ? m.code : m.type);
    }
    expect(results).toEqual(['connect_pending', 'connect_pending', 'connect_pending', 'BUSY']);
    expect((await hws.next('incoming')).mode).toBe('unattended');
  });
});

describe('ciclo de vida do WebSocket', () => {
  it('token inválido fecha com 4401', async () => {
    const c = await WsClient.open(srv.wsBase, 'nao-e-um-token');
    expect(await c.closed()).toBe(4401);
  });

  it('nova conexão do mesmo dispositivo substitui a anterior (4001)', async () => {
    const d = await newDevice(srv.base);
    const first = await online(d);
    await online(d);
    expect(await first.closed()).toBe(4001);
  });

  it('queda do par: peer_status e retomada dentro da carência', async () => {
    const { viewer, host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    hws.send({ type: 'accept', sessionId, permissions: PERMS });
    await vws.next('session_started');
    await hws.next('session_started');

    vws.close();
    expect(await hws.next('peer_status')).toEqual({ type: 'peer_status', sessionId, online: false });
    const back = await WsClient.open(srv.wsBase, viewer.token);
    clients.push(back);
    await back.next('welcome');
    const active = await back.next('active_sessions');
    expect(active.sessions).toHaveLength(1);
    expect(active.sessions[0]).toMatchObject({ sessionId, role: 'viewer', resumed: true, peer: { deviceId: host.deviceId } });
    expect(await hws.next('peer_status')).toEqual({ type: 'peer_status', sessionId, online: true });
    await sleep(600); // além da carência: sessão continua viva
    back.send({ type: 'signal', sessionId, data: { kind: 'restart_request' } });
    expect((await hws.next('signal')).data.kind).toBe('restart_request');
    back.send({ type: 'end', sessionId });
    await hws.next('session_ended');
  });

  it('queda do par além da carência encerra com peer_lost', async () => {
    const { host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    hws.send({ type: 'accept', sessionId, permissions: PERMS });
    await vws.next('session_started');
    hws.close();
    expect((await vws.next('peer_status')).online).toBe(false);
    expect(await vws.next('session_ended', () => true, 3000)).toEqual({ type: 'session_ended', sessionId, reason: 'peer_lost' });
    await sleep(100);
    const h = await api(srv.base, 'GET', '/api/v1/sessions', undefined, host.token);
    expect(h.body.sessions[0]).toMatchObject({ id: sessionId, status: 'ended', endReason: 'peer_lost' });
  });

  it('viewer offline durante pendência cancela a solicitação', async () => {
    const { host, vws, hws } = await pair();
    const { sessionId } = await request(vws, hws, host.deviceId);
    vws.close();
    expect(await hws.next('session_ended')).toEqual({ type: 'session_ended', sessionId, reason: 'cancelled' });
  });

  it('ping/pong e JSON inválido', async () => {
    const c = await online(await newDevice(srv.base));
    c.send({ type: 'ping', ts: 123 });
    const p = await c.next('pong');
    expect(p.ts).toBe(123);
    expect(typeof p.serverTime).toBe('number');
    c.ws.send('{oops');
    expect((await c.next('error')).code).toBe('BAD_REQUEST');
  });
});

describe('limite de tamanho de mensagem', () => {
  it('mensagem acima de 64 KiB derruba o socket (1009)', async () => {
    const c = await online(await newDevice(srv.base));
    c.send({ type: 'ping', pad: 'x'.repeat(70 * 1024) });
    expect(await c.closed()).toBe(1009);
  });
});
