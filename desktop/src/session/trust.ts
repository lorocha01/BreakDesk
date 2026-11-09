// Trust-on-first-use pinning of peer public keys (PROTOCOL.md §4).
import type { PeerInfo } from '../net/protocol';
import { getApp } from '../store/app';
import { persistSettings } from './settings';

export type TrustStatus = 'new' | 'known' | 'mismatch';

export function trustStatus(peer: Pick<PeerInfo, 'deviceId' | 'publicKey'>): TrustStatus {
  const pinned = getApp().settings.trustedKeys[peer.deviceId];
  if (!pinned) return 'new';
  return pinned.publicKey === peer.publicKey ? 'known' : 'mismatch';
}

export async function pinPeer(peer: PeerInfo): Promise<void> {
  const keys = getApp().settings.trustedKeys;
  const existing = keys[peer.deviceId];
  if (existing && existing.publicKey === peer.publicKey && existing.name === peer.name) return;
  await persistSettings({
    trustedKeys: {
      ...keys,
      [peer.deviceId]: {
        publicKey: peer.publicKey,
        fingerprint: peer.fingerprint,
        name: peer.name,
        firstSeen: existing?.firstSeen ?? new Date().toISOString(),
      },
    },
  });
}

export async function forgetPeer(deviceId: string): Promise<void> {
  const keys = { ...getApp().settings.trustedKeys };
  delete keys[deviceId];
  await persistSettings({ trustedKeys: keys });
}
