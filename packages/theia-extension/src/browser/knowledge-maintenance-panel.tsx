import React from '@theia/core/shared/react';
import type { Connection } from '../common/protocol.js';
import { Call, Perform, ConnectionSelect } from './shared.js';

const initial = {
  enabled: false,
  autoDrafts: false,
  model: '',
  intervalSeconds: 300,
  maxDraftsPerScan: 2,
  dailyDraftBudget: 10,
};

export function KnowledgeMaintenancePanel({
  call,
  perform,
  connections,
  disabled,
  changed,
  version,
  working,
}: {
  call: Call;
  perform: Perform;
  connections: Connection[];
  disabled: boolean;
  changed: () => Promise<void>;
  version: number;
  working: boolean;
}) {
  const [config, setConfig] = React.useState(initial);
  const [status, setStatus] = React.useState<any>();
  const [proposals, setProposals] = React.useState<any[]>([]);
  const [reviewed, setReviewed] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const load = async (settings = false) => {
    const [next, pending] = await Promise.all([
      call('knowledge.maintenance'),
      call('knowledge.proposals'),
    ]);
    setStatus(next);
    setProposals(pending);
    if (settings) setConfig(next.config);
  };
  React.useEffect(() => {
    let active = true;
    void Promise.all([
      call('knowledge.maintenance'),
      call('knowledge.proposals'),
    ])
      .then(([next, pending]) => {
        if (active) {
          setStatus(next);
          if (version === 0) setConfig(next.config);
          setProposals(pending);
        }
      })
      .catch((failure) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
    };
  }, [call, version]);
  React.useEffect(() => {
    if (!status?.config.enabled && !status?.running) return;
    let active = true;
    const timer = setInterval(() => {
      void Promise.all([
        call('knowledge.maintenance'),
        call('knowledge.proposals'),
      ])
        .then(([next, pending]) => {
          if (active) {
            setStatus(next);
            setProposals(pending);
          }
        })
        .catch((failure) => {
          if (active) setError(String(failure));
        });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [call, status?.config.enabled, status?.running]);
  const run = (action: () => Promise<unknown>) =>
    void perform(async () => {
      setBusy(true);
      setError('');
      try {
        await action();
        await load();
        await changed();
      } finally {
        setBusy(false);
      }
    });
  return (
    <section className="aiide-card">
      <h3>Automatic memory maintenance</h3>
      <p>
        Scanning tracks changes to already linked workspace sources. Automatic
        drafting is a separate opt-in: selected source content and saved pages
        are sent to the chosen model. Every revision remains a proposal until
        you review and apply it.
      </p>
      <fieldset disabled={disabled || busy}>
        <label className="aiide-checkbox">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) =>
              setConfig((old) => ({
                ...old,
                enabled: event.target.checked,
                autoDrafts: event.target.checked && old.autoDrafts,
              }))
            }
          />
          Scan linked sources automatically
        </label>
        <label className="aiide-checkbox">
          <input
            type="checkbox"
            checked={config.autoDrafts}
            disabled={!config.enabled}
            onChange={(event) =>
              setConfig((old) => ({ ...old, autoDrafts: event.target.checked }))
            }
          />
          Generate review proposals automatically when sources change
        </label>
        <ConnectionSelect
          label="Maintenance model"
          connections={connections}
          value={config.model}
          set={(model) => setConfig((old) => ({ ...old, model }))}
          kind="model"
        />
        <div className="aiide-form-grid">
          <label>
            Scan interval (seconds)
            <input
              type="number"
              min={30}
              max={86400}
              value={config.intervalSeconds}
              onChange={(event) =>
                setConfig((old) => ({
                  ...old,
                  intervalSeconds: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Draft attempts per scan
            <input
              type="number"
              min={1}
              max={10}
              value={config.maxDraftsPerScan}
              onChange={(event) =>
                setConfig((old) => ({
                  ...old,
                  maxDraftsPerScan: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Draft attempts per UTC day
            <input
              type="number"
              min={1}
              max={100}
              value={config.dailyDraftBudget}
              onChange={(event) =>
                setConfig((old) => ({
                  ...old,
                  dailyDraftBudget: Number(event.target.value),
                }))
              }
            />
          </label>
        </div>
        <div className="aiide-toolbar">
          <button
            disabled={config.autoDrafts && !config.model}
            onClick={() =>
              run(async () => {
                const next = await call(
                  'knowledge.configureMaintenance',
                  config,
                );
                setConfig(next.config);
              })
            }
          >
            Save maintenance settings
          </button>
          <button
            disabled={status?.running}
            onClick={() => run(() => call('knowledge.scan'))}
          >
            Scan now
          </button>
          <button onClick={() => run(() => load())}>
            Refresh maintenance status
          </button>
        </div>
      </fieldset>
      <button
        disabled={!status?.running && !working && !busy}
        onClick={() => {
          void call('knowledge.cancel')
            .then(() => load())
            .catch((failure) => setError(String(failure)));
        }}
      >
        Cancel current scan or rebuild
      </button>
      {status && (
        <p role="status">
          {status.running
            ? 'Maintenance running'
            : status.config.enabled
              ? 'Automatic scanning enabled'
              : 'Automatic scanning off'}{' '}
          · {status.stale?.length || 0} stale page(s) · {status.drafts || 0}{' '}
          draft attempt(s) today · {proposals.length} pending proposal(s)
          {status.lastScan
            ? ` · last scan ${new Date(status.lastScan).toLocaleString()}`
            : ''}
        </p>
      )}
      {status?.errors?.map((message: string, index: number) => (
        <p key={index} role="alert">
          {message}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      <h4>Review proposed revisions</h4>
      {!proposals.length && (
        <p>
          No pending proposals. Rebuild a saved page or enable automatic drafts
          to create one.
        </p>
      )}
      {proposals.map((proposal) => (
        <details key={proposal.id}>
          <summary>
            {proposal.title} · {new Date(proposal.created).toLocaleString()} ·{' '}
            {proposal.conflicts.length} flagged conflict(s)
          </summary>
          <p>{proposal.summary}</p>
          <p className="aiide-note">
            A model may miss conflicts. Review the full draft and original
            sources even when no conflict was flagged. Applying rechecks source
            hashes and the original page revision.
          </p>
          {proposal.conflicts.map((conflict: any, index: number) => (
            <div key={index} role="note">
              <p>
                <strong>Existing:</strong> {conflict.existing}
              </p>
              <p>
                <strong>Proposed:</strong> {conflict.proposed}
              </p>
              <p>
                <strong>Source:</strong> {conflict.source}
              </p>
            </div>
          ))}
          <pre
            tabIndex={0}
            aria-label={`Proposed memory revision: ${proposal.title}`}
          >
            {proposal.body}
          </pre>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              disabled={disabled || busy}
              checked={Boolean(reviewed[proposal.id])}
              onChange={(event) =>
                setReviewed((old) => ({
                  ...old,
                  [proposal.id]: event.target.checked,
                }))
              }
            />
            I reviewed the draft, source citations, and flagged conflicts.
          </label>
          <button
            disabled={disabled || busy || !reviewed[proposal.id]}
            onClick={() =>
              run(() =>
                call('knowledge.applyProposal', {
                  id: proposal.id,
                  reviewed: true,
                }),
              )
            }
          >
            Apply reviewed revision
          </button>
          <button
            disabled={disabled || busy}
            onClick={() =>
              run(() => call('knowledge.discardProposal', { id: proposal.id }))
            }
          >
            Discard proposal
          </button>
        </details>
      ))}
    </section>
  );
}
