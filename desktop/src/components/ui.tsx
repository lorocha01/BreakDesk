import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Monitor, Laptop, Globe } from 'lucide-react';
import logoUrl from '../assets/logo.svg';
import { t } from '../i18n';

export function Logo({ size = 32, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="logo">
      <img src={logoUrl} width={size} height={size} alt="" draggable={false} />
      {wordmark && <span className="logo-word">{t.app.name}</span>}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  block,
  testId,
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  block?: boolean;
  testId?: string;
}) {
  return (
    <div className={`segmented${block ? ' block' : ''}`} role="group" data-testid={testId}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {label && (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Modal({
  children,
  onClose,
  width,
  labelledBy,
  testId,
}: {
  children: ReactNode;
  onClose?: () => void;
  width?: number;
  labelledBy?: string;
  testId?: string;
}) {
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {children}
    </div>
  );
}

export function Skeleton({ w = '100%', h = 14, r }: { w?: number | string; h?: number; r?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, borderRadius: r }} />;
}

export function QualityBars({ level, title }: { level: number; title?: string }) {
  return (
    <span className={`qbars q-${level}`} title={title} aria-label={title}>
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={i <= level ? 'on' : ''} />
      ))}
    </span>
  );
}

const AVATAR_GRADS = [
  ['#6a5cff', '#4c55f0'],
  ['#12b5a5', '#0c8f9b'],
  ['#f2994a', '#eb5757'],
  ['#2f80ed', '#56ccf2'],
  ['#9b51e0', '#bb6bd9'],
  ['#27ae60', '#6fcf97'],
  ['#e0457b', '#f78ca0'],
];

export function Avatar({ seed, os, size }: { seed: string; os?: string | null; size?: 'lg' }) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = AVATAR_GRADS[h % AVATAR_GRADS.length];
  const o = (os ?? '').toLowerCase();
  const Icon = o.includes('naveg') || o.includes('browser') ? Globe : o.includes('mac') ? Laptop : Monitor;
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
      <Icon />
    </span>
  );
}

/** Popover anchored in a relatively positioned wrapper; closes on outside click / Escape. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
