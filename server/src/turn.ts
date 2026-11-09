import type { Config } from './config.js';
import { hmacSha1B64 } from './crypto.js';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Credenciais efêmeras no esquema REST do coturn (`use-auth-secret`). */
export function iceServersFor(cfg: Config, deviceId: string, now = Date.now()): { iceServers: IceServer[]; ttl: number } {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length && cfg.turnSecret) {
    const expiry = Math.floor(now / 1000) + cfg.turnTtlSec;
    const username = `${expiry}:${deviceId}`;
    servers.push({ urls: cfg.turnUrls, username, credential: hmacSha1B64(cfg.turnSecret, username) });
  }
  return { iceServers: servers, ttl: cfg.turnTtlSec };
}
