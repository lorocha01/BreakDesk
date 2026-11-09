import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireAuth } from '../context.js';
import { fingerprint, newDeviceId, parsePublicKey, randomB64, verifyEd25519 } from '../crypto.js';
import { HttpError } from '../errors.js';
import { SlidingWindowLimiter } from '../ratelimit.js';
import { iceServersFor } from '../turn.js';

const RegisterBody = z.object({
  publicKey: z.string().min(40).max(64),
  name: z.string().trim().max(80).default(''),
  os: z.string().trim().max(80).default(''),
  appVersion: z.string().trim().max(40).default(''),
});
const DeviceId = z.string().regex(/^[1-9][0-9]{8}$/, 'deviceId inválido');
const ChallengeBody = z.object({ deviceId: DeviceId });
const TokenBody = z.object({ challengeId: z.string().min(10).max(80), deviceId: DeviceId, signature: z.string().min(80).max(100) });
const PatchBody = z
  .object({ name: z.string().trim().max(80), appVersion: z.string().trim().max(40), os: z.string().trim().max(80) })
  .partial();
const Limit = (def: number, max: number) => z.object({ limit: z.coerce.number().int().min(1).max(max).default(def) });

const CHALLENGE_TTL_MS = 60_000;

interface Challenge {
  deviceId: string;
  nonce: string;
  expires: number;
}

export async function deviceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, cfg, audit, tokens, hub } = ctx;
  const registerLimiter = new SlidingWindowLimiter(cfg.registerPerHour, 3600_000);
  const challengeLimiter = new SlidingWindowLimiter(60, 60_000);
  const challenges = new Map<string, Challenge>();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, c] of challenges) if (c.expires < now) challenges.delete(k);
  }, 30_000);
  sweeper.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    registerLimiter.close();
    challengeLimiter.close();
  });

  app.post('/devices/register', async (req) => {
    const body = RegisterBody.parse(req.body);
    const pub = parsePublicKey(body.publicKey);
    if (!pub) throw new HttpError(400, 'BAD_REQUEST', 'publicKey deve ser uma chave Ed25519 de 32 bytes em base64.');
    if (!registerLimiter.take(req.ip)) {
      throw new HttpError(429, 'RATE_LIMITED', 'Muitos registros a partir deste endereço.', {
        'retry-after': String(registerLimiter.retryAfterSec(req.ip)),
      });
    }
    const fp = fingerprint(pub);
    const existing = await db.query<{ id: string }>(
      'UPDATE devices SET name=$2, os=$3, app_version=$4 WHERE public_key=$1 RETURNING id',
      [pub, body.name, body.os, body.appVersion],
    );
    if (existing.rows[0]) return { deviceId: existing.rows[0].id, fingerprint: fp };

    for (let attempt = 0; attempt < 8; attempt++) {
      const id = newDeviceId();
      const r = await db.query<{ id: string }>(
        `INSERT INTO devices (id, public_key, fingerprint, name, os, app_version) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, pub, fp, body.name, body.os, body.appVersion],
      );
      if (r.rows[0]) {
        await audit.write({ event: 'device_registered', actorDevice: id, ip: req.ip, detail: { name: body.name, os: body.os, fingerprint: fp } });
        return { deviceId: id, fingerprint: fp };
      }
      // Conflito: pode ter sido a mesma chave registrada em paralelo.
      const again = await db.query<{ id: string }>('SELECT id FROM devices WHERE public_key=$1', [pub]);
      if (again.rows[0]) return { deviceId: again.rows[0].id, fingerprint: fp };
    }
    throw new HttpError(503, 'UNAVAILABLE', 'Não foi possível alocar um ID. Tente novamente.');
  });

  app.post('/auth/device/challenge', async (req) => {
    const { deviceId } = ChallengeBody.parse(req.body);
    if (!challengeLimiter.take(req.ip)) throw new HttpError(429, 'RATE_LIMITED', 'Muitas solicitações de desafio.');
    const r = await db.query('SELECT 1 FROM devices WHERE id=$1', [deviceId]);
    if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Dispositivo não registrado.');
    const challengeId = randomB64(18).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
    const nonce = randomB64(32);
    challenges.set(challengeId, { deviceId, nonce, expires: Date.now() + CHALLENGE_TTL_MS });
    return { challengeId, nonce };
  });

  app.post('/auth/device/token', async (req) => {
    const body = TokenBody.parse(req.body);
    const ch = challenges.get(body.challengeId);
    challenges.delete(body.challengeId); // uso único, mesmo em falha
    if (!ch || ch.expires < Date.now() || ch.deviceId !== body.deviceId) {
      throw new HttpError(401, 'INVALID_CHALLENGE', 'Desafio inválido ou expirado.');
    }
    const r = await db.query<{ public_key: Buffer }>('SELECT public_key FROM devices WHERE id=$1', [body.deviceId]);
    const pub = r.rows[0]?.public_key;
    if (!pub || !verifyEd25519(pub, `nexo-auth-v1:${ch.nonce}:${body.deviceId}`, body.signature)) {
      await audit.write({ event: 'device_auth_failed', actorDevice: body.deviceId, ip: req.ip });
      throw new HttpError(401, 'INVALID_SIGNATURE', 'Assinatura inválida.');
    }
    await db.query('UPDATE devices SET last_seen_at=now() WHERE id=$1', [body.deviceId]);
    await audit.write({ event: 'device_auth', actorDevice: body.deviceId, ip: req.ip });
    return tokens.issue('device', body.deviceId);
  });

  app.patch('/devices/me', async (req) => {
    const deviceId = await requireAuth(ctx, req, 'device');
    const body = PatchBody.parse(req.body ?? {});
    await db.query(
      `UPDATE devices SET name=COALESCE($2,name), app_version=COALESCE($3,app_version), os=COALESCE($4,os) WHERE id=$1`,
      [deviceId, body.name ?? null, body.appVersion ?? null, body.os ?? null],
    );
    return { ok: true };
  });

  app.get('/devices/:id/public', async (req) => {
    await requireAuth(ctx, req, 'device');
    const { id } = z.object({ id: DeviceId }).parse(req.params);
    const r = await db.query<{ id: string; name: string; os: string; fingerprint: string; public_key: Buffer }>(
      'SELECT id, name, os, fingerprint, public_key FROM devices WHERE id=$1',
      [id],
    );
    const d = r.rows[0];
    if (!d) throw new HttpError(404, 'NOT_FOUND', 'Dispositivo não encontrado.');
    return { deviceId: d.id, name: d.name, os: d.os, fingerprint: d.fingerprint, publicKey: d.public_key.toString('base64'), online: hub.isOnline(d.id) };
  });

  app.get('/ice', async (req) => {
    const deviceId = await requireAuth(ctx, req, 'device');
    return iceServersFor(cfg, deviceId);
  });

  app.get('/sessions', async (req) => {
    const deviceId = await requireAuth(ctx, req, 'device');
    const { limit } = Limit(50, 200).parse(req.query);
    const r = await db.query(
      `SELECT id, viewer_id, host_id, viewer_name, host_name, mode, status, created_at, accepted_at, ended_at, duration_sec, end_reason
         FROM sessions WHERE viewer_id=$1 OR host_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [deviceId, limit],
    );
    return {
      sessions: r.rows.map((s) => ({
        id: s.id,
        viewerId: s.viewer_id,
        hostId: s.host_id,
        viewerName: s.viewer_name,
        hostName: s.host_name,
        mode: s.mode,
        status: s.status,
        role: s.viewer_id === deviceId ? 'viewer' : 'host',
        createdAt: s.created_at,
        acceptedAt: s.accepted_at,
        endedAt: s.ended_at,
        durationSec: s.duration_sec,
        endReason: s.end_reason,
      })),
    };
  });

  app.get('/audit', async (req) => {
    const deviceId = await requireAuth(ctx, req, 'device');
    const { limit } = Limit(100, 500).parse(req.query);
    const r = await db.query(
      `SELECT id, at, event, actor_device, subject_device, session_id, ip, detail
         FROM audit_log WHERE actor_device=$1 OR subject_device=$1 ORDER BY at DESC, id DESC LIMIT $2`,
      [deviceId, limit],
    );
    return {
      events: r.rows.map((e) => ({
        id: Number(e.id),
        at: e.at,
        event: e.event,
        actorDevice: e.actor_device,
        subjectDevice: e.subject_device,
        sessionId: e.session_id,
        ip: e.ip,
        detail: e.detail,
      })),
    };
  });
}
