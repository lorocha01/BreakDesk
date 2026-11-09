import { useEffect, useState } from 'react';
import { AlertOctagon, Fingerprint, Loader2, ShieldAlert, ShieldCheck, XCircle, Clock, KeyRound } from 'lucide-react';
import { t } from '../i18n';
import { formatId } from '../lib/format';
import { controller } from '../session/controller';
import { setApp, useApp } from '../store/app';
import type { Permissions } from '../net/protocol';
import { Avatar, Modal, Switch, useNow } from '../components/ui';

export function IncomingModal() {
  const req = useApp((s) => s.incoming[0]);
  const defaults = useApp((s) => s.settings.defaultPermissions);
  const [perms, setPerms] = useState<Permissions>(defaults);
  const now = useNow(500);
  useEffect(() => setPerms(defaults), [req?.sessionId, defaults]);
  if (!req) return null;
  const left = Math.max(0, 60 - Math.floor((now - req.receivedAt) / 1000));
  const v = req.viewer;
  return (
    <Modal labelledBy="incoming-title" testId="incoming-modal" width={480}>
      <div className="modal-body">
        <div className="incoming-head">
          <div className="radar">
            <span />
            <span />
            <Avatar seed={v.deviceId} os={v.os} size="lg" />
          </div>
          <div>
            <div className="modal-title" id="incoming-title">
              {t.incoming.title}
            </div>
            <div className="modal-sub">{t.incoming.subtitle}</div>
          </div>
        </div>
        <div className="incoming-peer">
          <div className="incoming-row">
            <span className="subtle">Nome</span>
            <strong>{v.name || t.common.unknown}</strong>
          </div>
          <div className="incoming-row">
            <span className="subtle">ID</span>
            <strong className="tabular">{formatId(v.deviceId)}</strong>
          </div>
          <div className="incoming-row">
            <span className="subtle">
              <Fingerprint size={13} style={{ verticalAlign: '-2px' }} /> {t.incoming.fingerprint}
            </span>
            <span className="mono small">{v.fingerprint}</span>
          </div>
          <div className="incoming-row">
            <span />
            {req.known ? (
              <span className="badge success">
                <ShieldCheck /> {t.incoming.knownKey}
              </span>
            ) : (
              <span className="badge warning">
                <ShieldAlert /> {t.incoming.newKey}
              </span>
            )}
          </div>
        </div>
        <div className="eyebrow" style={{ margin: '18px 0 8px' }}>
          {t.incoming.permissions}
        </div>
        <div className="perm-list">
          {(
            [
              ['input', t.incoming.permInput],
              ['files', t.incoming.permFiles],
              ['chat', t.incoming.permChat],
            ] as const
          ).map(([k, label]) => (
            <label className="perm-row" key={k}>
              <span>{label}</span>
              <Switch checked={perms[k]} onChange={(val) => setPerms({ ...perms, [k]: val })} label={label} testId={`perm-${k}`} />
            </label>
          ))}
        </div>
        <p className="incoming-warn">
          <ShieldAlert size={15} /> {t.incoming.warning}
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn btn-secondary" onClick={() => controller.host.reject(req.sessionId)} data-testid="incoming-reject">
          {t.incoming.reject}
        </button>
        <button className="btn btn-gradient" onClick={() => controller.host.accept(req.sessionId, perms)} data-testid="incoming-accept">
          {t.incoming.accept}
          <span className="btn-meta tabular">{left}s</span>
        </button>
      </div>
    </Modal>
  );
}

export function OutgoingModal() {
  const o = useApp((s) => s.outgoing);
  if (!o) return null;
  const waiting = o.status === 'sending' || o.status === 'pending';
  const close = () => controller.cancelOutgoing();
  let icon = <Loader2 className="spin" />;
  let title: string = o.mode === 'unattended' ? t.outgoing.waitingUnattended : t.outgoing.waiting;
  let hint: string = t.outgoing.waitingHint(formatId(o.targetId));
  let tone = 'brand';
  if (o.status === 'rejected') {
    icon = <XCircle />;
    title = t.outgoing.rejected;
    hint = o.error ?? t.outgoing.rejectedHint;
    tone = 'danger';
  } else if (o.status === 'timeout') {
    icon = <Clock />;
    title = t.outgoing.timeout;
    hint = t.outgoing.timeoutHint;
    tone = 'warning';
  } else if (o.status === 'error') {
    icon = <AlertOctagon />;
    title = t.outgoing.failed;
    hint = o.error ?? t.errors.generic;
    tone = 'danger';
  }
  return (
    <Modal labelledBy="outgoing-title" testId="outgoing-modal" onClose={waiting ? undefined : close} width={420}>
      <div className="modal-body outgoing">
        <div className={`outgoing-visual ${tone}`}>
          {waiting && (
            <>
              <span className="ring r1" />
              <span className="ring r2" />
            </>
          )}
          <span className="outgoing-icon">{o.mode === 'unattended' && waiting ? <KeyRound /> : icon}</span>
        </div>
        <div className="modal-title" id="outgoing-title" data-testid="outgoing-status" data-status={o.status}>
          {title}
        </div>
        <div className="modal-sub">{hint}</div>
        <div className="outgoing-target">
          <Avatar seed={o.targetId} />
          <div>
            <div className="recent-name">{o.targetName || t.common.unknown}</div>
            <div className="recent-meta tabular">{formatId(o.targetId)}</div>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        {waiting ? (
          <button className="btn btn-secondary" onClick={close} data-testid="outgoing-cancel">
            {t.outgoing.cancel}
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={close} data-testid="outgoing-close">
              {t.outgoing.close}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                const { targetId, mode } = o;
                controller.cancelOutgoing();
                controller.connect(targetId, mode);
              }}
            >
              {t.outgoing.tryAgain}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

export function SecurityAlertModal() {
  const a = useApp((s) => s.securityAlert);
  if (!a) return null;
  return (
    <Modal labelledBy="sec-title" onClose={() => setApp({ securityAlert: null })} testId="security-alert">
      <div className="modal-body">
        <div className="sec-icon">
          <ShieldAlert />
        </div>
        <div className="modal-title" id="sec-title">
          {t.notif.keyChanged}
        </div>
        <p className="modal-sub">{t.errors.keyMismatch}</p>
        <div className="incoming-peer" style={{ marginTop: 16 }}>
          <div className="incoming-row">
            <span className="subtle">ID</span>
            <strong className="tabular">{formatId(a.deviceId)}</strong>
          </div>
          <div className="incoming-row">
            <span className="subtle">Esperada</span>
            <span className="mono small">{a.expected}</span>
          </div>
          <div className="incoming-row">
            <span className="subtle">Recebida</span>
            <span className="mono small danger-text">{a.got}</span>
          </div>
        </div>
        <p className="field-hint" style={{ marginTop: 14 }}>
          {t.settings.trustedKeysHint}
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn btn-secondary" onClick={() => setApp({ securityAlert: null, view: 'settings' })}>
          {t.settings.sections.security}
        </button>
        <button className="btn btn-primary" onClick={() => setApp({ securityAlert: null })}>
          {t.common.close}
        </button>
      </div>
    </Modal>
  );
}
