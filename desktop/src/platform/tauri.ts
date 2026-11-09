import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defaultSettings, type LocalAuditRow, type Monitor, type Settings } from '../net/protocol';
import type { DeviceInfo, DownloadSink, HostApi, Identity, Platform } from './types';

let identityCache: Identity | null = null;

class TauriSink implements DownloadSink {
  constructor(
    private id: number,
    private fileIndex: number,
    readonly displayPath: string,
  ) {}
  async write(chunk: Uint8Array): Promise<void> {
    await invoke('dl_write', chunk, {
      headers: { 'x-id': String(this.id), 'x-file-index': String(this.fileIndex) },
    });
  }
  async close(): Promise<void> {
    await invoke('dl_close', { id: this.id, fileIndex: this.fileIndex });
  }
}

const host: HostApi = {
  start: (args) => invoke('host_start', { ...args }),
  signal: (sessionId, data) => invoke('host_signal', { sessionId, data }),
  sendChat: (sessionId, text) => invoke('host_send_chat', { sessionId, text }),
  setPermissions: (sessionId, permissions) => invoke('host_set_permissions', { sessionId, permissions }),
  stop: (sessionId, reason) => invoke('host_stop', { sessionId, reason }),
  listen: (event, cb) => listen(event, (e) => cb(e.payload)),
};

export const tauriPlatform: Platform = {
  kind: 'tauri',
  canHost: true,
  async identity() {
    identityCache ??= await invoke<Identity>('identity_get');
    return identityCache;
  },
  sign: (message) => invoke<string>('identity_sign', { message }),
  verify: (publicKey, message, signature) => invoke<boolean>('identity_verify', { publicKey, message, signature }),
  deviceInfo: () => invoke<DeviceInfo>('device_info'),
  discoverServers: (timeoutMs?: number) => invoke<string[]>('discover_servers', { timeoutMs }),
  async loadSettings() {
    const s = await invoke<Partial<Settings>>('settings_get');
    const base = defaultSettings();
    return {
      ...base,
      ...s,
      defaultPermissions: { ...base.defaultPermissions, ...(s.defaultPermissions ?? {}) },
      unattended: { ...base.unattended, ...(s.unattended ?? {}) },
      trustedKeys: s.trustedKeys ?? {},
    };
  },
  saveSettings: (settings) => invoke('settings_set', { settings }),
  setUnattendedPassword: (password) => invoke('security_set_unattended_password', { password }),
  clearUnattendedPassword: () => invoke('security_clear_unattended_password'),
  monitors: () => invoke<Monitor[]>('monitors_list'),
  async pickDownloadDir() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ directory: true, multiple: false, title: 'Escolha onde salvar' });
    return typeof res === 'string' ? res : null;
  },
  async openDownload(id, fileIndex, destRoot, relPath) {
    const finalPath = await invoke<string>('dl_open', { id, fileIndex, destRoot, relPath });
    return new TauriSink(id, fileIndex, finalPath);
  },
  abortDownload: (id) => invoke('dl_abort', { id }),
  async setFullscreen(on) {
    await getCurrentWindow().setFullscreen(on);
  },
  async copyText(text) {
    await navigator.clipboard.writeText(text);
  },
  async readClipboardText() {
    return navigator.clipboard.readText();
  },
  auditLocal: (limit) => invoke<LocalAuditRow[]>('audit_local_list', { limit }),
  openPath: (path) => invoke('open_path', { path }),
  async getAutostart() {
    const { isEnabled } = await import('@tauri-apps/plugin-autostart');
    return isEnabled();
  },
  async setAutostart(on) {
    const { enable, disable } = await import('@tauri-apps/plugin-autostart');
    if (on) await enable();
    else await disable();
  },
  async checkUpdate() {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return { available: false };
    return {
      available: true,
      version: update.version,
      install: async () => {
        // On Windows the installer closes and relaunches the app itself.
        await update.downloadAndInstall();
      },
    };
  },
  notify(title, body) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
    } catch {
      /* ignore */
    }
  },
  host,
};

