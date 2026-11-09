import { platform } from '../platform';
import type { Settings } from '../net/protocol';
import { getApp, setApp } from '../store/app';

/** Merge, store and persist settings (no side effects beyond storage). */
export async function persistSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...getApp().settings, ...patch };
  setApp({ settings: next });
  try {
    await platform.saveSettings(next);
  } catch (e) {
    console.warn('[settings] save failed', e);
  }
  return next;
}
