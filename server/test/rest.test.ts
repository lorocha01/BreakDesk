import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, newDevice, newKeyPair, startServer, type TestServer } from './helpers.js';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => {
  await srv.close();
});

describe('saúde e cabeçalhos', () => {
  it('GET /healthz', async () => {
    const r = await api(srv.base, 'GET', '/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });

  it('CORS permite origem do Tauri e recusa desconhecida', async () => {
    const ok = await fetch(`${srv.base}/healthz`, { headers: { origin: 'tauri://localhost' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    const bad = await fetch(`${srv.base}/healthz`, { headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('identidade do dispositivo', () => {
  it('registro é idempotente por chave pública e gera ID de 9 dígitos + fingerprint', async () => {
    const kp = newKeyPair();
    const a = await api(srv.base, 'POST', '/api/v1/devices/register', { publicKey: kp.publicKey, name: 'A', os: 'Windows', appVersion: '1' });
    expect(a.status).toBe(200);
    expect(a.body.deviceId).toMatch(/^[1-9]\d{8}$/);
    expect(a.body.fingerprint).toMatch(/^([0-9A-F]{4}:){7}[0-9A-F]{4}$/);
    const b = await api(srv.base, 'POST', '/api/v1/devices/register', { publicKey: kp.publicKey, name: 'A2', os: 'Windows', appVersion: '2' });
    expect(b.body).toEqual(a.body);
  });

  it('rejeita chave pública inválida', async () => {
    const r = await api(srv.base, 'POST', '/api/v1/devices/register', { publicKey: Buffer.alloc(31).toString('base64') + 'AAAAAAAA', name: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_REQUEST');
  });

  it('desafio/resposta: assinatura válida emite token; inválida e reutilizada falham', async () => {
    const kp = newKeyPair();
    const { body: reg } = await api(srv.base, 'POST', '/api/v1/devices/register', { publicKey: kp.publicKey, name: 'B' });

    const ch1 = await api(srv.base, 'POST', '/api/v1/auth/device/challenge', { deviceId: reg.deviceId });
    expect(ch1.status).toBe(200);
    const bad = await api(srv.base, 'POST', '/api/v1/auth/device/token', {
      challengeId: ch1.body.challengeId,
      deviceId: reg.deviceId,
      signature: newKeyPair().sign(`nexo-auth-v1:${ch1.body.nonce}:${reg.deviceId}`),
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('INVALID_SIGNATURE');

    const ch2 = await api(srv.base, 'POST', '/api/v1/auth/device/challenge', { deviceId: reg.deviceId });
    const sig = kp.sign(`nexo-auth-v1:${ch2.body.nonce}:${reg.deviceId}`);
    const ok = await api(srv.base, 'POST', '/api/v1/auth/device/token', { challengeId: ch2.body.challengeId, deviceId: reg.deviceId, signature: sig });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');
    expect(new Date(ok.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);

    const reused = await api(srv.base, 'POST', '/api/v1/auth/device/token', { challengeId: ch2.body.challengeId, deviceId: reg.deviceId, signature: sig });
    expect(reused.status).toBe(401);
    expect(reused.body.error).toBe('INVALID_CHALLENGE');
  });

  it('desafio para dispositivo inexistente → 404', async () => {
    const r = await api(srv.base, 'POST', '/api/v1/auth/device/challenge', { deviceId: '100000000' });
    expect(r.status).toBe(404);
  });

  it('PATCH /devices/me, GET /devices/:id/public e recusa de token ausente', async () => {
    const d = await newDevice(srv.base, 'Original');
    expect((await api(srv.base, 'PATCH', '/api/v1/devices/me', { name: 'Renomeado' })).status).toBe(401);
    expect((await api(srv.base, 'PATCH', '/api/v1/devices/me', { name: 'Renomeado' }, d.token)).status).toBe(200);
    const other = await newDevice(srv.base);
    const p = await api(srv.base, 'GET', `/api/v1/devices/${d.deviceId}/public`, undefined, other.token);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ deviceId: d.deviceId, name: 'Renomeado', publicKey: d.publicKey, fingerprint: d.fingerprint, online: false });
  });

  it('GET /ice gera credenciais TURN efêmeras no formato do coturn', async () => {
    const d = await newDevice(srv.base);
    const r = await api(srv.base, 'GET', '/api/v1/ice', undefined, d.token);
    expect(r.status).toBe(200);
    expect(r.body.ttl).toBe(6 * 3600);
    const turn = r.body.iceServers.find((s: any) => s.username);
    expect(r.body.iceServers[0].urls).toEqual(['stun:stun.l.google.com:19302']);
    const [exp, id] = turn.username.split(':');
    expect(id).toBe(d.deviceId);
    expect(Number(exp)).toBeGreaterThan(Date.now() / 1000 + 5 * 3600);
    expect(turn.credential).toBe(createHmac('sha1', 'test-turn-secret-0123456789').update(turn.username).digest('base64'));
  });
});

describe('contas de usuário', () => {
  const email = `ana.${Date.now()}@exemplo.com`;
  let userToken = '';

  it('cadastro, duplicidade e validação de senha', async () => {
    const r = await api(srv.base, 'POST', '/api/v1/auth/register', { email: email.toUpperCase(), password: 'senha-forte-123', displayName: 'Ana' });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe(email);
    userToken = r.body.token;
    const dup = await api(srv.base, 'POST', '/api/v1/auth/register', { email, password: 'outra-senha-123', displayName: 'Ana' });
    expect(dup.status).toBe(409);
    const weak = await api(srv.base, 'POST', '/api/v1/auth/register', { email: `x${email}`, password: 'curta', displayName: 'X' });
    expect(weak.status).toBe(400);
  });

  it('login, /me e confusão de tipo de token', async () => {
    const r = await api(srv.base, 'POST', '/api/v1/auth/login', { email, password: 'senha-forte-123' });
    expect(r.status).toBe(200);
    const me = await api(srv.base, 'GET', '/api/v1/me', undefined, r.body.token);
    expect(me.body.user.displayName).toBe('Ana');
    const d = await newDevice(srv.base);
    expect((await api(srv.base, 'GET', '/api/v1/me', undefined, d.token)).status).toBe(401);
    expect((await api(srv.base, 'GET', '/api/v1/ice', undefined, r.body.token)).status).toBe(401);
  });

  it('vincular, listar e desvincular dispositivos da conta', async () => {
    const d = await newDevice(srv.base, 'Notebook');
    expect((await api(srv.base, 'POST', '/api/v1/account/devices/link', { userToken }, d.token)).status).toBe(200);
    const list = await api(srv.base, 'GET', '/api/v1/account/devices', undefined, userToken);
    expect(list.body.devices.map((x: any) => x.deviceId)).toContain(d.deviceId);
    expect((await api(srv.base, 'DELETE', `/api/v1/account/devices/${d.deviceId}`, undefined, userToken)).status).toBe(200);
    expect((await api(srv.base, 'DELETE', `/api/v1/account/devices/${d.deviceId}`, undefined, userToken)).status).toBe(404);
  });

  it('bloqueia após 5 falhas de login (mesmo com a senha correta depois)', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await api(srv.base, 'POST', '/api/v1/auth/login', { email, password: `errada-${i}-xxxxx` });
      expect(r.status).toBe(401);
    }
    const locked = await api(srv.base, 'POST', '/api/v1/auth/login', { email, password: 'senha-forte-123' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('limite de registro por IP', () => {
  it('retorna 429 após o limite', async () => {
    const s = await startServer({ registerPerHour: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push((await api(s.base, 'POST', '/api/v1/devices/register', { publicKey: newKeyPair().publicKey, name: 'x' })).status);
      }
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await s.close();
    }
  });
});
