import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, FolderOpen, X, XCircle } from 'lucide-react';
import { t } from '../i18n';
import { formatBytes, formatDuration, formatSpeed } from '../lib/format';
import type { Transfer } from '../store/app';

export function TransferList({
  transfers,
  onCancel,
  onOpen,
  openDirection,
}: {
  transfers: Transfer[];
  onCancel?: (id: string) => void;
  onOpen?: (path: string) => void;
  /** Only transfers whose `path` is local to this machine can be opened. */
  openDirection?: 'upload' | 'download';
}) {
  if (transfers.length === 0) return <div className="transfer-empty subtle">{t.files.noTransfers}</div>;
  return (
    <div className="transfers" data-testid="transfer-list">
      {transfers.map((tr) => {
        const pct = tr.total > 0 ? Math.min(100, (tr.bytes / tr.total) * 100) : tr.state === 'done' ? 100 : 0;
        const active = tr.state === 'active' || tr.state === 'pending';
        const eta = active && tr.speed > 0 && tr.total > 0 ? (tr.total - tr.bytes) / tr.speed : null;
        const Dir = tr.direction === 'upload' ? ArrowUpFromLine : ArrowDownToLine;
        return (
          <div key={tr.id} className={`transfer ${tr.state}`} data-testid="transfer-item" data-state={tr.state}>
            <span className={`transfer-icon ${tr.direction}`}>
              {tr.state === 'done' ? <CheckCircle2 /> : tr.state === 'error' ? <XCircle /> : <Dir />}
            </span>
            <div className="transfer-main">
              <div className="transfer-top">
                <span className="transfer-name" title={tr.name}>
                  {tr.name}
                </span>
                <span className="transfer-pct tabular">
                  {tr.state === 'done'
                    ? t.files.done
                    : tr.state === 'cancelled'
                      ? t.files.cancelled
                      : tr.state === 'error'
                        ? t.files.error
                        : `${Math.floor(pct)}%`}
                </span>
              </div>
              <div className={`progress${tr.state === 'done' ? ' done' : tr.state === 'error' ? ' error' : ''}`}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="transfer-sub tabular">
                {tr.state === 'error' && tr.message ? (
                  <span className="err">{tr.message}</span>
                ) : (
                  <>
                    <span>
                      {formatBytes(tr.bytes)} / {tr.total ? formatBytes(tr.total) : '—'}
                      {tr.files && tr.files > 1 ? ` · ${t.files.filesCount(tr.files)}` : ''}
                    </span>
                    {active && tr.speed > 0 && <span>{formatSpeed(tr.speed)}</span>}
                    {eta != null && <span>{t.files.eta(formatDuration(eta))}</span>}
                  </>
                )}
              </div>
            </div>
            {active && onCancel && (
              <button className="icon-btn sm" onClick={() => onCancel(tr.id)} title={t.files.cancel} aria-label={t.files.cancel}>
                <X />
              </button>
            )}
            {tr.state === 'done' && tr.path && onOpen && tr.direction === openDirection && (
              <button className="icon-btn sm" onClick={() => onOpen(tr.path!)} title={t.files.openFolder} aria-label={t.files.openFolder}>
                <FolderOpen />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
