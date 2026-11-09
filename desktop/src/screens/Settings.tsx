import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Cpu,
  Gauge,
  Info,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Volume2,
  X,
  Download,
  ShieldCheck,
  Link2,
} from 'lucide-react';
import { t } from '../i18n';
import { digitsOnly, formatDateTime, formatId, isValidId } from '../lib/format';
import { platform } from '../platform';
import { controller } from '../session/controller';
import { forgetPeer } from '../session/trust';
import { notify, setApp, toast, useApp } from '../store/app';
import type { Permissions, QualityPreset, Settings } from '../net/protocol';
import type { AccountDevice, UserInfo } from '../net/api';
import { Avatar, Field, Segmented, Switch } from '../components/ui';
import logoUrl from '../assets/logo.svg';

type SectionId = 'general' | 'quality' | 'audio' | 'security' | 'devices' | 'account' | 'updates' | 'about';

const SECTIONS: { id: SectionId; icon: ReactNode }[] = [
  { id: 'general', icon: <SlidersHorizontal /> },
  { id: 'quality', icon: <Gauge /> },
  { id: 'audio', icon: <Volume2 /> },
  { id: 'security', icon: <Shield /> },
  { id: 'devices', icon: <ShieldCheck /> },
  { id: 'account', icon: <UserRound /> },
  { id: 'updates', icon: <Download /> },
  { id: 'about', icon: <Info /> },
];

function Row({ title, hint, children, stack }: { title: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row${stack ? ' stack' : ''}`}>
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <section className="card set-section" id={`set-${id}`} data-section={id}>
      <h2 className="set-section-title">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsScreen() {
  const settings = useApp((s) => s.settings);
  const [active, setActive] = useState<SectionId>('general');
  const scrollRef = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<Settings>) => void controller.updateSettings(patch);

  useEffect(() => {
    const root = scrollRef.current?.closest('.content');
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive((vis[0].target as HTMLElement).dataset.section as SectionId);
      },
      { root, rootMargin: '0px 0px -65% 0px' },
    );
    scrollRef.current?.querySelectorAll('[data-section]').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const go = (id: SectionId) => {
    setActive(id);
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="page settings" ref={scrollRef}>
      <nav className="set-nav" aria-label={t.settings.title}>
        {SECTIONS.map((s) => (
          <button key={s.id} className={`set-nav-item${active === s.id ? ' active' : ''}`} onClick={() => go(s.id)}>
            {s.icon}
            <span>{t.settings.sections[s.id]}</span>
          </button>
        ))}
      </nav>
      <div className="set-body">
        <GeneralSection settings={settings} update={update} />
        <Section id="quality" title={t.settings.sections.quality}>
          <Row title={t.settings.qualityPreset} hint={t.session.presetHints[settings.quality]} stack>
            <Segmented<QualityPreset>
              block
              value={settings.quality}
              onChange={(quality) => update({ quality })}
              options={(['auto', 'quality', 'balanced', 'speed'] as const).map((p) => ({ value: p, label: t.session.presets[p] }))}
            />
          </Row>
          <Row title={t.settings.fps}>
            <Segmented<number>
              value={settings.fps}
              onChange={(fps) => update({ fps })}
              options={[15, 30, 60].map((n) => ({ value: n, label: t.settings.fpsValue(n) }))}
            />
          </Row>
        </Section>
        <Section id="audio" title={t.settings.sections.audio}>
          <Row title={t.settings.audioEnabled} hint={t.settings.audioNote}>
            <Switch checked={false} disabled onChange={() => {}} label={t.settings.audioEnabled} />
          </Row>
        </Section>
        <SecuritySection settings={settings} update={update} />
        <DevicesSection settings={settings} update={update} />
        <AccountSection />
        <UpdatesSection settings={settings} update={update} />
        <Section id="about" title={t.settings.sections.about}>
          <div className="about">
            <img src={logoUrl} width={56} height={56} alt="" />
            <div>
              <div className="about-name">{t.app.name}</div>
              <div className="subtle">{t.app.tagline}</div>
            </div>
          </div>
          <Row title={t.settings.version}>
            <span className="tabular muted">{controller.version}</span>
          </Row>
          <Row title={t.settings.platform}>
            <span className="muted">
              {platform.kind === 'tauri' ? 'Desktop' : 'Web'} · {controller.osName || '—'}
            </span>
          </Row>
          <p className="about-text">{t.settings.aboutText}</p>
          <p className="about-text">{t.settings.privacy}</p>
        </Section>
      </div>
    </div>
  );
}

function GeneralSection({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [name, setName] = useState(settings.deviceName);
  const [server, setServer] = useState(settings.serverUrl);
  const [autostart, setAutostart] = useState(settings.launchOnStartup);
  useEffect(() => setServer(settings.serverUrl), [settings.serverUrl]);
  useEffect(() => {
    if (platform.canHost) platform.getAutostart().then(setAutostart).catch(() => {});
  }, []);
  const serverValid = useMemo(() => {
    try {
      const u = new URL(server);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, [server]);

  return (
    <Section id="general" title={t.settings.sections.general}>
      <Row title={t.settings.deviceName} hint={t.settings.deviceNameHint}>
        <input
          className="input"
          style={{ width: 240 }}
          value={name}
          placeholder={controller.deviceName}
          onChange={(e) => setName(e.target.value.slice(0, 64))}
          onBlur={() => name !== settings.deviceName && update({ deviceName: name.trim() })}
          data-testid="setting-device-name"
        />
      </Row>
      <Row title={t.settings.serverUrl} hint={t.settings.serverUrlHint} stack>
        <div className="inline-form">
          <input
            className={`input${serverValid ? '' : ' invalid'}`}
            value={server}
            onChange={(e) => setServer(e.target.value)}
            spellCheck={false}
            data-testid="setting-server-url"
          />
          <button
            className="btn btn-secondary"
            disabled={!serverValid || server === settings.serverUrl}
            onClick={() => {
              update({ serverUrl: server.trim().replace(/\/+$/, '') });
              toast('success', t.settings.saved);
            }}
            data-testid="setting-server-apply"
          >
            {t.settings.apply}
          </button>
        </div>
      </Row>
      <Row title={t.settings.theme}>
        <Segmented<Settings['theme']>
          value={settings.theme}
          onChange={(theme) => update({ theme })}
          options={(['system', 'light', 'dark'] as const).map((v) => ({ value: v, label: t.settings.themes[v] }))}
          testId="setting-theme"
        />
      </Row>
      <Row title={t.settings.launchOnStartup} hint={platform.canHost ? t.settings.launchOnStartupHint : t.settings.desktopOnly}>
        <Switch
          checked={autostart}
          disabled={!platform.canHost}
          label={t.settings.launchOnStartup}
          onChange={async (v) => {
            try {
              await platform.setAutostart(v);
              setAutostart(v);
              update({ launchOnStartup: v });
            } catch (e) {
              notify('error', t.errors.generic, String(e));
            }
          }}
        />
      </Row>
    </Section>
  );
}

function strength(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, Math.max(pw.length >= 8 ? 1 : 0, s - 1));
}

function SecuritySection({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const u = settings.unattended;
  const canHost = platform.canHost;
  const s = strength(pw);
  const err = pw && pw.length < 8 ? t.settings.passwordTooShort : pw2 && pw !== pw2 ? t.settings.passwordMismatch : null;
  const setPerm = (k: keyof Permissions, v: boolean) => update({ defaultPermissions: { ...settings.defaultPermissions, [k]: v } });

  const savePw = async () => {
    if (err || pw.length < 8 || pw !== pw2) return;
    setBusy(true);
    try {
      await platform.setUnattendedPassword(pw);
      const fresh = await platform.loadSettings();
      setApp((st) => ({ settings: { ...st.settings, unattended: fresh.unattended } }));
      setPw('');
      setPw2('');
      setEditing(false);
      toast('success', t.settings.passwordSaved);
    } catch (e) {
      notify('error', t.errors.generic, String(e));
    } finally {
      setBusy(false);
    }
  };
  const removePw = async () => {
    setBusy(true);
    try {
      await platform.clearUnattendedPassword();
      update({ unattended: { ...u, enabled: false, hasPassword: false } });
      toast('info', t.settings.passwordRemoved);
    } catch (e) {
      notify('error', t.errors.generic, String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="security" title={t.settings.sections.security}>
      <div className="set-group-label">{t.settings.defaultPerms}</div>
      <Row title={t.settings.permInput}>
        <Switch checked={settings.defaultPermissions.input} onChange={(v) => setPerm('input', v)} label={t.settings.permInput} />
      </Row>
      <Row title={t.settings.permFiles}>
        <Switch checked={settings.defaultPermissions.files} onChange={(v) => setPerm('files', v)} label={t.settings.permFiles} />
      </Row>
      <Row title={t.settings.permChat}>
        <Switch checked={settings.defaultPermissions.chat} onChange={(v) => setPerm('chat', v)} label={t.settings.permChat} />
      </Row>
      <div className="set-divider" />
      <Row
        title={
          <span className="row-title-icon">
            <KeyRound /> {t.settings.unattended}
          </span>
        }
        hint={!canHost ? t.settings.desktopOnly : u.hasPassword ? t.settings.unattendedHint : t.settings.unattendedNeedsPassword}
      >
        <Switch
          checked={u.enabled}
          disabled={!canHost || !u.hasPassword}
          onChange={(enabled) => update({ unattended: { ...u, enabled } })}
          label={t.settings.unattended}
          testId="setting-unattended"
        />
      </Row>
      {canHost && (
        <div className="pw-box">
          <div className="pw-status">
            <span className={`badge ${u.hasPassword ? 'success' : ''}`}>
              {u.hasPassword ? t.settings.passwordSet : t.settings.passwordNotSet}
            </span>
            <span style={{ flex: 1 }} />
            {!editing && (
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
                {u.hasPassword ? t.settings.changePassword : t.settings.setPassword}
              </button>
            )}
            {!editing && u.hasPassword && (
              <button className="btn btn-danger-soft btn-sm" onClick={removePw} disabled={busy}>
                {t.settings.removePassword}
              </button>
            )}
          </div>
          {editing && (
            <div className="pw-form">
              <Field label={t.settings.newPassword}>
                <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
              </Field>
              <div className={`strength s${s}`}>
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className={i < s ? 'on' : ''} />
                ))}
                <em>{pw ? t.settings.strength[s] : ''}</em>
              </div>
              <Field label={t.settings.confirmPassword} error={err}>
                <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
              </Field>
              <div className="pw-actions">
                <button className="btn btn-ghost" onClick={() => (setEditing(false), setPw(''), setPw2(''))}>
                  {t.common.cancel}
                </button>
                <button className="btn btn-primary" onClick={savePw} disabled={busy || !!err || pw.length < 8 || pw !== pw2}>
                  {t.common.save}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="set-divider" />
      <Row title={t.settings.trustedKeys} hint={t.settings.trustedKeysHint} stack>
        <TrustedKeys settings={settings} />
      </Row>
    </Section>
  );
}

function TrustedKeys({ settings }: { settings: Settings }) {
  const entries = Object.entries(settings.trustedKeys);
  if (entries.length === 0) return <div className="subtle small">{t.settings.noTrusted}</div>;
  return (
    <div className="key-list">
      {entries.map(([id, k]) => (
        <div className="key-item" key={id}>
          <Avatar seed={id} />
          <div className="key-info">
            <div className="recent-name">{k.name || formatId(id)}</div>
            <div className="recent-meta">
              <span className="tabular">{formatId(id)}</span> · <span className="mono">{k.fingerprint}</span>
            </div>
            {k.firstSeen && <div className="recent-meta">{formatDateTime(k.firstSeen)}</div>}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => void forgetPeer(id)}>
            {t.settings.forget}
          </button>
        </div>
      ))}
    </div>
  );
}

function DevicesSection({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [id, setId] = useState('');
  const ids = settings.unattended.allowedDeviceIds;
  const valid = isValidId(id);
  const add = () => {
    const d = digitsOnly(id);
    if (!valid || ids.includes(d)) return;
    update({ unattended: { ...settings.unattended, allowedDeviceIds: [...ids, d] } });
    setId('');
  };
  return (
    <Section id="devices" title={t.settings.sections.devices}>
      <Row title={t.settings.allowedIds} hint={t.settings.allowedIdsHint} stack>
        <div className="inline-form">
          <input
            className="input tabular"
            placeholder="000 000 000"
            value={formatId(id)}
            onChange={(e) => setId(digitsOnly(e.target.value).slice(0, 9))}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            disabled={!platform.canHost}
          />
          <button className="btn btn-secondary" onClick={add} disabled={!valid || !platform.canHost}>
            <Plus /> {t.settings.addId}
          </button>
        </div>
        {ids.length > 0 && (
          <div className="chips">
            {ids.map((d) => (
              <span className="chip tabular" key={d}>
                {formatId(d)}
                <button
                  aria-label={`Remover ${d}`}
                  onClick={() => update({ unattended: { ...settings.unattended, allowedDeviceIds: ids.filter((x) => x !== d) } })}
                >
                  <X />
                </button>
              </span>
            ))}
          </div>
        )}
      </Row>
    </Section>
  );
}

const USER_TOKEN_KEY = 'nexo.userToken.v1';

function AccountSection() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AccountDevice[] | null>(null);
  const deviceId = useApp((s) => s.deviceId);

  const refreshDevices = async () => {
    try {
      setDevices((await controller.api.accountDevices()).devices);
    } catch {
      setDevices([]);
    }
  };

  useEffect(() => {
    const tok = localStorage.getItem(USER_TOKEN_KEY);
    if (!tok) return;
    controller.api.userToken = tok;
    controller.api
      .me()
      .then((r) => {
        setUser(r.user);
        void refreshDevices();
      })
      .catch(() => {
        localStorage.removeItem(USER_TOKEN_KEY);
        controller.api.userToken = null;
      });
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r =
        mode === 'login'
          ? await controller.api.login(email.trim(), password)
          : await controller.api.registerUser(email.trim(), password, displayName.trim() || email.split('@')[0]);
      localStorage.setItem(USER_TOKEN_KEY, r.token);
      setUser(r.user);
      setPassword('');
      void refreshDevices();
    } catch (e) {
      const msg = (e as Error).message;
      setError((e as { status?: number }).status === 429 ? t.errors.RATE_LIMITED : msg || t.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    localStorage.removeItem(USER_TOKEN_KEY);
    controller.api.userToken = null;
    setUser(null);
    setDevices(null);
  };

  const linked = devices?.some((d) => d.deviceId === deviceId);

  return (
    <Section id="account" title={t.settings.sections.account}>
      {!user ? (
        <>
          <p className="set-row-hint" style={{ marginBottom: 14 }}>
            {t.settings.accountHint}
          </p>
          <div className="account-form">
            {mode === 'register' && (
              <Field label={t.settings.displayName}>
                <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
            )}
            <Field label={t.settings.email}>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </Field>
            <Field label={t.settings.password} error={error}>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
              />
            </Field>
            <div className="pw-actions">
              <button className="btn btn-ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? t.settings.noAccount : t.settings.haveAccount}
              </button>
              <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !email || password.length < (mode === 'register' ? 10 : 1)}>
                {mode === 'login' ? t.settings.login : t.settings.register}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="account-user">
            <span className="avatar" style={{ background: 'var(--brand-grad)' }}>
              {(user.displayName || user.email).slice(0, 1).toUpperCase()}
            </span>
            <div style={{ flex: 1 }}>
              <div className="recent-name">{user.displayName}</div>
              <div className="recent-meta">{user.email}</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={logout}>
              <LogOut /> {t.settings.logout}
            </button>
          </div>
          <Row title={t.settings.linkDevice} hint={linked ? t.settings.linked : undefined}>
            <button
              className="btn btn-secondary btn-sm"
              disabled={!!linked || !deviceId}
              onClick={async () => {
                try {
                  await controller.api.linkDevice();
                  toast('success', t.settings.linked);
                  void refreshDevices();
                } catch (e) {
                  notify('error', t.errors.generic, (e as Error).message);
                }
              }}
            >
              <Link2 /> {linked ? t.settings.linked : t.settings.linkDevice}
            </button>
          </Row>
          <div className="set-group-label">{t.settings.myDevices}</div>
          <div className="key-list">
            {(devices ?? []).map((d) => (
              <div className="key-item" key={d.deviceId}>
                <Avatar seed={d.deviceId} os={d.os} />
                <div className="key-info">
                  <div className="recent-name">
                    {d.name} {d.deviceId === deviceId && <span className="badge brand">{t.common.you}</span>}
                  </div>
                  <div className="recent-meta tabular">
                    {formatId(d.deviceId)} · {d.online ? t.status.online : t.status.offline}
                  </div>
                </div>
                <button
                  className="icon-btn sm"
                  title={t.settings.unlink}
                  aria-label={t.settings.unlink}
                  onClick={async () => {
                    await controller.api.unlinkDevice(d.deviceId).catch(() => {});
                    void refreshDevices();
                  }}
                >
                  <Trash2 />
                </button>
              </div>
            ))}
            {devices && devices.length === 0 && <div className="subtle small">—</div>}
          </div>
        </>
      )}
    </Section>
  );
}

function UpdatesSection({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [state, setState] = useState<{ checking: boolean; msg: string | null; install?: () => Promise<void> }>({ checking: false, msg: null });
  const check = async () => {
    setState({ checking: true, msg: null });
    try {
      const r = await platform.checkUpdate();
      if (r.available) setState({ checking: false, msg: t.settings.updateAvailable(r.version ?? ''), install: r.install });
      else setState({ checking: false, msg: platform.kind === 'web' ? t.settings.desktopOnly : t.settings.upToDate });
    } catch {
      setState({ checking: false, msg: t.settings.updaterUnavailable });
    }
  };
  return (
    <Section id="updates" title={t.settings.sections.updates}>
      <Row title={t.settings.autoUpdate}>
        <Switch checked={settings.autoUpdate} onChange={(autoUpdate) => update({ autoUpdate })} label={t.settings.autoUpdate} />
      </Row>
      <Row title={t.settings.checkUpdates} hint={state.msg ?? undefined}>
        <div style={{ display: 'flex', gap: 8 }}>
          {state.install && (
            <button className="btn btn-primary btn-sm" onClick={() => void state.install!()}>
              <Cpu /> {t.settings.installUpdate}
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => void check()} disabled={state.checking}>
            <RefreshCw className={state.checking ? 'spin' : ''} /> {t.settings.checkUpdates}
          </button>
        </div>
      </Row>
    </Section>
  );
}

