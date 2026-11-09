import { isPublicServer } from '../net/protocol';
import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, History as HistoryIcon, RefreshCw, ScrollText, WifiOff } from 'lucide-react';
import { endReasonLabel, t } from '../i18n';
import { formatDateTime, formatDuration, formatId } from '../lib/format';
import { platform } from '../platform';
import { controller } from '../session/controller';
import { useApp } from '../store/app';
import type { AuditRow, LocalAuditRow, SessionRow } from '../net/protocol';
import { Avatar, EmptyState, Segmented, Skeleton } from '../components/ui';

type Tab = 'sessions' | 'audit' | 'local';

export function HistoryScreen() {
  const [tab, setTab] = useState<Tab>('sessions');
  const conn = useApp((s) => s.conn);
  const deviceId = useApp((s) => s.deviceId);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [local, setLocal] = useState<LocalAuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'sessions') setSessions((await controller.api.sessions(100)).sessions);
      else if (tab === 'audit') setAudit((await controller.api.audit(200)).events);
      else setLocal(await platform.auditLocal(300));
    } catch (e) {
      setError(tab === 'local' ? (e as Error).message : t.history.unavailable);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    if (tab === 'local' || deviceId) void load();
  }, [load, deviceId, tab]);

  const tabs: { value: Tab; label: string }[] = [
    { value: 'sessions', label: t.history.sessions },
    { value: 'audit', label: t.history.audit },
  ];
  if (platform.canHost) tabs.push({ value: 'local', label: t.history.localAudit });

  return (
    <div className="page">
      <div className="toolbar-row">
        <Segmented<Tab> value={tab} onChange={setTab} options={tabs} testId="history-tabs" />
        <button className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'spin' : ''} /> {t.history.reload}
        </button>
      </div>
      <div className="card table-card">
        {error ? (
          <EmptyState icon={<WifiOff />} title={error} hint={conn !== 'online' ? (isPublicServer(useApp.getState().settings.serverUrl) ? t.status.serverUnreachablePublicHint : t.status.serverUnreachableHint) : undefined}>
            <button className="btn btn-secondary btn-sm" onClick={() => void load()} style={{ marginTop: 8 }}>
              {t.status.retry}
            </button>
          </EmptyState>
        ) : tab === 'sessions' ? (
          <SessionsTable rows={sessions} loading={loading} />
        ) : tab === 'audit' ? (
          <AuditTable rows={audit?.map((a) => ({ at: a.at, event: a.event, sessionId: a.sessionId, peerId: a.actorDevice, detail: a.detail, ip: a.ip })) ?? null} loading={loading} />
        ) : (
          <AuditTable rows={local} loading={loading} />
        )}
      </div>
    </div>
  );
}

function LoadingRows({ cols }: { cols: number }) {
  return (
    <tbody>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j}>
              <Skeleton w={j === 0 ? 160 : 90} h={12} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

function statusBadge(r: SessionRow) {
  const tone =
    r.status === 'ended' ? 'success' : r.status === 'active' ? 'brand' : r.status === 'rejected' || r.status === 'timeout' ? 'warning' : '';
  return <span className={`badge ${tone}`}>{t.history.status[r.status] ?? r.status}</span>;
}

function SessionsTable({ rows, loading }: { rows: SessionRow[] | null; loading: boolean }) {
  const busy = useApp((s) => !!s.outgoing || !!s.viewer || s.conn !== 'online');
  if (rows && rows.length === 0 && !loading) {
    return <EmptyState icon={<HistoryIcon />} title={t.history.empty} hint={t.history.emptyHint} />;
  }
  return (
    <div className="table-scroll">
      <table className="table" data-testid="sessions-table">
        <thead>
          <tr>
            <th>{t.history.peer}</th>
            <th>{t.history.direction}</th>
            <th>{t.history.start}</th>
            <th>{t.history.duration}</th>
            <th>{t.history.result}</th>
            <th aria-label="Ações" />
          </tr>
        </thead>
        {!rows ? (
          <LoadingRows cols={6} />
        ) : (
          <tbody>
            {rows.map((r) => {
              const outgoing = r.role === 'viewer';
              const peerId = outgoing ? r.hostId : r.viewerId;
              const peerName = (outgoing ? r.hostName : r.viewerName) || t.common.unknown;
              return (
                <tr key={r.id}>
                  <td>
                    <div className="cell-peer">
                      <Avatar seed={peerId} />
                      <div>
                        <div className="recent-name">{peerName}</div>
                        <div className="recent-meta tabular">{formatId(peerId)}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`dir ${outgoing ? 'out' : 'in'}`}>
                      {outgoing ? <ArrowUpRight /> : <ArrowDownLeft />}
                      {outgoing ? t.history.outgoing : t.history.incoming}
                    </span>
                    {r.mode === 'unattended' && <span className="badge" style={{ marginLeft: 6 }}>{t.home.modeUnattended}</span>}
                  </td>
                  <td className="tabular nowrap">{formatDateTime(r.acceptedAt ?? r.createdAt)}</td>
                  <td className="tabular nowrap">{formatDuration(r.durationSec)}</td>
                  <td>
                    <div className="cell-status">
                      {statusBadge(r)}
                      {r.endReason && r.status === 'ended' && <span className="subtle small">{endReasonLabel(r.endReason)}</span>}
                    </div>
                  </td>
                  <td className="cell-actions">
                    {outgoing && (
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => controller.connect(peerId, r.mode)}>
                        {t.history.connectAgain}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        )}
      </table>
    </div>
  );
}

function AuditTable({
  rows,
  loading,
}: {
  rows: (LocalAuditRow & { ip?: string | null })[] | null;
  loading: boolean;
}) {
  if (rows && rows.length === 0 && !loading) return <EmptyState icon={<ScrollText />} title={t.history.auditEmpty} />;
  return (
    <div className="table-scroll">
      <table className="table" data-testid="audit-table">
        <thead>
          <tr>
            <th>{t.history.when}</th>
            <th>{t.history.event}</th>
            <th>{t.history.peer}</th>
            <th>{t.history.details}</th>
          </tr>
        </thead>
        {!rows ? (
          <LoadingRows cols={4} />
        ) : (
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="tabular nowrap">{formatDateTime(r.at)}</td>
                <td>
                  <code className="event-code">{r.event}</code>
                </td>
                <td className="tabular">{r.peerId ? formatId(r.peerId) : '—'}</td>
                <td className="detail-cell" title={r.detail ? JSON.stringify(r.detail) : ''}>
                  {r.ip ? <span className="subtle">{r.ip} · </span> : null}
                  {r.detail && typeof r.detail === 'object' && Object.keys(r.detail as object).length
                    ? JSON.stringify(r.detail)
                    : r.sessionId
                      ? <span className="subtle mono">{r.sessionId.slice(0, 8)}</span>
                      : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}
