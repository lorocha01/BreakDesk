import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react';
import { dismissToast, useApp, type NoticeKind } from '../store/app';

export const noticeIcon: Record<NoticeKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => {
        const Icon = noticeIcon[x.kind];
        return (
          <div key={x.id} className="toast" role="status">
            <span className={`toast-icon ${x.kind}`}>
              <Icon />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast-title">{x.title}</div>
              {x.body && <div className="toast-body">{x.body}</div>}
            </div>
            <button className="icon-btn sm" onClick={() => dismissToast(x.id)} aria-label="Fechar">
              <X />
            </button>
          </div>
        );
      })}
    </div>
  );
}
