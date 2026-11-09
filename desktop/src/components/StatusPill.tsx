import { RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import { useApp } from '../store/app';
import { controller } from '../session/controller';

export function StatusPill({ compact }: { compact?: boolean }) {
  const conn = useApp((s) => s.conn);
  const latency = useApp((s) => s.latency);
  const label = conn === 'online' ? t.status.online : conn === 'connecting' ? t.status.connecting : t.status.offline;
  return (
    <span className="status-wrap">
      <span className={`pill ${conn}`} data-testid="connection-status" data-state={conn} title={label}>
        <span className="dot" />
        {!compact && label}
        {!compact && conn === 'online' && latency != null && <span className="pill-meta tabular">· {t.status.latency(latency)}</span>}
      </span>
      {conn === 'offline' && !compact && (
        <button className="icon-btn sm" onClick={() => controller.retry()} title={t.status.retry} aria-label={t.status.retry}>
          <RefreshCw />
        </button>
      )}
    </span>
  );
}
