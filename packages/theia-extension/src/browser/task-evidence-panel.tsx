import React from '@theia/core/shared/react';
import { Call, Perform, Heading } from './shared.js';
import { Run } from '../common/protocol.js';
import { useProjectDraft } from './use-project-draft.js';

const initial = {
  id: '',
  revision: '',
  title: 'New evidence task',
  plan: '',
  planReviewed: 'false',
  criteria: '',
  sourceFiles: '',
  runIds: '',
  evalGates: '[]',
  sandboxIds: '',
  findings: '[]',
  newSourceCheckpoint: 'false',
};
type Form = typeof initial;
const lines = (text: string) =>
  text
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
const body = (form: Form) => ({
  title: form.title.trim(),
  plan: form.plan,
  planReviewed: form.planReviewed === 'true',
  criteria: lines(form.criteria),
  sourceFiles: lines(form.sourceFiles),
  runIds: lines(form.runIds),
  evalGates: JSON.parse(form.evalGates),
  sandboxIds: lines(form.sandboxIds),
  findings: JSON.parse(form.findings),
});
const formFor = (task: any): Form => ({
  id: task.id,
  revision: task.revision,
  title: task.body.title,
  plan: task.body.plan,
  planReviewed: String(task.body.planReviewed),
  criteria: task.body.criteria.join('\n'),
  sourceFiles: task.body.sourceFiles.join('\n'),
  runIds: task.body.runIds.join('\n'),
  evalGates: JSON.stringify(task.body.evalGates, null, 2),
  sandboxIds: task.body.sandboxIds.join('\n'),
  findings: JSON.stringify(task.body.findings, null, 2),
  newSourceCheckpoint: 'false',
});

export function TaskEvidencePanel({
  runs,
  call,
  perform,
}: {
  runs: Run[];
  call: Call;
  perform: Perform;
}) {
  const [draft, setDraft, draftError] = useProjectDraft(
    call,
    'task-evidence',
    initial,
  );
  const [tasks, setTasks] = React.useState<any[]>([]),
    [current, setCurrent] = React.useState<any>(),
    [preview, setPreview] = React.useState<any>();
  const [busy, setBusy] = React.useState(false),
    [reviewed, setReviewed] = React.useState(false),
    [completeReviewed, setCompleteReviewed] = React.useState(false),
    [exported, setExported] = React.useState<any>(),
    [exportReviewed, setExportReviewed] = React.useState(false),
    [localError, setLocalError] = React.useState('');
  const [run, setRun] = React.useState(''),
    [evaluation, setEvaluation] = React.useState(''),
    [thresholds, setThresholds] = React.useState('{"exact_match":1}');
  let dirty = true;
  try {
    dirty =
      !current ||
      draft.id !== current.task.id ||
      draft.revision !== current.task.revision ||
      draft.newSourceCheckpoint === 'true' ||
      JSON.stringify(body(draft)) !== JSON.stringify(current.task.body);
  } catch {}
  const discardable =
    dirty &&
    (Boolean(draft.id) ||
      Object.keys(initial).some(
        (key) => draft[key as keyof Form] !== initial[key as keyof Form],
      ));
  const invalidate = () => {
    setPreview(undefined);
    setReviewed(false);
    setCompleteReviewed(false);
    setExported(undefined);
    setExportReviewed(false);
  };
  const update = (key: keyof Form, value: string) => {
    setDraft((old) => ({
      ...old,
      [key]: value,
      ...(key === 'plan' ? { planReviewed: 'false' } : {}),
    }));
    invalidate();
  };
  const request = () => ({
    ...body(draft),
    id: draft.id || null,
    revision: draft.revision || null,
    newSourceCheckpoint: draft.newSourceCheckpoint === 'true',
  });
  const loadList = async () => setTasks(await call('evidence.list'));
  const accept = async (value: any) => {
    setCurrent(value);
    setDraft(() => formFor(value.task));
    invalidate();
    await loadList();
  };
  const act = (action: () => Promise<void>) =>
    void perform(async () => {
      setBusy(true);
      try {
        await action();
        setLocalError('');
      } finally {
        setBusy(false);
      }
    });
  React.useEffect(() => {
    let active = true;
    void call('evidence.list')
      .then((value) => {
        if (active) setTasks(value);
      })
      .catch((error) => {
        if (active) setLocalError(String(error));
      });
    return () => {
      active = false;
    };
  }, [call]);
  React.useEffect(() => {
    let active = true;
    setCurrent(undefined);
    if (draft.id)
      void call('evidence.get', { id: draft.id })
        .then((value) => {
          if (active) setCurrent(value);
        })
        .catch((error) => {
          if (active) setLocalError(String(error));
        });
    return () => {
      active = false;
    };
  }, [call, draft.id]);
  const evaluations = runs.filter(
    (run) => (run.configuration as any)?.evaluation,
  );
  return (
    <>
      <Heading
        title="Task evidence"
        text="Keep a reviewed plan, findings, actual run/evaluation evidence and human completion review together. Export a portable JSON handoff."
      />
      {(draftError || localError) && (
        <p role="alert">{draftError || localError}</p>
      )}
      <section className="aiide-card">
        <label>
          Saved task
          <select
            value={draft.id}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              if (!id) return;
              if (
                discardable &&
                !window.confirm(
                  'Discard unsaved task form changes and load this saved task?',
                )
              )
                return;
              act(async () => accept(await call('evidence.get', { id })));
            }}
          >
            <option value="">Choose a saved task</option>
            {tasks.map((task) => (
              <option
                key={task.id}
                value={task.id}
                disabled={Boolean(task.error)}
              >
                {task.title}
                {task.previousCompletion ? ' · previously reviewed' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy}
          onClick={() => {
            if (
              discardable &&
              !window.confirm(
                'Discard unsaved task form changes and start a new task?',
              )
            )
              return;
            setDraft(() => initial);
            setCurrent(undefined);
            invalidate();
          }}
        >
          New task
        </button>
        <button
          disabled={busy || !draft.id}
          onClick={() =>
            act(async () =>
              accept(await call('evidence.get', { id: draft.id })),
            )
          }
        >
          Reload saved task (discard form draft)
        </button>
      </section>
      <div className="aiide-columns">
        <section className="aiide-card">
          <h3>Plan and completion criteria</h3>
          <label>
            Task title
            <input
              value={draft.title}
              maxLength={140}
              disabled={busy}
              onChange={(event) => update('title', event.target.value)}
            />
          </label>
          <label>
            Plan
            <textarea
              rows={6}
              value={draft.plan}
              maxLength={16000}
              disabled={busy}
              onChange={(event) => update('plan', event.target.value)}
            />
          </label>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={draft.planReviewed === 'true'}
              disabled={busy}
              onChange={(event) =>
                update('planReviewed', String(event.target.checked))
              }
            />
            I reviewed this plan; generated text is a proposal until reviewed.
          </label>
          <label>
            Completion criteria, one per line
            <textarea
              rows={3}
              value={draft.criteria}
              disabled={busy}
              onChange={(event) => update('criteria', event.target.value)}
            />
          </label>
          <label>
            Reviewed source files, one workspace path per line
            <textarea
              rows={3}
              value={draft.sourceFiles}
              disabled={busy}
              onChange={(event) => update('sourceFiles', event.target.value)}
            />
          </label>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={draft.newSourceCheckpoint === 'true'}
              disabled={busy}
              onChange={(event) =>
                update('newSourceCheckpoint', String(event.target.checked))
              }
            />
            Capture a new launch checkpoint before the next verification run
          </label>
          <p>
            Freshness checks cover the selected files only. Host run launch
            fingerprints must match the saved checkpoint. Save the checkpoint
            before running verification; ordinary edits/linking preserve it.
            Unselected dependencies and criterion meaning still need human
            review.
          </p>
          <label>
            Review findings (JSON array)
            <textarea
              rows={6}
              value={draft.findings}
              disabled={busy}
              onChange={(event) => update('findings', event.target.value)}
              placeholder={
                '[{"id":"review-1","level":"blocking","text":"Investigate failure","resolved":false,"resolution":""}]'
              }
            />
          </label>
          <p>
            Findings use id, level (blocking/warning/info), text, resolved and
            resolution. Resolving a finding requires a written reason;
            unresolved blocking findings prevent completion.
          </p>
        </section>
        <section className="aiide-card">
          <h3>Link recorded evidence</h3>
          <label>
            Recorded run to link
            <select
              value={run}
              disabled={busy}
              onChange={(event) => setRun(event.target.value)}
            >
              <option value="">Choose an actual recorded run</option>
              {runs
                .filter((run) => !(run.configuration as any)?.evaluation)
                .map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.name} · {run.status}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={busy || !run}
            onClick={() =>
              update(
                'runIds',
                [...new Set([...lines(draft.runIds), run])].join('\n'),
              )
            }
          >
            Link recorded run
          </button>
          <label>
            Recorded run IDs
            <textarea
              rows={3}
              value={draft.runIds}
              disabled={busy}
              onChange={(event) => update('runIds', event.target.value)}
            />
          </label>
          <label>
            Evaluation to link
            <select
              value={evaluation}
              disabled={busy}
              onChange={(event) => {
                setEvaluation(event.target.value);
                const metadata = (
                  evaluations.find((run) => run.id === event.target.value)
                    ?.configuration as any
                )?.evaluation;
                setThresholds(
                  JSON.stringify({
                    [metadata?.scorers?.[0] || 'exact_match']: 1,
                  }),
                );
              }}
            >
              <option value="">Choose an actual evaluation</option>
              {evaluations.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name} · {run.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Evaluation minimum means (JSON)
            <input
              value={thresholds}
              disabled={busy}
              onChange={(event) => setThresholds(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !evaluation}
            onClick={() =>
              act(async () => {
                const existing = JSON.parse(draft.evalGates);
                update(
                  'evalGates',
                  JSON.stringify(
                    [
                      ...existing.filter(
                        (gate: any) => gate.runId !== evaluation,
                      ),
                      {
                        runId: evaluation,
                        thresholds: JSON.parse(thresholds),
                        maxErrors: 0,
                        maxRegression: 0,
                      },
                    ],
                    null,
                    2,
                  ),
                );
              })
            }
          >
            Link evaluation gate
          </button>
          <label>
            Evaluation gates (JSON array)
            <textarea
              rows={5}
              value={draft.evalGates}
              disabled={busy}
              onChange={(event) => update('evalGates', event.target.value)}
            />
          </label>
          <label>
            Sandbox session IDs, one per line
            <textarea
              rows={2}
              value={draft.sandboxIds}
              disabled={busy}
              onChange={(event) => update('sandboxIds', event.target.value)}
            />
          </label>
          <p>
            Sandbox links prove audited command exit only. They do not certify
            that staged sources match this task checkpoint. Inspect/apply the
            sandbox diff separately. A zero exit code alone does not establish
            that a completion criterion was met.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                setPreview(await call('evidence.preview', request()));
                setReviewed(false);
              })
            }
          >
            Preview task checkpoint
          </button>
          {preview && (
            <>
              <p>
                Launch checkpoint:{' '}
                <code>
                  {preview.fingerprint ||
                    'Unavailable; recorded host run source matching will fail'}
                </code>
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
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I reviewed this record, source selection and evidence
                references.
              </label>
              <button
                disabled={busy || !reviewed}
                onClick={() =>
                  act(async () =>
                    accept(
                      await call('evidence.save', {
                        ...request(),
                        reviewHash: preview.reviewHash,
                        confirmed: true,
                      }),
                    ),
                  )
                }
              >
                Save task checkpoint
              </button>
            </>
          )}
        </section>
      </div>
      {current && (
        <section className="aiide-card">
          <h3>Evidence and human completion review</h3>
          {dirty && (
            <p role="status">
              Unsaved form changes: save a reviewed checkpoint before completion
              or export.
            </p>
          )}
          <p role="status">
            Task status: {current.report.status}. Evidence rules:{' '}
            {current.report.ready ? 'pass' : 'blocked'}.
          </p>
          <p>{current.report.criteriaReview}</p>
          <button
            disabled={busy}
            onClick={() =>
              act(async () => {
                setCurrent(await call('evidence.get', { id: current.task.id }));
                setCompleteReviewed(false);
                setExported(undefined);
              })
            }
          >
            Refresh recorded evidence
          </button>
          <ul>
            {current.report.reasons.map((reason: string) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <details>
            <summary>Recorded evidence details</summary>
            <pre tabIndex={0}>{JSON.stringify(current.report, null, 2)}</pre>
          </details>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={completeReviewed}
              disabled={busy || dirty || !current.report.ready}
              onChange={(event) => setCompleteReviewed(event.target.checked)}
            />
            I reviewed the linked evidence, source coverage, findings and each
            completion criterion.
          </label>
          <button
            disabled={
              busy || dirty || !completeReviewed || !current.report.ready
            }
            onClick={() =>
              act(async () =>
                accept(
                  await call('evidence.complete', {
                    id: current.task.id,
                    revision: current.task.revision,
                    reviewHash: current.report.reviewHash,
                    confirmed: true,
                  }),
                ),
              )
            }
          >
            Record reviewed completion
          </button>
          <button
            disabled={busy || dirty}
            onClick={() =>
              act(async () => {
                setExported(
                  await call('evidence.exportPreview', { id: current.task.id }),
                );
                setExportReviewed(false);
              })
            }
          >
            Preview evidence export
          </button>
          {exported && (
            <>
              <p>
                The export contains your plan, findings, paths and evidence
                facts. Known credential patterns are redacted; inspect the
                complete JSON before sharing. It never executes commands or
                includes model outputs, source bodies or credentials
                automatically.
              </p>
              <pre tabIndex={0}>{exported.content}</pre>
              <label className="aiide-checkbox">
                <input
                  type="checkbox"
                  checked={exportReviewed}
                  disabled={busy || dirty}
                  onChange={(event) => setExportReviewed(event.target.checked)}
                />
                I reviewed this JSON artifact for sharing.
              </label>
              <button
                disabled={busy || dirty || !exportReviewed}
                onClick={() =>
                  act(async () => {
                    const value = await call('evidence.export', {
                      id: current.task.id,
                      revision: exported.revision,
                      reviewHash: exported.reviewHash,
                      confirmed: true,
                    });
                    const url = URL.createObjectURL(
                        new Blob([value.content], { type: 'application/json' }),
                      ),
                      link = document.createElement('a');
                    link.href = url;
                    link.download = value.filename;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  })
                }
              >
                Download reviewed evidence JSON
              </button>
            </>
          )}
          <button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  'Delete only this task record? Linked source, runs, evaluations and downloaded exports remain.',
                )
              )
                return;
              act(async () => {
                await call('evidence.delete', {
                  id: current.task.id,
                  revision: current.task.revision,
                  confirmed: true,
                });
                setDraft(() => initial);
                setCurrent(undefined);
                invalidate();
                await loadList();
              });
            }}
          >
            Delete task record
          </button>
        </section>
      )}
    </>
  );
}
