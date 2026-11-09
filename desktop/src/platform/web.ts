import { b64ToBytes, bytesToB64 } from '../lib/b64';
import { defaultSettings, type LocalAuditRow, type Settings } from '../net/protocol';
import { fingerprintOf, newKeypair, publicFromSecret, signEd25519, verifyEd25519 } from './crypto';
import type { DownloadSink, Identity, Platform } from './types';

const KEY_STORE = 'nexo.web.identity.v1';
const SETTINGS_STORE = 'nexo.web.settings.v1';

let secret: Uint8Array | null = null;
let identityCache: Identity | null = null;

async function ensureIdentity(): Promise<Identity> {
  if (identityCache && secret) return identityCache;
  const stored = localStorage.getItem(KEY_STORE);
  if (stored) {
    secret = b64ToBytes(stored);
  } else {
    secret = (await newKeypair()).secret;
    localStorage.setItem(KEY_STORE, bytesToB64(secret));
  }
  const pub = bytesToB64(await publicFromSecret(secret));
  identityCache = { publicKey: pub, fingerprint: fingerprintOf(pub) };
  return identityCache;
}

function detectOs(): string {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows (navegador)';
  if (/Mac OS X/i.test(ua)) return 'macOS (navegador)';
  if (/Android/i.test(ua)) return 'Android (navegador)';
  if (/Linux/i.test(ua)) return 'Linux (navegador)';
  return 'Navegador';
}

class BlobSink implements DownloadSink {
  private parts: Uint8Array[] = [];
  constructor(readonly displayPath: string) {}
  async write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk);
  }
  async close(): Promise<void> {
    const blob = new Blob(this.parts as BlobPart[]);
    this.parts = [];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.displayPath.split('/').filter(Boolean).join('_') || 'arquivo';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export const webPlatform: Platform = {
  kind: 'web',
  canHost: false,
  identity: ensureIdentity,
  async sign(message) {
    await ensureIdentity();
    return signEd25519(secret!, message);
  },
  verify: verifyEd25519,
  async discoverServers() {
    return [];
  },
  async deviceInfo() {
    return { hostname: 'Navegador', os: detectOs(), appVersion: __APP_VERSION__ };
  },
  async loadSettings() {
    const base = defaultSettings();
    try {
      const raw = localStorage.getItem(SETTINGS_STORE);
      if (raw) return { ...base, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
      /* ignore corrupt settings */
    }
    return base;
  },
  async saveSettings(settings) {
    localStorage.setItem(SETTINGS_STORE, JSON.stringify(settings));
  },
  async setUnattendedPassword() {
    throw new Error('unsupported');
  },
  async clearUnattendedPassword() {
    throw new Error('unsupported');
  },
  async monitors() {
    return [];
  },
  async pickDownloadDir() {
    return '';
  },
  async openDownload(_id, _fileIndex, _destRoot, relPath) {
    return new BlobSink(relPath);
  },
  async abortDownload() {},
  async setFullscreen(on) {
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* not allowed */
    }
  },
  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  },
  async readClipboardText() {
    return navigator.clipboard.readText();
  },
  async auditLocal(): Promise<LocalAuditRow[]> {
    return [];
  },
  async openPath() {},
  async getAutostart() {
    return false;
  },
  async setAutostart() {},
  async checkUpdate() {
    return { available: false };
  },
  notify(title, body) {
    if (document.hasFocus()) return;
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
    } catch {
      /* ignore */
    }
  },
  host: null,
};
