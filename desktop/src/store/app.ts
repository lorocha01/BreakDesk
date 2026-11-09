import { create } from 'zustand';
import type { SignalingState } from '../net/signaling';
import {
  defaultSettings,
  type Mode,
  type Monitor,
  type PeerInfo,
  type Permissions,
  type QualityPreset,
  type Settings,
} from '../net/protocol';
import { uid } from '../lib/format';

export type View = 'home' | 'history' | 'settings';
export type NoticeKind = 'info' | 'success' | 'warning' | 'error';

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  body?: string;
  ts: number;
  read: boolean;
}

export interface Toast {
  id: string;
  kind: NoticeKind;
  title: string;
  body?: string;
}

export interface RecentDevice {
  deviceId: string;
  name: string;
  os?: string;
  alias?: string;
  favorite?: boolean;
  lastAt: number;
}

export interface Transfer {
  id: string;
  direction: 'upload' | 'download';
  name: string;
  bytes: number;
  total: number;
  state: 'pending' | 'active' | 'done' | 'cancelled' | 'error';
  message?: string;
  startedAt: number;
  speed: number;
  path?: string;
  files?: number;
}

export interface ChatMsg {
  id: string;
  from: 'me' | 'peer';
  text: string;
  ts: number;
}

export interface Stats {
  rttMs: number | null;
  pingMs: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  route: 'p2p' | 'relay' | null;
  packetLoss: number | null;
  level: 0 | 1 | 2 | 3 | 4;
  hostFps: number | null;
  encodeMs: number | null;
}

export const emptyStats: Stats = {
  rttMs: null,
  pingMs: null,
  fps: null,
  bitrateKbps: null,
  width: null,
  height: null,
  route: null,
  packetLoss: null,
  level: 0,
  hostFps: null,
  encodeMs: null,
};

export type ViewerStatus = 'connecting' | 'auth' | 'streaming' | 'reconnecting' | 'ended';

export interface ViewerState {
  sessionId: string;
  peer: PeerInfo;
  mode: Mode;
  status: ViewerStatus;
  monitors: Monitor[];
  currentMonitor: number;
  permissions: Permissions;
  stats: Stats;
  chat: ChatMsg[];
  unread: number;
  transfers: Transfer[];
  startedAt: number;
  authError: string | null;
  authBusy: boolean;
  peerOffline: boolean;
  endReason: string | null;
  quality: QualityPreset;
  fps: number;
  stream: MediaStream | null;
  hostName: string | null;
}

export interface OutgoingState {
  reqId: string;
  targetId: string;
  mode: Mode;
  sessionId: string | null;
  targetName: string | null;
  status: 'sending' | 'pending' | 'rejected' | 'timeout' | 'error';
  error: string | null;
}

export type HostRunState = 'connecting' | 'awaiting_auth' | 'streaming' | 'reconnecting' | 'closed';

export interface HostState {
  sessionId: string;
  peer: PeerInfo;
  mode: Mode;
  permissions: Permissions;
  state: HostRunState;
  startedAt: number;
  chat: ChatMsg[];
  unread: number;
  transfers: Transfer[];
}

export interface IncomingRequest {
  sessionId: string;
  mode: Mode;
  viewer: PeerInfo;
  receivedAt: number;
  known: boolean;
}

export interface SecurityAlert {
  deviceId: string;
  expected: string;
  got: string;
}

export interface AppState {
  booted: boolean;
  view: View;
  identity: { publicKey: string; fingerprint: string } | null;
  deviceId: string | null;
  settings: Settings;
  conn: SignalingState;
  latency: number | null;
  serverError: string | null;
  notifications: Notice[];
  toasts: Toast[];
  recents: RecentDevice[];
  outgoing: OutgoingState | null;
  viewer: ViewerState | null;
  host: HostState | null;
  incoming: IncomingRequest[];
  securityAlert: SecurityAlert | null;
  pendingPassword: string | null;
}

const RECENTS_KEY = 'nexo.recents.v1';

function loadRecents(): RecentDevice[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as RecentDevice[]) : [];
  } catch {
    return [];
  }
}

export const useApp = create<AppState>(() => ({
  booted: false,
  view: 'home',
  identity: null,
  deviceId: null,
  settings: defaultSettings(),
  conn: 'offline',
  latency: null,
  serverError: null,
  notifications: [],
  toasts: [],
  recents: loadRecents(),
  outgoing: null,
  viewer: null,
  host: null,
  incoming: [],
  securityAlert: null,
  pendingPassword: null,
}));

export const setApp = useApp.setState;
export const getApp = useApp.getState;

export function patchViewer(patch: Partial<ViewerState> | ((v: ViewerState) => Partial<ViewerState>)): void {
  setApp((s) => {
    if (!s.viewer) return {};
    const p = typeof patch === 'function' ? patch(s.viewer) : patch;
    return { viewer: { ...s.viewer, ...p } };
  });
}

export function patchHost(patch: Partial<HostState> | ((h: HostState) => Partial<HostState>)): void {
  setApp((s) => {
    if (!s.host) return {};
    const p = typeof patch === 'function' ? patch(s.host) : patch;
    return { host: { ...s.host, ...p } };
  });
}

export function upsertTransfer(list: Transfer[], tr: Partial<Transfer> & { id: string }): Transfer[] {
  const idx = list.findIndex((x) => x.id === tr.id);
  if (idx === -1) {
    const fresh: Transfer = {
      direction: 'upload',
      name: '',
      bytes: 0,
      total: 0,
      state: 'active',
      startedAt: Date.now(),
      speed: 0,
      ...tr,
    };
    return [fresh, ...list];
  }
  const next = list.slice();
  next[idx] = { ...next[idx], ...tr };
  return next;
}

export function notify(kind: NoticeKind, title: string, body?: string, opts: { toast?: boolean } = {}): void {
  const id = uid();
  setApp((s) => ({
    notifications: [{ id, kind, title, body, ts: Date.now(), read: false }, ...s.notifications].slice(0, 100),
    toasts: opts.toast === false ? s.toasts : [...s.toasts, { id, kind, title, body }].slice(-4),
  }));
  if (opts.toast !== false) setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4500);
}

export function toast(kind: NoticeKind, title: string, body?: string): void {
  const id = uid();
  setApp((s) => ({ toasts: [...s.toasts, { id, kind, title, body }].slice(-4) }));
  setTimeout(() => dismissToast(id), 3500);
}

export function dismissToast(id: string): void {
  setApp((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

export function rememberRecent(dev: { deviceId: string; name?: string | null; os?: string | null }): void {
  setApp((s) => {
    const existing = s.recents.find((r) => r.deviceId === dev.deviceId);
    const updated: RecentDevice = {
      ...(existing ?? { deviceId: dev.deviceId, name: '' }),
      name: dev.name || existing?.name || '',
      os: dev.os || existing?.os,
      lastAt: Date.now(),
    };
    const recents = [updated, ...s.recents.filter((r) => r.deviceId !== dev.deviceId)].slice(0, 30);
    saveRecents(recents);
    return { recents };
  });
}

export function updateRecent(deviceId: string, patch: Partial<RecentDevice>): void {
  setApp((s) => {
    const recents = s.recents.map((r) => (r.deviceId === deviceId ? { ...r, ...patch } : r));
    saveRecents(recents);
    return { recents };
  });
}

export function removeRecent(deviceId: string): void {
  setApp((s) => {
    const recents = s.recents.filter((r) => r.deviceId !== deviceId);
    saveRecents(recents);
    return { recents };
  });
}

function saveRecents(r: RecentDevice[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}
