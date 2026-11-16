import React from '@theia/core/shared/react';
import { Call, Perform } from './shared.js';

export function CustomRLPanel({
  call,
  perform,
  busy,
  setBusy,
  registered,
}: {
  call: Call;
  perform: Perform;
  busy: boolean;
  setBusy: (value: boolean) => void;
  registered: () => Promise<void>;
}) {
  const [id, setId] = React.useState('target');
  const [title, setTitle] = React.useState('Custom target environment');
  const [entrypoint, setEntrypoint] = React.useState('custom_target.py');
  const [factory, setFactory] = React.useState('make_env');
  const [files, setFiles] = React.useState('custom_target.py');
  const [parameters, setParameters] = React.useState(
    '{"continuous":false,"target":0.7}',
  );
  const [preview, setPreview] = React.useState<any>();
  const [confirmed, setConfirmed] = React.useState(false);
  const [saved, setSaved] = React.useState('');
  const [check, setCheck] = React.useState<any>();
  const reset = () => {
    setPreview(undefined);
    setConfirmed(false);
    setSaved('');
    setCheck(undefined);
  };
  const definition = () => ({
    id,
    title,
    entrypoint,
    factory,
    files: files
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    parameters: JSON.parse(parameters),
  });
  const act = (action: () => Promise<void>) =>
    void perform(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  return (
    <section className="aiide-card">
      <h3>Review a custom environment</h3>
      <p>
        Custom factories run trusted project Python with your account's
        privileges. Review every selected source and its imports. Fingerprints
        cover listed files; installed dependencies and other imported code
        retain normal project privileges. Registration itself never imports
        code.
      </p>
      <div className="aiide-form-grid">
        <label>
          Environment ID
          <input
            value={id}
            disabled={busy}
            onChange={(event) => {
              setId(event.target.value);
              reset();
            }}
          />
        </label>
        <label>
          Environment title
          <input
            value={title}
            disabled={busy}
            onChange={(event) => {
              setTitle(event.target.value);
              reset();
            }}
          />
        </label>
        <label>
          Factory source path
          <input
            value={entrypoint}
            disabled={busy}
            onChange={(event) => {
              setEntrypoint(event.target.value);
              reset();
            }}
          />
        </label>
        <label>
          Factory function
          <input
            value={factory}
            disabled={busy}
            onChange={(event) => {
              setFactory(event.target.value);
              reset();
            }}
          />
        </label>
      </div>
      <label>
        Reviewed Python sources, one workspace path per line
        <textarea
          rows={3}
          value={files}
          disabled={busy}
          onChange={(event) => {
            setFiles(event.target.value);
            reset();
          }}
        />
      </label>
      <label>
        Factory parameters (JSON object)
        <textarea
          rows={3}
          value={parameters}
          disabled={busy}
          onChange={(event) => {
            setParameters(event.target.value);
            reset();
          }}
        />
      </label>
      <p>
        Factory parameters are saved in registrations and policy metadata. Use
        environment variables for credentials.
      </p>
      <p>
        The RL template includes custom_target.py. Factories receive the
        parameter object and return a Gymnasium Env. Supported observations are
        flat floating-point Box vectors; PPO accepts zero-based Discrete or
        bounded Box actions, SAC requires Box actions.
      </p>
      <p>
        Reusing an ID replaces its registration. Older policies remain on disk
        and need their matching reviewed settings to resume or roll out. Use a
        new ID to keep parameter variants available together.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          act(async () => {
            setPreview(await call('rl.previewEnvironment', definition()));
            setConfirmed(false);
            setSaved('');
            setCheck(undefined);
          })
        }
      >
        Preview environment sources
      </button>
      {preview && (
        <>
          <p>
            Reviewed revision: <code>{preview.reviewHash}</code>
          </p>
          {preview.sources.map((source: any) => (
            <details key={source.file}>
              <summary>
                {source.file} · {source.sha256}
              </summary>
              <pre tabIndex={0}>{source.content}</pre>
            </details>
          ))}
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed these sources, factory parameters and imported code, and
            authorize local execution.
          </label>
          <button
            disabled={busy || !confirmed}
            onClick={() =>
              act(async () => {
                const result = await call('rl.registerEnvironment', {
                  ...definition(),
                  reviewHash: preview.reviewHash,
                  confirmed: true,
                });
                setSaved(result.id);
                await registered();
              })
            }
          >
            Register reviewed environment
          </button>
        </>
      )}
      {saved && (
        <>
          <p role="status">
            Registered custom:{saved}. Select it under Neural environment.
            Changed sources require a new review; saved policies retain their
            reviewed revision.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              act(async () =>
                setCheck(await call('rl.checkEnvironment', { id: saved })),
              )
            }
          >
            Check environment (executes project Python)
          </button>
        </>
      )}
      {check && (
        <p role="status">
          Gymnasium/SB3 check passed · {check.observation} · {check.action} ·{' '}
          {check.algorithms.join(', ')}
        </p>
      )}
    </section>
  );
}
