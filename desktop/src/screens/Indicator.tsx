import { useEffect, useState } from 'react';
import { MessageSquare, Power } from 'lucide-react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t } from '../i18n';
import { formatClock, formatId } from '../lib/format';
import { useNow } from '../components/ui';
import type { IndicatorState } from '../session/host';
import logoUrl from '../assets/logo.svg';

/** Compact always-on-top bar shown on the host while a session is active. */
export function Indicator() {
  const [st, setSt] = useState<IndicatorState | null>(null);
  const now = useNow();

  useEffect(() => {
    document.documentElement.classList.add('indicator-root');
    let un: (() => void) | undefined;
    void listen<IndicatorState>('indicator://state', (e) => setSt(e.payload)).then((u) => {
      un = u;
      void emit('indicator://hello', {});
    });
    return () => un?.();
  }, []);

  useEffect(() => {
    if (st && !st.active) {
      void getCurrentWindow().close().catch(() => {});
    }
  }, [st]);

  const who = st?.peerName || (st?.peerId ? formatId(st.peerId) : '…');
  return (
    <div className="indicator" data-tauri-drag-region>
      <img src={logoUrl} width={22} height={22} alt="" data-tauri-drag-region />
      <span className={`live-dot${st?.state === 'reconnecting' ? ' warn' : ''}`} data-tauri-drag-region />
      <div className="indicator-text" data-tauri-drag-region>
        <strong data-tauri-drag-region>{t.hosting.active}</strong>
        <span data-tauri-drag-region>
          {who}
          {st?.startedAt ? ` · ${formatClock((now - st.startedAt) / 1000)}` : ''}
        </span>
      </div>
      <button className="icon-btn sm ind-btn" onClick={() => void emit('indicator://open-chat', {})} title={t.hosting.chat} aria-label={t.hosting.chat}>
        <MessageSquare />
        {st?.unread ? <span className="dot-badge">{st.unread}</span> : null}
      </button>
      <button className="btn btn-danger btn-sm" onClick={() => void emit('indicator://end', {})}>
        <Power /> {t.session.end}
      </button>
    </div>
  );
}
