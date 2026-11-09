import { useEffect, useState } from 'react';
import { MessageSquare, Power, ShieldAlert, ArrowLeftRight } from 'lucide-react';
import { t } from '../i18n';
import { formatClock, formatId } from '../lib/format';
import { platform } from '../platform';
import { controller } from '../session/controller';
import { patchHost, useApp } from '../store/app';
import { Avatar, Switch, useNow } from '../components/ui';
import { ChatPanel } from '../panels/ChatPanel';
import { TransferList } from '../panels/TransferList';

export function HostingCard() {
  const host = useApp((s) => s.host)!;
  const now = useNow();
  const [tab, setTab] = useState<'chat' | 'transfers'>('chat');
  const [focusChat, setFocusChat] = useState(false);

  useEffect(() => {
    const h = () => {
      setTab('chat');
      setFocusChat(true);
      document.querySelector('.hosting-card')?.scrollIntoView({ behavior: 'smooth' });
    };
    window.addEventListener('nexo:open-host-chat', h);
    return () => window.removeEventListener('nexo:open-host-chat', h);
  }, []);

  useEffect(() => {
    if (tab === 'chat' && host.unread > 0) patchHost({ unread: 0 });
  }, [tab, host.unread]);

  const stateLabel =
    host.state === 'awaiting_auth'
      ? t.hosting.awaitingAuth
      : host.state === 'streaming'
        ? t.hosting.streaming
        : host.state === 'reconnecting'
          ? t.hosting.reconnecting
          : t.hosting.connecting;
  const perms = host.permissions;
  const setPerm = (k: keyof typeof perms, v: boolean) => void controller.host.setPermissions({ ...perms, [k]: v });

  return (
    <section className="card hosting-card" data-testid="hosting-card">
      <div className="hosting-banner">
        <span className="live-dot" />
        <div className="hosting-title">
          <strong>{t.hosting.active}</strong>
          <span>{t.hosting.beingAccessed(host.peer.name || formatId(host.peer.deviceId))}</span>
        </div>
        <span className="hosting-timer tabular">{formatClock((now - host.startedAt) / 1000)}</span>
        <button className="btn btn-danger" onClick={() => void controller.host.end('user')} data-testid="host-end">
          <Power /> {t.hosting.end}
        </button>
      </div>
      <div className="hosting-body">
        <div className="hosting-side">
          <div className="hosting-peer">
            <Avatar seed={host.peer.deviceId} os={host.peer.os} size="lg" />
            <div>
              <div className="recent-name">{host.peer.name || t.common.unknown}</div>
              <div className="recent-meta tabular">ID {formatId(host.peer.deviceId)}</div>
              <span className={`badge ${host.state === 'streaming' ? 'success' : 'warning'}`} style={{ marginTop: 6 }}>
                {stateLabel}
              </span>
            </div>
          </div>
          {host.mode === 'unattended' && (
            <div className="hosting-note">
              <ShieldAlert /> {t.incoming.unattended}
            </div>
          )}
          <div className="eyebrow" style={{ margin: '18px 0 8px' }}>
            {t.hosting.permissions}
          </div>
          <div className="perm-list">
            <label className="perm-row">
              <span>{t.incoming.permInput}</span>
              <Switch checked={perms.input} onChange={(v) => setPerm('input', v)} label={t.incoming.permInput} />
            </label>
            <label className="perm-row">
              <span>{t.incoming.permFiles}</span>
              <Switch checked={perms.files} onChange={(v) => setPerm('files', v)} label={t.incoming.permFiles} />
            </label>
            <label className="perm-row">
              <span>{t.incoming.permChat}</span>
              <Switch checked={perms.chat} onChange={(v) => setPerm('chat', v)} label={t.incoming.permChat} />
            </label>
          </div>
        </div>
        <div className="hosting-main">
          <div className="segmented" style={{ marginBottom: 12 }}>
            <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>
              <MessageSquare /> {t.hosting.chat}
              {host.unread > 0 && tab !== 'chat' && <span className="count">{host.unread}</span>}
            </button>
            <button aria-pressed={tab === 'transfers'} onClick={() => setTab('transfers')}>
              <ArrowLeftRight /> {t.hosting.transfers}
              {host.transfers.length > 0 && <span className="count muted-count">{host.transfers.length}</span>}
            </button>
          </div>
          <div className="hosting-panel">
            {tab === 'chat' ? (
              <ChatPanel
                messages={host.chat}
                onSend={(text) => controller.host.sendChat(text)}
                disabled={!perms.chat}
                peerName={host.peer.name || host.peer.deviceId}
                autoFocus={focusChat}
              />
            ) : (
              <TransferList transfers={host.transfers} onOpen={(p) => void platform.openPath(p)} openDirection="upload" />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
