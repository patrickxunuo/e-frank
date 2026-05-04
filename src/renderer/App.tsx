import { useState } from 'react';

const INITIAL_RESULT = 'Click Ping to test the IPC bridge.';
const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

export function App(): JSX.Element {
  const bridgeAvailable =
    typeof window !== 'undefined' && !!window.api && typeof window.api.ping === 'function';
  const [result, setResult] = useState<string>(bridgeAvailable ? INITIAL_RESULT : BRIDGE_UNAVAILABLE);
  const [pending, setPending] = useState<boolean>(false);

  const handlePing = async (): Promise<void> => {
    if (!bridgeAvailable) {
      setResult(BRIDGE_UNAVAILABLE);
      return;
    }

    setPending(true);
    try {
      const response = await window.api!.ping({ message: 'hello' });
      setResult(response.reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult('IPC error: ' + message);
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="app-shell">
      <div className="app-glow" aria-hidden="true" />
      <section className="app-card">
        <header className="app-header">
          <span className="app-eyebrow">e/monster · desktop</span>
          <h1 className="app-title" data-testid="app-title">
            e-frank
          </h1>
          <p className="app-subtitle" data-testid="app-subtitle">
            Desktop AI Ticket → PR Automation
          </p>
        </header>

        <div className="app-divider" aria-hidden="true" />

        <section className="app-ipc">
          <div className="app-ipc-label">
            <span className="app-ipc-dot" aria-hidden="true" />
            IPC bridge · <code>app:ping</code>
          </div>

          <button
            type="button"
            className="app-button"
            data-testid="ping-button"
            onClick={() => {
              void handlePing();
            }}
            disabled={pending || !bridgeAvailable}
            aria-disabled={pending || !bridgeAvailable}
          >
            {!bridgeAvailable ? 'Bridge unavailable' : pending ? 'Pinging…' : 'Ping'}
          </button>

          <div className="app-result" data-testid="ping-result" role="status" aria-live="polite">
            {result}
          </div>
        </section>

        <footer className="app-footer">
          <span>v0.1.0 · scaffold</span>
          <span>main ↔ renderer ready</span>
        </footer>
      </section>
    </main>
  );
}

export default App;
