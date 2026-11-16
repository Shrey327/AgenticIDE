import React from '@theia/core/shared/react';
import { Call, Perform, Heading, Empty } from './shared.js';

export function SandboxPanel({
  call,
  perform,
}: {
  call: Call;
  perform: Perform;
}) {
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [selected, setSelected] = React.useState('');
  const [errors, setErrors] = React.useState<string[]>([]);
  const [command, setCommand] = React.useState('python --version');
  const [network, setNetwork] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [capabilities, setCapabilities] = React.useState<any>();
  const [engine, setEngine] = React.useState('docker');
  const [review, setReview] = React.useState<any>();
  const active = sessions.find((session) => session.id === selected);
  const load = React.useCallback(async () => {
    const result = await call('sandbox.sessions');
    setSessions(result.sessions);
    setErrors(result.recoveryErrors);
  }, [call]);
  React.useEffect(() => {
    let active = true;
    void perform(async () => {
      const result = await call('sandbox.capabilities');
      if (active) {
        setCapabilities(result);
        setEngine(result.policy.engine);
      }
    });
    return () => {
      active = false;
    };
  }, [call]);
  React.useEffect(() => {
    let mounted = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await call('sandbox.sessions');
        if (mounted) {
          setSessions(result.sessions);
          setErrors(result.recoveryErrors);
        }
      } catch (error) {
        if (mounted) setErrors([String(error)]);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [call]);
  const act = (action: () => Promise<void>) =>
    void perform(async () => {
      setBusy(true);
      try {
        await action();
        await load();
      } finally {
        setBusy(false);
      }
    });
  return (
    <>
      <Heading
        title="Agent sandboxes"
        text="Run and review isolated source changes. Staged files survive IDE restarts; commands never resume automatically."
      />
      {!!errors.length && (
        <div role="alert">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      <section className="aiide-card">
        <h3>Isolation policy</h3>
        <label>
          Sandbox isolation policy
          <select
            value={engine}
            disabled={busy}
            onChange={(event) => setEngine(event.target.value)}
          >
            <option value="docker">Docker container</option>
            <option value="apple-vm">
              Dedicated VM per command (Apple Silicon macOS 26)
            </option>
          </select>
        </label>
        <p role="status">
          Saved policy:{' '}
          {capabilities?.policy.engine === 'apple-vm'
            ? 'dedicated VM required'
            : 'Docker container'}{' '}
          · dedicated VM{' '}
          {capabilities?.apple.available ? 'available' : 'unavailable'}
        </p>
        {capabilities && engine !== capabilities.policy.engine && (
          <p role="status">
            Save the isolation choice before creating or executing a sandbox.
          </p>
        )}
        {engine === 'apple-vm' && !capabilities?.apple.available && (
          <p>{capabilities?.apple.setup || 'Checking Apple Container…'}</p>
        )}
        <p>
          Saving the VM policy applies to IDE and external-agent sandbox
          commands. It refuses weaker existing sessions and never falls back
          when the VM runtime is unavailable. Only the staged source folder is
          shared with a VM.
        </p>
        <button
          disabled={busy || !capabilities}
          onClick={() =>
            act(async () => {
              await call('sandbox.configure', { engine });
              setCapabilities(await call('sandbox.capabilities'));
            })
          }
        >
          Save isolation policy
        </button>
        <button
          disabled={busy}
          onClick={() =>
            act(async () => setCapabilities(await call('sandbox.capabilities')))
          }
        >
          Recheck runtimes
        </button>
        <p>
          Containers run without host credentials, root privileges, or network
          by default. Limits: 1 GB RAM, 2 CPUs, 128 processes, and two minutes
          per command. The selected runtime is required. Stage storage has a
          monitored 2 GB budget.
        </p>
        {engine === 'apple-vm' && (
          <p>
            These are workload limits. A VM also uses additional CPU and memory
            for its operating system.
          </p>
        )}
        <button
          disabled={
            busy || !capabilities || engine !== capabilities.policy.engine
          }
          onClick={() =>
            act(async () => {
              const session = await call('sandbox.create');
              setSelected(session.id);
              setReview(undefined);
            })
          }
        >
          Create sandbox
        </button>
        {!sessions.length ? (
          <Empty>
            Create a sandbox to stage this project's source and run checks.
          </Empty>
        ) : (
          <label>
            Sandbox
            <select
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setReview(undefined);
              }}
              disabled={busy}
            >
              <option value="">Choose a sandbox</option>
              {sessions.map((session) => (
                <option value={session.id} key={session.id}>
                  {session.id.slice(0, 8)} ·{' '}
                  {session.engine === 'apple-vm' ? 'VM' : 'Docker'} ·{' '}
                  {session.status}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
      {active && (
        <>
          <section className="aiide-card">
            <h3>Run a check</h3>
            <p role="status" aria-label="Sandbox command status">
              {active.status} · {active.isolation} · locked environment{' '}
              {active.environmentReady ? 'installed' : 'not installed'}
            </p>
            <label>
              Container command
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={busy || active.status === 'running'}
              />
            </label>
            <label className="aiide-checkbox">
              <input
                type="checkbox"
                checked={network}
                onChange={(event) => setNetwork(event.target.checked)}
                disabled={busy}
              />
              Grant network for this command
            </label>
            <div className="aiide-toolbar">
              <button
                disabled={
                  busy ||
                  active.status === 'running' ||
                  !command.trim() ||
                  engine !== capabilities?.policy.engine
                }
                onClick={() =>
                  act(async () => {
                    const granted = network;
                    setNetwork(false);
                    setReview(undefined);
                    await call('sandbox.run', {
                      id: active.id,
                      command,
                      network: granted,
                    });
                  })
                }
              >
                Run in sandbox
              </button>
              <button
                disabled={!['running', 'preparing'].includes(active.status)}
                onClick={() =>
                  void perform(async () => {
                    await call('sandbox.cancel', { id: active.id });
                    await load();
                  })
                }
              >
                Cancel command
              </button>
              <button
                disabled={
                  busy ||
                  active.status === 'running' ||
                  engine !== capabilities?.policy.engine
                }
                onClick={() =>
                  act(async () => {
                    setReview(undefined);
                    await call('sandbox.prepare', { id: active.id });
                  })
                }
              >
                Install locked environment (network)
              </button>
            </div>
            <p className="aiide-note">
              Environment setup uses the staged uv.lock inside a container. It
              can download packages and run their build scripts there. Project
              code and the host environment stay separate. Later commands use
              the staged .venv with network disabled.
            </p>
            <pre className="aiide-terminal" aria-label="Sandbox output">
              {active.output || 'No output yet'}
            </pre>
          </section>
          <section className="aiide-card">
            <h3>Review staged changes</h3>
            <div className="aiide-toolbar">
              <button
                disabled={busy || active.status === 'running'}
                onClick={() =>
                  act(async () =>
                    setReview(await call('sandbox.diff', { id: active.id })),
                  )
                }
              >
                Review diff
              </button>
              <button
                disabled={busy || active.status === 'running'}
                onClick={() =>
                  act(async () => {
                    await call('sandbox.close', { id: active.id });
                    setSelected('');
                    setReview(undefined);
                  })
                }
              >
                Discard sandbox
              </button>
            </div>
            {review && (
              <>
                {!review.changes.length && <p>No source changes.</p>}
                {review.changes.map((change: any) => (
                  <details key={change.file} open>
                    <summary>{change.file}</summary>
                    <div className="aiide-columns">
                      <pre className="aiide-diff before">
                        {change.before ?? '(new file)'}
                      </pre>
                      <pre className="aiide-diff after">
                        {change.after ?? '(deleted)'}
                      </pre>
                    </div>
                  </details>
                ))}
                <button
                  disabled={busy || !review.changes.length}
                  onClick={() =>
                    act(async () => {
                      await call('sandbox.apply', {
                        id: active.id,
                        reviewHash: review.reviewHash,
                      });
                      setReview(undefined);
                    })
                  }
                >
                  Apply reviewed changes
                </button>
              </>
            )}
            <p className="aiide-note">
              Concurrent host edits block application. Recovered sandboxes are
              available only through this IDE until a new agent creates its own
              session. Discard removes staged files; ordinary shutdown preserves
              them.
            </p>
          </section>
        </>
      )}
    </>
  );
}
