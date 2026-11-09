import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  Check,
  ClipboardPaste,
  Command,
  FolderOpen,
  Gauge,
  KeyRound,
  Keyboard,
  Loader2,
  Lock,
  Maximize,
  MessageSquare,
  Minimize,
  Monitor as MonitorIcon,
  MonitorOff,
  Power,
  Radio,
  ShieldCheck,
  WifiOff,
  X,
  Eye,
} from 'lucide-react';
import { t } from '../i18n';
import { clamp, formatClock, formatId } from '../lib/format';
import { platform } from '../platform';
import { controller } from '../session/controller';
import { patchViewer, useApp, type ViewerState } from '../store/app';
import type { QualityPreset } from '../net/protocol';
import { Avatar, QualityBars, Segmented, usePopover, useNow } from '../components/ui';
import { ChatPanel } from '../panels/ChatPanel';
import { FilesPanel } from '../panels/FilesPanel';

type Panel = 'files' | 'chat' | null;

export function SessionView() {
  const viewer = useApp((s) => s.viewer)!;
  const [panel, setPanel] = useState<Panel>(null);
  const [fs, setFs] = useState(false);
  const [barVisible, setBarVisible] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const togglePanel = (p: Exclude<Panel, null>) => {
    setPanel((cur) => (cur === p ? null : p));
    if (p === 'chat') patchViewer({ unread: 0 });
  };

  useEffect(() => {
    if (panel === 'chat' && viewer.unread > 0) patchViewer({ unread: 0 });
  }, [panel, viewer.unread]);

  const toggleFs = async () => {
    const next = !fs;
    await platform.setFullscreen(next).catch(() => {});
    setFs(next);
  };

  useEffect(() => {
    const h = () => {
      if (platform.kind === 'web') setFs(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  // Toolbar auto-hide in fullscreen
  useEffect(() => {
    if (!fs) {
      setBarVisible(true);
      return;
    }
    const onMove = (e: MouseEvent) => {
      if (e.clientY < 14) {
        setBarVisible(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
      }
    };
    window.addEventListener('mousemove', onMove);
    hideTimer.current = setTimeout(() => setBarVisible(false), 1800);
    return () => window.removeEventListener('mousemove', onMove);
  }, [fs]);

  const scheduleHide = () => {
    if (!fs) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setBarVisible(false), 900);
  };

  return (
    <div className={`session${fs ? ' fullscreen' : ''}${barVisible ? '' : ' bar-hidden'}`} data-testid="session-view">
      <SessionBar
        viewer={viewer}
        panel={panel}
        togglePanel={togglePanel}
        fs={fs}
        toggleFs={toggleFs}
        showStats={showStats}
        setShowStats={setShowStats}
        onMouseEnter={() => hideTimer.current && clearTimeout(hideTimer.current)}
        onMouseLeave={scheduleHide}
      />
      <div className="session-body">
        <Stage viewer={viewer} showStats={showStats} />
        <aside className={`side-panel${panel ? ' open' : ''}`} aria-hidden={!panel}>
          {panel && (
            <>
              <div className="side-head">
                <span className="card-title">{panel === 'files' ? t.files.title : t.chat.title}</span>
                <button className="icon-btn sm" onClick={() => setPanel(null)} aria-label={t.common.close}>
                  <X />
                </button>
              </div>
              <div className="side-content">
                {panel === 'files' ? (
                  <FilesPanel />
                ) : (
                  <ChatPanel
                    messages={viewer.chat}
                    onSend={(text) => controller.viewer?.sendChat(text)}
                    disabled={!viewer.permissions.chat}
                    peerName={viewer.peer.name || viewer.peer.deviceId}
                    autoFocus
                  />
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  active,
  badge,
  testId,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  badge?: number;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`tool-btn${active ? ' active' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
    >
      {icon}
      <span className="tool-label">{label}</span>
      {badge ? <span className="dot-badge">{badge > 9 ? '9+' : badge}</span> : null}
    </button>
  );
}

function SessionBar({
  viewer,
  panel,
  togglePanel,
  fs,
  toggleFs,
  showStats,
  setShowStats,
  onMouseEnter,
  onMouseLeave,
}: {
  viewer: ViewerState;
  panel: Panel;
  togglePanel: (p: 'files' | 'chat') => void;
  fs: boolean;
  toggleFs: () => void;
  showStats: boolean;
  setShowStats: (v: boolean) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const now = useNow();
  const s = viewer.stats;
  const rtt = s.rttMs ?? s.pingMs;
  const statusLabel =
    viewer.status === 'streaming'
      ? t.hosting.streaming
      : viewer.status === 'auth'
        ? t.session.authTitle
        : viewer.status === 'reconnecting'
          ? t.session.reconnecting
          : t.session.connecting;
  const streaming = viewer.status === 'streaming';
  return (
    <header className="session-bar" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="sb-left">
        <Avatar seed={viewer.peer.deviceId} os={viewer.peer.os} />
        <div className="sb-peer">
          <div className="sb-name">{viewer.hostName || viewer.peer.name || t.common.unknown}</div>
          <div className="sb-id tabular">
            {formatId(viewer.peer.deviceId)}
            <span className={`sb-status ${viewer.status}`} data-testid="session-status" data-status={viewer.status}>
              <span className="dot" />
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="sb-tools">
        <MonitorsMenu viewer={viewer} disabled={!streaming} />
        <QualityMenu viewer={viewer} disabled={!streaming} />
        <KeysMenu viewer={viewer} disabled={!streaming || !viewer.permissions.input} />
        <span className="sb-sep" />
        <ToolButton
          icon={<FolderOpen />}
          label={t.session.files}
          onClick={() => togglePanel('files')}
          active={panel === 'files'}
          testId="files-button"
        />
        <ToolButton
          icon={<MessageSquare />}
          label={t.session.chat}
          onClick={() => togglePanel('chat')}
          active={panel === 'chat'}
          badge={panel === 'chat' ? 0 : viewer.unread}
          testId="chat-button"
        />
        <ToolButton icon={<Activity />} label={t.session.stats} onClick={() => setShowStats(!showStats)} active={showStats} testId="stats-button" />
        <ToolButton
          icon={fs ? <Minimize /> : <Maximize />}
          label={fs ? t.session.exitFullscreen : t.session.fullscreen}
          onClick={toggleFs}
          testId="fullscreen-button"
        />
      </div>

      <div className="sb-right">
        <div
          className="quality-chip"
          data-testid="quality-indicator"
          data-level={s.level}
          data-route={s.route ?? ''}
          title={`${t.session.latency}: ${rtt ?? '—'} ms`}
        >
          <QualityBars level={s.level} title={s.level ? t.session.qualityLabels[s.level - 1] : undefined} />
          <span className="tabular">{rtt != null ? `${rtt} ms` : '— ms'}</span>
          {s.route && (
            <span className={`route ${s.route}`}>
              {s.route === 'p2p' ? <Radio size={12} /> : <ShieldCheck size={12} />}
              {s.route === 'p2p' ? 'P2P' : 'Relay'}
            </span>
          )}
        </div>
        <span className="sb-timer tabular" data-testid="session-timer">
          {formatClock((now - viewer.startedAt) / 1000)}
        </span>
        <button className="btn btn-danger btn-sm" onClick={() => controller.endViewer('user')} data-testid="end-session">
          <Power /> {t.session.end}
        </button>
      </div>
    </header>
  );
}

function MonitorsMenu({ viewer, disabled }: { viewer: ViewerState; disabled: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const count = viewer.monitors.length;
  return (
    <div className="pop-anchor" ref={ref}>
      <ToolButton
        icon={<MonitorIcon />}
        label={count > 1 ? `${t.session.monitors} (${count})` : t.session.monitors}
        onClick={() => setOpen(!open)}
        active={open}
        disabled={disabled}
        testId="monitors-button"
      />
      {open && (
        <div className="popover" style={{ left: 0, top: 46 }}>
          <div className="menu-label">{t.session.monitors}</div>
          {viewer.monitors.length === 0 && <div className="menu-item subtle">—</div>}
          {viewer.monitors.map((m) => (
            <button
              key={m.index}
              className={`menu-item${m.index === viewer.currentMonitor ? ' selected' : ''}`}
              onClick={() => {
                controller.viewer?.selectMonitor(m.index);
                setOpen(false);
              }}
              data-testid={`monitor-${m.index}`}
            >
              <MonitorIcon />
              <span>
                {m.name || t.session.monitor(m.index + 1)}
                <small className="tabular">
                  {m.width}×{m.height}
                  {m.primary ? ` · ${t.session.primary}` : ''}
                </small>
              </span>
              {m.index === viewer.currentMonitor && <Check className="menu-meta" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QualityMenu({ viewer, disabled }: { viewer: ViewerState; disabled: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const set = (preset: QualityPreset, fps: number) => controller.viewer?.setQuality(preset, fps);
  return (
    <div className="pop-anchor" ref={ref}>
      <ToolButton icon={<Gauge />} label={t.session.quality} onClick={() => setOpen(!open)} active={open} disabled={disabled} testId="quality-button" />
      {open && (
        <div className="popover" style={{ left: 0, top: 46, width: 270 }}>
          <div className="menu-label">{t.session.quality}</div>
          {(['auto', 'quality', 'balanced', 'speed'] as const).map((p) => (
            <button key={p} className={`menu-item${viewer.quality === p ? ' selected' : ''}`} onClick={() => set(p, viewer.fps)}>
              <Gauge />
              <span>
                {t.session.presets[p]}
                <small>{t.session.presetHints[p]}</small>
              </span>
              {viewer.quality === p && <Check className="menu-meta" />}
            </button>
          ))}
          <div className="menu-sep" />
          <div className="menu-label">{t.session.fps}</div>
          <div style={{ padding: '4px 6px 6px' }}>
            <Segmented<number>
              block
              value={viewer.fps}
              onChange={(fps) => set(viewer.quality, fps)}
              options={[15, 30, 60].map((n) => ({ value: n, label: `${n}` }))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const COMBOS: { label: string; codes: string[]; note?: string; icon: ReactNode }[] = [
  { label: t.session.ctrlAltDel, codes: ['ControlLeft', 'AltLeft', 'Delete'], note: t.session.ctrlAltDelNote, icon: <Lock /> },
  { label: t.session.taskManager, codes: ['ControlLeft', 'ShiftLeft', 'Escape'], icon: <Activity /> },
  { label: t.session.win, codes: ['MetaLeft'], icon: <Command /> },
  { label: t.session.altTab, codes: ['AltLeft', 'Tab'], icon: <Keyboard /> },
  { label: t.session.winR, codes: ['MetaLeft', 'KeyR'], icon: <Keyboard /> },
  { label: t.session.winD, codes: ['MetaLeft', 'KeyD'], icon: <Keyboard /> },
  { label: t.session.winL, codes: ['MetaLeft', 'KeyL'], icon: <Lock /> },
  { label: t.session.printScreen, codes: ['PrintScreen'], icon: <Keyboard /> },
];

function KeysMenu({ viewer: _viewer, disabled }: { viewer: ViewerState; disabled: boolean }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="pop-anchor" ref={ref}>
      <ToolButton icon={<Keyboard />} label={t.session.keys} onClick={() => setOpen(!open)} active={open} disabled={disabled} testId="keys-button" />
      {open && (
        <div className="popover" style={{ left: 0, top: 46, width: 290 }}>
          <div className="menu-label">{t.session.keysTitle}</div>
          {COMBOS.map((c) => (
            <button
              key={c.label}
              className="menu-item"
              onClick={() => {
                controller.viewer?.sendInput({ t: 'combo', codes: c.codes });
                setOpen(false);
              }}
            >
              {c.icon}
              <span>
                {c.label}
                {c.note && <small>{c.note}</small>}
              </span>
            </button>
          ))}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={async () => {
              setOpen(false);
              try {
                const text = await platform.readClipboardText();
                if (text) controller.viewer?.sendInput({ t: 'text', text: text.slice(0, 10_000) });
              } catch {
                const text = window.prompt(t.session.pasteText);
                if (text) controller.viewer?.sendInput({ t: 'text', text: text.slice(0, 10_000) });
              }
            }}
          >
            <ClipboardPaste />
            <span>{t.session.pasteText}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Stage({ viewer, showStats }: { viewer: ViewerState; showStats: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [focused, setFocused] = useState(false);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);
  const pressed = useRef(new Set<string>());
  const buttons = useRef(new Set<number>());
  const wheelAcc = useRef({ dx: 0, dy: 0, timer: null as ReturnType<typeof setTimeout> | null });
  const canInput = viewer.permissions.input && viewer.status === 'streaming';

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.srcObject !== viewer.stream) {
      v.srcObject = viewer.stream;
      setHasFrame(false);
    }
    if (viewer.stream) void v.play().catch(() => {});
  }, [viewer.stream]);

  // Viewport reporting (physical pixels) for automatic resolution
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      controller.viewer?.setViewport(el.clientWidth * dpr, el.clientHeight * dpr);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const norm = useCallback((clientX: number, clientY: number) => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    const r = v.getBoundingClientRect();
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    const ox = r.left + (r.width - w) / 2;
    const oy = r.top + (r.height - h) / 2;
    return { x: clamp((clientX - ox) / w, 0, 1), y: clamp((clientY - oy) / h, 0, 1) };
  }, []);

  const send = controller.viewer;

  const flushMove = () => {
    raf.current = null;
    if (pending.current) {
      send?.sendInput({ t: 'mm', ...pending.current });
      pending.current = null;
    }
  };

  const releaseAll = useCallback(() => {
    for (const code of pressed.current) controller.viewer?.sendInput({ t: 'ku', code, key: '' });
    pressed.current.clear();
    for (const b of buttons.current) controller.viewer?.sendInput({ t: 'mu', b });
    buttons.current.clear();
  }, []);

  // Non-passive wheel listener so we can preventDefault
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!canInput) return;
      e.preventDefault();
      const mult = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const acc = wheelAcc.current;
      acc.dx += e.deltaX * mult;
      acc.dy += e.deltaY * mult;
      if (!acc.timer) {
        acc.timer = setTimeout(() => {
          controller.viewer?.sendInput({ t: 'wh', dx: Math.round(acc.dx), dy: Math.round(acc.dy) });
          acc.dx = 0;
          acc.dy = 0;
          acc.timer = null;
        }, 16);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canInput]);

  useEffect(() => {
    window.addEventListener('blur', releaseAll);
    return () => window.removeEventListener('blur', releaseAll);
  }, [releaseAll]);

  const s = viewer.stats;
  const overlay = (() => {
    if (viewer.status === 'auth') return <AuthOverlay viewer={viewer} />;
    if (viewer.status === 'reconnecting')
      return (
        <StageMessage icon={<WifiOff />} title={t.session.reconnecting} hint={t.session.reconnectingHint} spinner />
      );
    if (viewer.status === 'connecting')
      return <StageMessage icon={<ShieldCheck />} title={t.session.connecting} hint={t.session.negotiating} spinner />;
    if (!hasFrame) return <StageMessage icon={<MonitorIcon />} title={t.session.waitingVideo} spinner />;
    return null;
  })();

  return (
    <div
      ref={stageRef}
      className={`stage${canInput ? ' interactive' : ''}${focused ? ' focused' : ''}`}
      tabIndex={0}
      data-testid="remote-stage"
      onFocus={(e) => e.target === e.currentTarget && setFocused(true)}
      onBlur={(e) => {
        if (e.target !== e.currentTarget) return;
        setFocused(false);
        releaseAll();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerMove={(e) => {
        if (!canInput) return;
        const p = norm(e.clientX, e.clientY);
        if (!p) return;
        pending.current = p;
        raf.current ??= requestAnimationFrame(flushMove);
      }}
      onPointerDown={(e) => {
        stageRef.current?.focus();
        if (!canInput) return;
        e.preventDefault();
        const p = norm(e.clientX, e.clientY);
        if (p) send?.sendInput({ t: 'mm', ...p });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        buttons.current.add(e.button);
        send?.sendInput({ t: 'md', b: e.button });
      }}
      onPointerUp={(e) => {
        if (!canInput) return;
        buttons.current.delete(e.button);
        send?.sendInput({ t: 'mu', b: e.button });
      }}
      onKeyDown={(e) => {
        if (!canInput) return;
        e.preventDefault();
        pressed.current.add(e.code);
        send?.sendInput({ t: 'kd', code: e.code, key: e.key });
      }}
      onKeyUp={(e) => {
        if (!canInput) return;
        e.preventDefault();
        pressed.current.delete(e.code);
        send?.sendInput({ t: 'ku', code: e.code, key: e.key });
      }}
    >
      <video
        ref={videoRef}
        className={`remote-video${hasFrame ? ' ready' : ''}`}
        autoPlay
        playsInline
        muted
        disablePictureInPicture
        onLoadedData={() => setHasFrame(true)}
        onResize={() => setHasFrame(true)}
        data-testid="remote-video"
      />
      {overlay}
      {viewer.peerOffline && viewer.status === 'streaming' && (
        <div className="stage-banner">
          <WifiOff size={14} /> {t.session.peerOffline}
        </div>
      )}
      {viewer.status === 'streaming' && !viewer.permissions.input && (
        <div className="stage-banner neutral" title={t.session.viewOnlyHint}>
          <Eye size={14} /> {t.session.viewOnly}
        </div>
      )}
      {focused && canInput && hasFrame && <div className="kbd-hint">{t.session.keyboardCaptured}</div>}
      {showStats && (
        <div className="stats-overlay" data-testid="stats-overlay">
          <StatRow label={t.session.latency} value={s.rttMs != null ? `${s.rttMs} ms` : '—'} />
          <StatRow label="Ping" value={s.pingMs != null ? `${s.pingMs} ms` : '—'} />
          <StatRow label={t.session.fpsShort} value={s.fps != null ? `${s.fps}${s.hostFps != null ? ` / ${s.hostFps}` : ''}` : '—'} />
          <StatRow label={t.session.bitrate} value={s.bitrateKbps == null ? '—' : s.bitrateKbps < 1000 ? `${s.bitrateKbps} kbps` : `${(s.bitrateKbps / 1000).toFixed(2)} Mbps`} />
          <StatRow label={t.session.resolution} value={s.width ? `${s.width}×${s.height}` : '—'} />
          <StatRow label={t.session.route} value={s.route === 'relay' ? t.session.relay : s.route === 'p2p' ? t.session.p2p : '—'} />
          <StatRow label="Perda" value={s.packetLoss != null ? `${(s.packetLoss * 100).toFixed(1)}%` : '—'} />
          {s.encodeMs != null && <StatRow label="Encode" value={`${s.encodeMs.toFixed?.(1) ?? s.encodeMs} ms`} />}
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <strong className="tabular">{value}</strong>
    </div>
  );
}

function StageMessage({ icon, title, hint, spinner }: { icon: ReactNode; title: string; hint?: string; spinner?: boolean }) {
  return (
    <div className="stage-msg">
      <div className="stage-msg-icon">
        {icon}
        {spinner && <Loader2 className="stage-spinner spin" />}
      </div>
      <div className="stage-msg-title">{title}</div>
      {hint && <div className="stage-msg-hint">{hint}</div>}
    </div>
  );
}

function AuthOverlay({ viewer }: { viewer: ViewerState }) {
  const [pw, setPw] = useState('');
  const blocked = viewer.authError === 'blocked';
  const left = viewer.authError?.startsWith('left:') ? viewer.authError.slice(5) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pw || blocked) return;
    controller.viewer?.authenticate(pw);
    setPw('');
  };
  return (
    <div className="stage-msg">
      <form className="auth-card" onSubmit={submit} onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <div className="auth-icon">{blocked ? <MonitorOff /> : <KeyRound />}</div>
        <div className="stage-msg-title">{t.session.authTitle}</div>
        <div className="stage-msg-hint">{blocked ? t.session.authBlocked : t.session.authHint}</div>
        {!blocked && (
          <>
            <input
              className={`input${left != null ? ' invalid' : ''}`}
              type="password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder={t.home.password}
              data-testid="password-input"
            />
            {left != null && <div className="field-error">{t.session.authFailed(left === '' ? undefined : Number(left))}</div>}
            <button className="btn btn-gradient btn-block" type="submit" disabled={!pw || viewer.authBusy} data-testid="auth-submit">
              {viewer.authBusy ? <Loader2 className="spin" /> : null}
              {t.session.authSubmit}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
