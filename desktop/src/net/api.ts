import { authSigningMessage, type AuditRow, type IceServer, type SessionRow } from './protocol';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface UserInfo {
  id: string;
  email: string;
  displayName: string;
}

export interface AccountDevice {
  deviceId: string;
  name: string;
  os: string;
  fingerprint: string;
  online: boolean;
  lastSeenAt: string | null;
}

type AuthKind = 'none' | 'device' | 'user';

function parseExpiry(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return Date.now() + 10 * 60_000;
}

export class Api {
  private token: string | null = null;
  private tokenExp = 0;
  private authInFlight: Promise<string> | null = null;
  deviceId: string | null = null;
  userToken: string | null = null;

  constructor(
    private getBase: () => string,
    private signer: (message: string) => Promise<string>,
  ) {}

  get base(): string {
    return this.getBase().replace(/\/+$/, '');
  }

  resetAuth(): void {
    this.token = null;
    this.tokenExp = 0;
  }

  private async raw<T>(method: string, path: string, body: unknown, bearer: string | null): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK', e instanceof Error ? e.message : 'network error');
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new ApiError(res.status, data?.error ?? `HTTP_${res.status}`, data?.message ?? res.statusText);
    }
    return data as T;
  }

  async request<T>(method: string, path: string, body?: unknown, auth: AuthKind = 'device'): Promise<T> {
    if (auth === 'none') return this.raw<T>(method, `/api/v1${path}`, body, null);
    if (auth === 'user') {
      if (!this.userToken) throw new ApiError(401, 'NO_USER', 'not logged in');
      return this.raw<T>(method, `/api/v1${path}`, body, this.userToken);
    }
    const token = await this.deviceToken();
    try {
      return await this.raw<T>(method, `/api/v1${path}`, body, token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        this.resetAuth();
        const fresh = await this.deviceToken();
        return this.raw<T>(method, `/api/v1${path}`, body, fresh);
      }
      throw e;
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.raw('GET', '/healthz', undefined, null);
      return true;
    } catch {
      return false;
    }
  }

  async register(publicKey: string, name: string, os: string, appVersion: string) {
    const r = await this.request<{ deviceId: string; fingerprint: string }>(
      'POST',
      '/devices/register',
      { publicKey, name, os, appVersion },
      'none',
    );
    this.deviceId = r.deviceId;
    return r;
  }

  /** Returns a valid device JWT, performing challenge/response when needed. */
  async deviceToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    if (!this.deviceId) throw new ApiError(0, 'NOT_REGISTERED', 'device not registered');
    this.authInFlight ??= (async () => {
      try {
        const deviceId = this.deviceId!;
        const ch = await this.raw<{ challengeId: string; nonce: string }>(
          'POST',
          '/api/v1/auth/device/challenge',
          { deviceId },
          null,
        );
        const signature = await this.signer(authSigningMessage(ch.nonce, deviceId));
        const tok = await this.raw<{ token: string; expiresAt: string | number }>(
          'POST',
          '/api/v1/auth/device/token',
          { challengeId: ch.challengeId, deviceId, signature },
          null,
        );
        this.token = tok.token;
        this.tokenExp = parseExpiry(tok.expiresAt);
        this.scheduleRefresh();
        return tok.token;
      } finally {
        this.authInFlight = null;
      }
    })();
    return this.authInFlight;
  }

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Renew the device token ~5 min before it expires so REST calls never block on auth. */
  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(30_000, this.tokenExp - Date.now() - 5 * 60_000);
    this.refreshTimer = setTimeout(() => {
      this.token = null;
      this.deviceToken().catch(() => {});
    }, Math.min(delay, 2 ** 31 - 1));
  }

  tokenExpiresAt(): number {
    return this.tokenExp;
  }

  updateMe(patch: { name?: string; appVersion?: string; os?: string }) {
    return this.request<{ ok: true }>('PATCH', '/devices/me', patch);
  }

  ice() {
    return this.request<{ iceServers: IceServer[]; ttl: number }>('GET', '/ice');
  }

  sessions(limit = 50) {
    return this.request<{ sessions: SessionRow[] }>('GET', `/sessions?limit=${limit}`);
  }

  audit(limit = 100) {
    return this.request<{ events: AuditRow[] }>('GET', `/audit?limit=${limit}`);
  }

  devicePublic(id: string) {
    return this.request<{ deviceId: string; name: string; os: string; fingerprint: string; publicKey: string; online: boolean }>(
      'GET',
      `/devices/${encodeURIComponent(id)}/public`,
    );
  }

  async login(email: string, password: string) {
    const r = await this.request<{ user: UserInfo; token: string }>('POST', '/auth/login', { email, password }, 'none');
    this.userToken = r.token;
    return r;
  }

  async registerUser(email: string, password: string, displayName: string) {
    const r = await this.request<{ user: UserInfo; token: string }>(
      'POST',
      '/auth/register',
      { email, password, displayName },
      'none',
    );
    this.userToken = r.token;
    return r;
  }

  me() {
    return this.request<{ user: UserInfo }>('GET', '/me', undefined, 'user');
  }

  linkDevice() {
    return this.request<{ ok: true }>('POST', '/account/devices/link', { userToken: this.userToken });
  }

  accountDevices() {
    return this.request<{ devices: AccountDevice[] }>('GET', '/account/devices', undefined, 'user');
  }

  unlinkDevice(id: string) {
    return this.request<{ ok: true }>('DELETE', `/account/devices/${encodeURIComponent(id)}`, undefined, 'user');
  }
}
