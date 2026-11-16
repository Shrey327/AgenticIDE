import React from '@theia/core/shared/react';
import { Call, Perform } from './shared.js';

export function EvalRegressionPanel({
  detail,
  current,
  experiments,
  dataset,
  call,
  perform,
  useDataset,
  exported,
}: {
  detail?: any;
  current?: any;
  experiments: any[];
  dataset: string;
  call: Call;
  perform: Perform;
  useDataset: (file: string) => void;
  exported: () => Promise<void>;
}) {
  const [versions, setVersions] = React.useState<any[]>([]);
  const [version, setVersion] = React.useState('');
  const [file, setFile] = React.useState('data/regression-case.jsonl');
  const [reference, setReference] = React.useState('');
  const [referenceKind, setReferenceKind] = React.useState('text');
  const [reviewed, setReviewed] = React.useState(false);
  const [thresholds, setThresholds] = React.useState('');
  const [baseline, setBaseline] = React.useState('');
  const [maxRegression, setMaxRegression] = React.useState(0);
  const [report, setReport] = React.useState<any>();
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState('');
  React.useEffect(() => {
    setReference(
      typeof current?.expected === 'string'
        ? current.expected
        : current?.expected === undefined
          ? ''
          : JSON.stringify(current.expected),
    );
    setReviewed(false);
    setReferenceKind(
      typeof current?.expected === 'object' && current?.expected?.name
        ? 'tool'
        : 'text',
    );
    setSaved('');
  }, [detail?.runId, current?.index]);
  React.useEffect(() => {
    setThresholds(
      detail?.scorers?.length
        ? JSON.stringify({ [detail.scorers[0].name]: 0.9 }, null, 2)
        : '{}',
    );
    setReport(undefined);
  }, [detail?.runId]);
  const run = (fn: () => Promise<void>) =>
    void perform(async () => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
      }
    });
  return (
    <section className="aiide-card">
      <h3>Version datasets and prevent regressions</h3>
      <p>
        Each new evaluation records an immutable normalized dataset snapshot and
        a configuration hash. References for new regression cases must be
        reviewed; generated answers are never accepted automatically.
      </p>
      <div className="aiide-toolbar">
        <button
          disabled={busy || !dataset}
          onClick={() =>
            run(async () => {
              await call('evals.snapshot', { dataset });
              setVersions(await call('evals.datasets'));
            })
          }
        >
          Snapshot selected dataset
        </button>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              setVersions(await call('evals.datasets'));
            })
          }
        >
          Browse dataset versions
        </button>
      </div>
      {!!versions.length && (
        <>
          <label>
            Immutable dataset version
            <select
              value={version}
              disabled={busy}
              onChange={(event) => setVersion(event.target.value)}
            >
              <option value="">Choose a snapshot</option>
              {versions.map((item) => (
                <option key={item.hash} value={item.file}>
                  {item.hash.slice(0, 12)} · {item.cases} case(s)
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || !version}
            onClick={() => useDataset(version)}
          >
            Use this dataset version
          </button>
        </>
      )}
      {detail?.datasetVersion && (
        <p>
          Current result dataset:{' '}
          <code title={detail.datasetVersion.hash}>
            {detail.datasetVersion.hash.slice(0, 16)}
          </code>{' '}
          · configuration:{' '}
          <code title={detail.configVersion}>
            {detail.configVersion?.slice(0, 16)}
          </code>
        </p>
      )}
      {current && (
        <details>
          <summary>Turn selected case into a regression test</summary>
          <label>
            New regression dataset file
            <input
              value={file}
              onChange={(event) => setFile(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Reference kind
            <select
              value={referenceKind}
              disabled={busy}
              onChange={(event) => {
                setReferenceKind(event.target.value);
                setReviewed(false);
              }}
            >
              <option value="text">Text or JSON answer</option>
              <option value="tool">Tool name or JSON name/arguments</option>
            </select>
          </label>
          <label>
            Reviewed reference answer
            <textarea
              rows={4}
              value={reference}
              maxLength={100000}
              disabled={busy}
              onChange={(event) => {
                setReference(event.target.value);
                setReviewed(false);
              }}
            />
          </label>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={busy}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I checked the input, tools and reference against the source.
          </label>
          <button
            disabled={busy || !reviewed || !file.trim()}
            onClick={() =>
              run(async () => {
                const result = await call('evals.exportCase', {
                  runId: detail.runId,
                  index: current.index,
                  file,
                  expected: reference,
                  referenceKind,
                  reviewed: true,
                });
                setSaved(result.file);
                setVersions(await call('evals.datasets'));
                await exported();
              })
            }
          >
            Export reviewed case
          </button>
          {saved && (
            <p role="status">
              Saved {saved}. Existing files are never replaced.
            </p>
          )}
        </details>
      )}
      {detail && (
        <details>
          <summary>Check a release gate</summary>
          <label>
            Minimum mean scores (JSON)
            <textarea
              rows={4}
              value={thresholds}
              disabled={busy}
              onChange={(event) => setThresholds(event.target.value)}
            />
          </label>
          <label>
            Baseline experiment
            <select
              value={baseline}
              disabled={busy}
              onChange={(event) => setBaseline(event.target.value)}
            >
              <option value="">Absolute thresholds only</option>
              {experiments
                .filter((item) => item.runId !== detail.runId)
                .map((item) => (
                  <option key={item.runId} value={item.runId}>
                    {item.name} · {item.target?.connection}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Allowed mean-score regression
            <input
              type="number"
              value={maxRegression}
              min={0}
              max={1}
              step={0.01}
              disabled={busy}
              onChange={(event) => setMaxRegression(Number(event.target.value))}
            />
          </label>
          <p>
            Pending, failed, incomplete or invalid scores fail the gate.
            Baseline comparisons require the same dataset version and scorer
            configuration. Default permitted case errors: zero.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                setReport(
                  await call('evals.gate', {
                    runId: detail.runId,
                    thresholds: JSON.parse(thresholds),
                    maxRegression,
                    ...(baseline && { baseline }),
                  }),
                );
              })
            }
          >
            Check regression gate
          </button>
          {report && (
            <div role="status">
              <strong>{report.passed ? 'Gate passed' : 'Gate failed'}</strong>
              {report.reasons.map((reason: string) => (
                <p key={reason}>{reason}</p>
              ))}
              <pre>{JSON.stringify(report.scores, null, 2)}</pre>
            </div>
          )}
          <p className="aiide-note">
            CI:{' '}
            <code>
              node scripts/eval-gate.mjs --result .aiide/evals/{detail.runId}
              .json --threshold scorer_name=0.9
            </code>
            . Exit status 0 passes, 1 fails the gate, and 2 means invalid input
            or arguments.
          </p>
        </details>
      )}
    </section>
  );
}
