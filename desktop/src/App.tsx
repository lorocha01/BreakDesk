import { useEffect } from 'react';
import { useApp } from './store/app';
import { controller } from './session/controller';
import { Shell } from './screens/Shell';
import { SessionView } from './screens/SessionView';
import { IncomingModal, OutgoingModal, SecurityAlertModal } from './screens/Modals';
import { Toasts } from './components/Toasts';

export function App({ demo }: { demo?: boolean }) {
  const hasViewer = useApp((s) => !!s.viewer);
  const booted = useApp((s) => s.booted);

  useEffect(() => {
    if (!demo) void controller.boot();
  }, [demo]);

  // Keep the indicator window in sync with host state
  useEffect(() => useApp.subscribe((s, prev) => s.host !== prev.host && controller.host.pushIndicator()), []);

  if (!booted && !demo) {
    return (
      <div className="splash">
        <div className="splash-logo" />
      </div>
    );
  }

  return (
    <>
      {hasViewer ? <SessionView /> : <Shell />}
      <IncomingModal />
      <OutgoingModal />
      <SecurityAlertModal />
      <Toasts />
    </>
  );
}
