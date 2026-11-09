import type { LocalAuditRow, Monitor, Permissions, Settings } from '../net/protocol';

export interface Identity {
  publicKey: string;
  fingerprint: string;
}

export interface DeviceInfo {
  hostname: string;
  os: string;
  appVersion: string;
}

/** Destination for a single downloaded file (viewer side). */
export interface DownloadSink {
  /** Final path / name shown to the user. */
  readonly displayPath: string;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateInfo {
  available: boolean;
  version?: string;
  install?: () => Promise<void>;
}

export interface HostStartArgs {
  sessionId: string;
  mode: 'attended' | 'unattended';
  iceServers: unknown[];
  permissions: Permissions;
  viewer: { deviceId: string; name: string };
}

export type HostEventName =
  | 'host://offer'
  | 'host://ice'
  | 'host://state'
  | 'host://chat'
  | 'host://transfer'
  | 'host://auth'
  | 'host://ended';

export interface HostApi {
  start(args: HostStartArgs): Promise<void>;
  signal(sessionId: string, data: unknown): Promise<void>;
  sendChat(sessionId: string, text: string): Promise<void>;
  setPermissions(sessionId: string, permissions: Permissions): Promise<void>;
  stop(sessionId: string, reason: string): Promise<void>;
  listen(event: HostEventName, cb: (payload: any) => void): Promise<() => void>;
}

export interface Platform {
  kind: 'tauri' | 'web';
  canHost: boolean;
  identity(): Promise<Identity>;
  sign(message: string): Promise<string>;
  verify(publicKey: string, message: string, signature: string): Promise<boolean>;
  deviceInfo(): Promise<DeviceInfo>;
  loadSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  setUnattendedPassword(password: string): Promise<void>;
  clearUnattendedPassword(): Promise<void>;
  monitors(): Promise<Monitor[]>;
  /** Ask the user where downloads go. null = cancelled. Web returns '' (browser downloads). */
  pickDownloadDir(): Promise<string | null>;
  openDownload(id: number, fileIndex: number, destRoot: string, relPath: string): Promise<DownloadSink>;
  abortDownload(id: number): Promise<void>;
  setFullscreen(on: boolean): Promise<void>;
  copyText(text: string): Promise<void>;
  readClipboardText(): Promise<string>;
  auditLocal(limit: number): Promise<LocalAuditRow[]>;
  openPath(path: string): Promise<void>;
  getAutostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  checkUpdate(): Promise<UpdateInfo>;
  notify(title: string, body: string): void;
  host: HostApi | null;
}
