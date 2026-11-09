import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/session.css';
import { App } from './App';
import { Indicator } from './screens/Indicator';
import { isTauri } from './platform';
import { applyTheme } from './theme';
import { platform } from './platform';

// Erros não tratados vão para o log do app (diagnóstico em computadores reais).
window.addEventListener('error', (e) => platform.log?.('error', `js: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => platform.log?.('error', `promise: ${String(e.reason)}`));

function isIndicatorWindow(): boolean {
  if (location.hash.startsWith('#/indicator')) return true;
  if (!isTauri) return false;
  try {
    const meta = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__?.metadata;
    return meta?.currentWindow?.label === 'indicator';
  } catch {
    return false;
  }
}

async function start() {
  applyTheme('system');
  const root = createRoot(document.getElementById('root')!);
  if (isIndicatorWindow()) {
    root.render(<Indicator />);
    return;
  }
  let demo = false;
  if (import.meta.env.DEV) {
    const flag = new URLSearchParams(location.search).get('demo');
    if (flag) {
      const { runDemo } = await import('./demo');
      runDemo(flag, new URLSearchParams(location.search).get('theme'));
      demo = true;
    }
  }
  root.render(
    <StrictMode>
      <App demo={demo} />
    </StrictMode>,
  );
}

void start();
