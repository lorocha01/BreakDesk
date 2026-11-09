import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  Fingerprint,
  KeyRound,
  Monitor,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Star,
  Trash2,
  UserCheck,
  Info,
  Clock,
} from 'lucide-react';
import { t } from '../i18n';
import { formatId, formatRelative, isValidId, digitsOnly } from '../lib/format';
import { platform } from '../platform';
import { controller } from '../session/controller';
import { removeRecent, toast, updateRecent, useApp, type RecentDevice } from '../store/app';
import type { Mode } from '../net/protocol';
import { Avatar, EmptyState, Segmented, Skeleton, usePopover } from '../components/ui';
import { HostingCard } from './HostingCard';

export function Home() {
  const host = useApp((s) => s.host);
  return (
    <div className="page home">
      <div className="home-grid">
        <IdCard />
        <ConnectCard />
      </div>
      {host && <HostingCard />}
      <RecentCard />
    </div>
  );
}

function IdCard() {
  const deviceId = useApp((s) => s.deviceId);
  const identity = useApp((s) => s.identity);
  const settings = useApp((s) => s.settings);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!deviceId) return;
    await platform.copyText(deviceId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <section className="card id-card" aria-labelledby="id-card-title">
      <div className="id-card-deco" aria-hidden />
      <div className="id-card-top">
        <span className="eyebrow" id="id-card-title">
          {t.home.thisComputer}
        </span>
        {platform.canHost ? (
          <span className="badge success">
            <ShieldCheck /> {settings.unattended.enabled ? t.home.modeUnattended : t.home.modeAttended}
          </span>
        ) : (
          <span className="badge brand">{t.home.webBadge}</span>
        )}
      </div>
      <div className="id-label">{t.home.yourId}</div>
      <div className="id-row">
        {deviceId ? (
          <span className="id-value tabular" data-testid="own-id" data-id={deviceId}>
            {formatId(deviceId)}
          </span>
        ) : (
          <span className="id-value placeholder" data-testid="own-id-pending">
            <Skeleton w={260} h={40} r={10} />
          </span>
        )}
        <button
          className={`btn btn-secondary copy-btn${copied ? ' copied' : ''}`}
          onClick={copy}
          disabled={!deviceId}
          data-testid="copy-id"
          aria-label={t.home.copy}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t.home.copied : t.home.copy}
        </button>
      </div>
      <p className="id-hint">{platform.canHost ? t.home.idHint : t.home.hostingNotSupported}</p>
      <div className="id-meta">
        <span title={t.home.fingerprint}>
          <Fingerprint />
          <span className="mono" data-testid="own-fingerprint">
            {identity?.fingerprint ?? '····:····:····:····'}
          </span>
        </span>
        <span>
          <Monitor />
          {controller.deviceName}
        </span>
      </div>
    </section>
  );
}

function ConnectCard() {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<Mode>('attended');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const conn = useApp((s) => s.conn);
  const busy = useApp((s) => !!s.outgoing || !!s.viewer);
  const ownId = useApp((s) => s.deviceId);
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = isValidId(value);
  const isSelf = valid && digitsOnly(value) === ownId;
  const error = touched && value.length > 0 && !valid ? t.home.invalidId : isSelf ? t.errors.SELF : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || isSelf) {
      inputRef.current?.focus();
      return;
    }
    controller.connect(value, mode, mode === 'unattended' ? password : undefined);
  };

  return (
    <section className="card connect-card" aria-labelledby="connect-title">
      <div className="card-head" style={{ marginBottom: 6 }}>
        <div>
          <h2 className="card-title" id="connect-title">
            {t.home.remoteTitle}
          </h2>
          <p className="card-sub">{t.home.remoteHint}</p>
        </div>
      </div>
      <form onSubmit={submit} className="connect-form" noValidate>
        <div className="input-group big-input">
          <Monitor />
          <input
            ref={inputRef}
            className={`input${error ? ' invalid' : ''}`}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={t.home.remotePlaceholder}
            value={formatId(value)}
            onChange={(e) => setValue(digitsOnly(e.target.value).slice(0, 9))}
            onBlur={() => setTouched(true)}
            aria-invalid={!!error}
            aria-label={t.home.remoteTitle}
            data-testid="remote-id-input"
          />
        </div>
        <div className="field-error-slot">{error && <div className="field-error">{error}</div>}</div>
        <Segmented<Mode>
          block
          value={mode}
          onChange={setMode}
          testId="mode-toggle"
          options={[
            { value: 'attended', label: t.home.modeAttended, icon: <UserCheck />, title: t.home.modeAttendedHint },
            { value: 'unattended', label: t.home.modeUnattended, icon: <KeyRound />, title: t.home.modeUnattendedHint },
          ]}
        />
        <div className={`collapse${mode === 'unattended' ? ' open' : ''}`}>
          <div className="collapse-inner">
            <div className="input-group">
              <KeyRound />
              <input
                className="input"
                type="password"
                placeholder={t.home.password}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                data-testid="unattended-password"
                tabIndex={mode === 'unattended' ? 0 : -1}
              />
            </div>
            <p className="field-hint" style={{ marginTop: 6 }}>
              {t.home.modeUnattendedHint}
            </p>
          </div>
        </div>
        <button
          type="submit"
          className="btn btn-gradient btn-lg btn-block"
          disabled={busy || conn !== 'online'}
          data-testid="connect-button"
        >
          {t.home.connect}
          <ArrowRight />
        </button>
        {conn !== 'online' && (
          <p className="field-hint center">
            <Info size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            {t.errors.notConnected}
          </p>
        )}
      </form>
    </section>
  );
}

function RecentCard() {
  const recents = useApp((s) => s.recents);
  const sorted = useMemo(
    () => [...recents].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.lastAt - a.lastAt),
    [recents],
  );
  return (
    <section className="card card-pad recent-card" aria-labelledby="recent-title">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="recent-title">
            {t.home.recent}
          </h2>
        </div>
        {sorted.length > 0 && <span className="subtle tabular">{sorted.length}</span>}
      </div>
      {sorted.length === 0 ? (
        <EmptyState icon={<Clock />} title={t.home.recentEmpty} hint={t.home.recentEmptyHint} />
      ) : (
        <div className="recent-grid" data-testid="recent-list">
          {sorted.map((r) => (
            <RecentTile key={r.deviceId} r={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function RecentTile({ r }: { r: RecentDevice }) {
  const { open, setOpen, ref } = usePopover();
  const busy = useApp((s) => !!s.outgoing || !!s.viewer || s.conn !== 'online');
  const name = r.alias || r.name || formatId(r.deviceId);
  const rename = () => {
    setOpen(false);
    const alias = window.prompt(t.home.rename, r.alias || r.name || '');
    if (alias != null) updateRecent(r.deviceId, { alias: alias.trim() || undefined });
  };
  return (
    <div className="recent-tile" data-testid={`recent-${r.deviceId}`}>
      <Avatar seed={r.deviceId} os={r.os} />
      <div className="recent-info">
        <div className="recent-name">
          {name}
          {r.favorite && <Star className="fav-star" />}
        </div>
        <div className="recent-meta tabular">
          {formatId(r.deviceId)} · {formatRelative(r.lastAt)}
        </div>
      </div>
      <div className="recent-actions pop-anchor" ref={ref}>
        <button className="icon-btn sm" aria-label="Mais opções" onClick={() => setOpen(!open)}>
          <MoreHorizontal />
        </button>
        <button
          className="connect-mini"
          disabled={busy}
          onClick={() => controller.connect(r.deviceId, 'attended')}
          title={t.home.connect}
          aria-label={`${t.home.connect} ${name}`}
        >
          <ArrowRight />
        </button>
        {open && (
          <div className="popover" style={{ right: 0, top: 36 }}>
            <button className="menu-item" onClick={rename}>
              <Pencil /> {t.home.rename}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                updateRecent(r.deviceId, { favorite: !r.favorite });
                setOpen(false);
              }}
            >
              <Star /> {r.favorite ? t.home.unfavorite : t.home.favorite}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void platform.copyText(r.deviceId);
                toast('success', t.home.copied);
                setOpen(false);
              }}
            >
              <Copy /> {t.common.copy} ID
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item"
              onClick={() => {
                removeRecent(r.deviceId);
                setOpen(false);
              }}
            >
              <Trash2 /> {t.home.remove}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
