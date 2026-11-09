import { isPublicServer } from '../net/protocol';
import { History as HistoryIcon, House, Moon, Settings as SettingsIcon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { formatId } from '../lib/format';
import { controller } from '../session/controller';
import { setApp, useApp, type View } from '../store/app';
import { Logo } from '../components/ui';
import { StatusPill } from '../components/StatusPill';
import { NotificationsButton } from '../components/Notifications';
import { Home } from './Home';
import { HistoryScreen } from './History';
import { SettingsScreen } from './Settings';

const NAV: { view: View; label: string; icon: ReactNode }[] = [
  { view: 'home', label: t.nav.home, icon: <House /> },
  { view: 'history', label: t.nav.history, icon: <HistoryIcon /> },
  { view: 'settings', label: t.nav.settings, icon: <SettingsIcon /> },
];

const TITLES: Record<View, { title: string; sub: string }> = {
  home: { title: t.home.greeting, sub: t.home.subtitle },
  history: { title: t.history.title, sub: t.history.subtitle },
  settings: { title: t.settings.title, sub: t.settings.subtitle },
};

export function Shell() {
  const view = useApp((s) => s.view);
  const deviceId = useApp((s) => s.deviceId);
  const theme = useApp((s) => s.settings.theme);
  const host = useApp((s) => s.host);
  const serverError = useApp((s) => s.serverError);
  const conn = useApp((s) => s.conn);
  const resolvedDark = document.documentElement.dataset.theme === 'dark';
  const toggleTheme = () => void controller.updateSettings({ theme: resolvedDark ? 'light' : 'dark' });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo size={34} />
        </div>
        <nav className="nav" aria-label="Principal">
          {NAV.map((n) => (
            <button
              key={n.view}
              className={`nav-item${view === n.view ? ' active' : ''}`}
              onClick={() => setApp({ view: n.view })}
              aria-current={view === n.view ? 'page' : undefined}
              data-testid={`nav-${n.view}`}
              title={n.label}
            >
              {n.icon}
              <span>{n.label}</span>
              {n.view === 'home' && host && <span className="nav-live" title={t.hosting.active} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-device">
            <div className="sidebar-device-label">{t.home.yourId}</div>
            <div className="sidebar-device-id tabular">{deviceId ? formatId(deviceId) : '— — —'}</div>
          </div>
          <StatusPill />
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-title" key={view}>
            <h1>{TITLES[view].title}</h1>
            <p>{TITLES[view].sub}</p>
          </div>
          <div className="topbar-actions">
            <button className="icon-btn" onClick={toggleTheme} title={t.settings.theme} aria-label={t.settings.theme} data-theme-setting={theme}>
              {resolvedDark ? <Sun /> : <Moon />}
            </button>
            <NotificationsButton />
          </div>
        </header>
        {serverError && conn !== 'online' && (
          <div className="banner warn" role="alert">
            <div>
              <strong>{t.status.serverUnreachable}</strong>
              <span>
                {serverError !== t.status.serverUnreachable ? `${serverError} · ` : ''}
                {(isPublicServer(useApp.getState().settings.serverUrl) ? t.status.serverUnreachablePublicHint : t.status.serverUnreachableHint)}
              </span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => controller.retry()} data-testid="retry-server">
              {t.status.retry}
            </button>
          </div>
        )}
        <div className="content" key={view}>
          {view === 'home' && <Home />}
          {view === 'history' && <HistoryScreen />}
          {view === 'settings' && <SettingsScreen />}
        </div>
      </main>
    </div>
  );
}
