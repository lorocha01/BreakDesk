import { z } from 'zod';

const list = (v: string | undefined, def: string[]): string[] =>
  v === undefined || v.trim() === '' ? def : v.split(',').map((s) => s.trim()).filter(Boolean);

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  turnSecret: string;
  turnUrls: string[];
  stunUrls: string[];
  turnTtlSec: number;
  corsOrigins: string[];
  trustProxy: boolean | string;
  /** Tempos do hub de sinalização (configuráveis para testes). */
  pendingTimeoutMs: number;
  peerGraceMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  /** Limites */
  connectPerMinute: number;
  maxPendingPerHost: number;
  registerPerHour: number;
  loginMaxFailures: number;
  loginWindowMs: number;
  maxMessageBytes: number;
  logLevel: string;
}

const DEFAULT_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://localhost:5173',
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const nodeEnv = z.enum(['development', 'production', 'test']).catch('development').parse(env.NODE_ENV);
  let jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) {
    if (nodeEnv === 'production') {
      throw new Error('JWT_SECRET ausente ou curto (mínimo 32 caracteres) em produção.');
    }
    jwtSecret = jwtSecret || 'dev-only-insecure-jwt-secret-change-me-0123456789';
  }
  const tp = env.TRUST_PROXY;
  const cfg: Config = {
    env: nodeEnv,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? 'postgres://nexo@127.0.0.1:5433/nexo',
    jwtSecret,
    turnSecret: env.TURN_SECRET ?? '',
    turnUrls: list(env.TURN_URLS, []),
    stunUrls: list(env.STUN_URLS, ['stun:stun.l.google.com:19302']),
    turnTtlSec: Number(env.TURN_TTL_SEC ?? 6 * 3600),
    corsOrigins: list(env.CORS_ORIGINS, DEFAULT_ORIGINS),
    trustProxy: tp === undefined || tp === '' ? false : tp === 'true' ? true : tp === 'false' ? false : tp,
    pendingTimeoutMs: 60_000,
    peerGraceMs: 45_000,
    heartbeatIntervalMs: 25_000,
    heartbeatTimeoutMs: 60_000,
    connectPerMinute: 10,
    maxPendingPerHost: 3,
    registerPerHour: Number(env.REGISTER_PER_HOUR ?? 20),
    loginMaxFailures: 5,
    loginWindowMs: 15 * 60_000,
    maxMessageBytes: 64 * 1024,
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    ...overrides,
  };
  if (cfg.env === 'production' && cfg.turnUrls.length > 0 && cfg.turnSecret.length < 16) {
    throw new Error('TURN_SECRET ausente ou curto (mínimo 16 caracteres) com TURN_URLS definido.');
  }
  return cfg;
}
