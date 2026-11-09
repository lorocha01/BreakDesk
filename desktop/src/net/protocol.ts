// Types mirroring docs/PROTOCOL.md. Keep in sync with the spec.

export type Mode = 'attended' | 'unattended';
export type Role = 'viewer' | 'host';

export interface Permissions {
  input: boolean;
  files: boolean;
  chat: boolean;
}

export interface PeerInfo {
  deviceId: string;
  name: string;
  os: string;
  fingerprint: string;
  publicKey: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionStartedPayload {
  sessionId: string;
  role: Role;
  mode: Mode;
  peer: PeerInfo;
  permissions: Permissions;
  iceServers: IceServer[];
  resumed?: boolean;
}

export interface IceCandidateJson {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type SignalData =
  | { kind: 'ready' }
  | { kind: 'offer'; sdp: string; sig: string; restart?: boolean }
  | { kind: 'answer'; sdp: string; sig: string }
  | { kind: 'ice'; candidate: IceCandidateJson }
  | { kind: 'restart_request' };

export type ErrorCode =
  | 'NOT_FOUND'
  | 'TARGET_OFFLINE'
  | 'SELF'
  | 'RATE_LIMITED'
  | 'BUSY'
  | 'BAD_REQUEST'
  | 'FORBIDDEN';

export type ServerMessage =
  | { type: 'welcome'; deviceId: string; serverTime: string | number }
  | { type: 'active_sessions'; sessions: SessionStartedPayload[] }
  | { type: 'pong'; ts: number; serverTime?: string | number }
  | {
      type: 'connect_pending';
      reqId: string;
      sessionId: string;
      target: { deviceId: string; name: string; os: string; fingerprint: string };
    }
  | { type: 'error'; reqId?: string; sessionId?: string; code: ErrorCode | string; message: string }
  | { type: 'incoming'; sessionId: string; mode: Mode; viewer: PeerInfo }
  | ({ type: 'session_started' } & SessionStartedPayload)
  | { type: 'signal'; sessionId: string; from: string; data: SignalData }
  | { type: 'peer_status'; sessionId: string; online: boolean }
  | { type: 'session_ended'; sessionId: string; reason: string };

export type ClientMessage =
  | { type: 'ping'; ts: number }
  | { type: 'connect'; reqId: string; targetId: string; mode: Mode; viewerName: string }
  | { type: 'cancel'; sessionId: string }
  | { type: 'accept'; sessionId: string; permissions: Permissions }
  | { type: 'reject'; sessionId: string; reason?: string }
  | { type: 'signal'; sessionId: string; data: SignalData }
  | { type: 'end'; sessionId: string; reason?: string }
  | { type: 'audit'; sessionId?: string; event: string; detail?: unknown };

export interface Monitor {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

export type QualityPreset = 'auto' | 'quality' | 'balanced' | 'speed';

// Control channel
export type ViewerControlMsg =
  | { t: 'auth'; password: string }
  | { t: 'mm'; x: number; y: number }
  | { t: 'md'; b: number }
  | { t: 'mu'; b: number }
  | { t: 'wh'; dx: number; dy: number }
  | { t: 'kd'; code: string; key: string }
  | { t: 'ku'; code: string; key: string }
  | { t: 'combo'; codes: string[] }
  | { t: 'text'; text: string }
  | { t: 'monitor'; index: number }
  | { t: 'quality'; preset: QualityPreset; fps: number }
  | { t: 'viewport'; w: number; h: number }
  | { t: 'keyframe' }
  | { t: 'ping'; id: number; ts: number }
  | { t: 'chat'; id: string; text: string; ts: number };

export type HostControlMsg =
  | { t: 'auth_required' }
  | { t: 'auth_result'; ok: boolean; reason?: string; attemptsLeft?: number }
  | {
      t: 'hello';
      hostName: string;
      os: string;
      monitors: Monitor[];
      current: number;
      permissions: Permissions;
    }
  | { t: 'monitor_changed'; index: number; width: number; height: number }
  | { t: 'stats'; fps: number; encodeMs: number; bitrateKbps: number; width: number; height: number }
  | { t: 'pong'; id: number; ts: number }
  | { t: 'chat'; id: string; text: string; ts: number }
  | { t: 'perm'; permissions: Permissions }
  | { t: 'bye'; reason: string };

// Files channel
export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string | number | null;
}

export type FilesMsg =
  | { op: 'ls'; reqId: string; path: string }
  | { op: 'ls_result'; reqId: string; path: string; parent: string | null; entries: RemoteEntry[] }
  | { op: 'error'; reqId?: string; id?: number; message: string }
  | { op: 'put'; id: number; name: string; relPath: string; size: number; dest?: string }
  | { op: 'put_ok'; id: number }
  | { op: 'put_err'; id: number; message: string }
  | { op: 'put_end'; id: number }
  | { op: 'done'; id: number; path?: string }
  | { op: 'get'; id: number; path: string }
  | { op: 'get_meta'; id: number; files: { fileIndex: number; relPath: string; size: number }[]; totalSize: number }
  | { op: 'file_end'; id: number; fileIndex: number }
  | { op: 'cancel'; id: number };

export interface Settings {
  serverUrl: string;
  deviceName: string;
  theme: 'system' | 'light' | 'dark';
  launchOnStartup: boolean;
  quality: QualityPreset;
  fps: number;
  audioEnabled: boolean;
  defaultPermissions: Permissions;
  unattended: { enabled: boolean; hasPassword: boolean; allowedDeviceIds: string[] };
  receiveDir: string;
  autoUpdate: boolean;
  trustedKeys: Record<string, TrustedKey>;
}

export interface TrustedKey {
  publicKey: string;
  fingerprint: string;
  name?: string;
  firstSeen?: string;
}

export interface SessionRow {
  id: string;
  viewerId: string;
  hostId: string;
  viewerName: string | null;
  hostName: string | null;
  mode: Mode;
  status: 'pending' | 'active' | 'rejected' | 'cancelled' | 'timeout' | 'ended';
  role: Role;
  createdAt: string;
  acceptedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  endReason: string | null;
}

export interface AuditRow {
  id: string | number;
  at: string;
  event: string;
  actorDevice: string | null;
  sessionId: string | null;
  ip: string | null;
  detail: unknown;
}

export interface LocalAuditRow {
  at: string;
  event: string;
  sessionId?: string | null;
  peerId?: string | null;
  detail?: unknown;
}

export const DEFAULT_SERVER_URL: string =
  (import.meta.env.VITE_NEXO_SERVER as string | undefined) || 'http://localhost:8080';

export function defaultSettings(): Settings {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    deviceName: '',
    theme: 'system',
    launchOnStartup: false,
    quality: 'auto',
    fps: 30,
    audioEnabled: false,
    defaultPermissions: { input: true, files: true, chat: true },
    unattended: { enabled: false, hasPassword: false, allowedDeviceIds: [] },
    receiveDir: '',
    autoUpdate: true,
    trustedKeys: {},
  };
}

export function sdpSigningMessage(sessionId: string, kind: 'offer' | 'answer', sdp: string): string {
  return `nexo-sdp-v1:${sessionId}:${kind}:${sdp}`;
}

export function authSigningMessage(nonce: string, deviceId: string): string {
  return `nexo-auth-v1:${nonce}:${deviceId}`;
}
