import { tauriPlatform } from './tauri';
import { webPlatform } from './web';
import type { Platform } from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const platform: Platform = isTauri ? tauriPlatform : webPlatform;
export type { Platform } from './types';
