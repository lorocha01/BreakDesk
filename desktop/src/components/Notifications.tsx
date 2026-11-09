import { Bell, BellOff, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import { formatRelative } from '../lib/format';
import { setApp, useApp } from '../store/app';
import { EmptyState, usePopover } from './ui';
import { noticeIcon } from './Toasts';

export function NotificationsButton() {
  const { open, setOpen, ref } = usePopover();
  const items = useApp((s) => s.notifications);
  const unread = items.filter((n) => !n.read).length;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) markAllRead();
  };
  const markAllRead = () => setApp((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        className={`icon-btn${open ? ' active' : ''}`}
        onClick={toggle}
        aria-label={t.nav.notifications}
        title={t.nav.notifications}
        data-testid="notifications-button"
      >
        <Bell />
        {unread > 0 && <span className="dot-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="popover notif-pop" style={{ right: 0, top: 44 }}>
          <div className="notif-head">
            <span className="card-title">{t.notif.title}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {unread > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={markAllRead}>
                  {t.notif.markRead}
                </button>
              )}
              {items.length > 0 && (
                <button className="icon-btn sm" onClick={() => setApp({ notifications: [] })} title={t.notif.clear} aria-label={t.notif.clear}>
                  <Trash2 />
                </button>
              )}
            </span>
          </div>
          <div className="notif-list">
            {items.length === 0 ? (
              <EmptyState icon={<BellOff />} title={t.notif.empty} hint={t.notif.emptyHint} />
            ) : (
              items.map((n) => {
                const Icon = noticeIcon[n.kind];
                return (
                  <div key={n.id} className={`notif-item${n.read ? '' : ' unread'}`}>
                    <span className={`toast-icon ${n.kind}`}>
                      <Icon />
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="notif-title">{n.title}</div>
                      {n.body && <div className="notif-body">{n.body}</div>}
                    </div>
                    <span className="notif-time">{formatRelative(n.ts)}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
