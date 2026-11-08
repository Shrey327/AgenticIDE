import React from '@theia/core/shared/react';
import { Call, Perform, Heading, Empty } from './shared.js';
import type { Run } from '../common/protocol.js';

export function FinetunePanel({
  call,
  perform,
  runs,
  select,
  refresh,
  openRun,
  openEvals,
}: {
  call: Call;
  perform: Perform;
  runs: Run[];
  select: (id: string) => void;
  openRun?: (id: string) => void;
  openEvals?: (model: string) => void;
  refresh: () => Promise<void>;
}) {
  const [status, setStatus] = React.useState<any>(),
    [models, setModels] = React.useState<any[]>([]),
    [files, setFiles] = React.useState<string[]>([]);
  const [repo, setRepo] = React.useState('Qwen/Qwen3-0.6B'),
    [revision, setRevision] = React.useState('main');
  const [model, setModel] = React.useState(''),
    [dataset, setDataset] = React.useState(''),
    [device, setDevice] = React.useState('auto');
  const [steps, setSteps] = React.useState(20),
    [length, setLength] = React.useState(256),
    [rank, setRank] = React.useState(8),
    [rate, setRate] = React.useState(0.0002),
    [batch, setBatch] = React.useState(1);
  const [prompt, setPrompt] = React.useState(
      'Explain what a classification model does in one sentence.',
    ),
    [tokens, setTokens] = React.useState(64);
  const [busy, setBusy] = React.useState(false),
    [resultFile, setResultFile] = React.useState(''),
    [result, setResult] = React.useState<any>();
  const [notice, setNotice] = React.useState('');
  const [setupRun, setSetupRun] = React.useState('');
  const [loadError, setLoadError] = React.useState('');
  const latestRuns = React.useRef(runs);
  latestRuns.current = runs;
  const generation = React.useRef(0);
  const checkEnvironment = React.useCallback(async () => {
    try {
      setStatus(await call('hf.status'));
    } catch (error) {
      setStatus({
        ready: false,
        missing: [],
        devices: ['cpu'],
        error: String(error),
      });
    }
  }, [call]);
  const reload = React.useCallback(async () => {
    const [m, f] = await Promise.all([call('hf.models'), call('hf.files')]);
    setModels(m);
    setFiles(f);
    setDataset(
      (current) =>
        current || (f.includes('data/train.jsonl') ? 'data/train.jsonl' : ''),
    );
  }, [call]);
  const jobs = runs.filter((run) => run.name.startsWith('hf '));
  const running = jobs.filter((run) => run.status === 'running');
  React.useEffect(() => {
    let active = true,
      pending = false,
      checkedEnvironment = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const generationAtStart = generation.current;
      try {
        const recent = latestRuns.current;
        const latest = recent.find(
          (run) =>
            run.name.startsWith('hf generate') && run.status === 'completed',
        );
        const file =
          resultFile || (latest?.configuration.huggingface as any)?.output;
        const setupFinished =
          !!setupRun &&
          recent.some((run) => run.id === setupRun && run.status !== 'running');
        const [m, f, response, environment] = await Promise.all([
          call('hf.models'),
          call('hf.files'),
          file ? call('hf.result', { file }) : Promise.resolve(undefined),
          !checkedEnvironment || setupFinished
            ? call('hf.status').catch((error) => ({
                ready: false,
                missing: [],
                devices: ['cpu'],
                error: String(error),
              }))
            : Promise.resolve(undefined),
        ]);
        if (!active) return;
        setModels(m);
        setFiles(f);
        setDataset(
          (current) =>
            current ||
            (f.includes('data/train.jsonl') ? 'data/train.jsonl' : ''),
        );
        if (generationAtStart === generation.current && response !== undefined)
          setResult(response);
        if (environment) {
          setStatus(environment);
          checkedEnvironment = true;
        }
        if (setupFinished) setSetupRun('');
        setLoadError('');
      } catch (error) {
        if (active) setLoadError(String(error));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [call, resultFile, setupRun]);
  const launch = (operation: string, args: Record<string, unknown>) => {
    setBusy(true);
    if (operation === 'hf.generate') generation.current++;
    void perform(async () => {
      const run = await call(operation, args);
      select(run.id);
      setNotice(
        `${run.name} started. Follow its status below or open Runs for diagnostics.`,
      );
      if (operation === 'hf.generate') {
        setResult(undefined);
        setResultFile(run.output);
      }
      await refresh();
    }).finally(() => setBusy(false));
  };
  const base = models.find((item) => item.path === model)?.kind === 'base';
  const ready = status?.ready && !busy && running.length === 0 && !setupRun;
  return (
    <>
      <Heading
        title="Model hub & fine-tuning"
        text="Download a public Hugging Face model, train a LoRA adapter on your text, and test it locally without writing code."
      />
      <section className="aiide-card" aria-labelledby="hf-environment">
        <h3 id="hf-environment">1. Check your environment</h3>
        {!status ? (
          <p role="status">Checking the project Python environment…</p>
        ) : (
          <>
            <p>
              {status.ready
                ? `Ready · available hardware: ${status.devices.join(', ')}`
                : status.error ||
                  `Missing packages: ${status.missing.join(', ')}`}
            </p>
            {!status.ready && (
              <p>
                Create a <strong>Local PEFT fine-tuning</strong> project from
                Home, then run its <strong>setup</strong> command in Runs.
                Reopen this page after setup. For an existing project, keep its
                package manager and install the missing packages there.
              </p>
            )}
            <label>
              Execution device
              <select
                value={device}
                onChange={(e) => setDevice(e.target.value)}
              >
                <option value="auto">Automatic (CUDA → Apple MPS → CPU)</option>
                {status.devices.map((item: string) => (
                  <option key={item} value={item}>
                    {item.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <p className="aiide-note">
              Uses Transformers + PEFT. Apple Silicon uses MPS when available.
              CPU also works but is slower. Start with a one-step smoke test
              before a longer run.
            </p>
          </>
        )}
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await checkEnvironment();
              await reload();
            })
          }
        >
          Refresh environment & files
        </button>
      </section>
      <button
        disabled={busy || !!setupRun || running.length > 0}
        onClick={() => {
          setBusy(true);
          void perform(async () => {
            const run = await call('environment.setup');
            setSetupRun(run.id);
            setNotice(
              'Installing the locked project environment. Follow Environment setup in Runs.',
            );
            await refresh();
          }).finally(() => setBusy(false));
        }}
      >
        {setupRun
          ? 'Installing environment…'
          : 'Install locked project environment'}
      </button>
      <section className="aiide-card" aria-labelledby="hf-download">
        <h3 id="hf-download">2. Download a base model</h3>
        <div className="aiide-form-grid">
          <label>
            Hugging Face repository
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="organization/model"
            />
          </label>
          <label>
            Revision
            <input
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
            />
          </label>
        </div>
        <p className="aiide-note">
          Public Transformers causal language models with safetensors weights.
          The download records the exact commit. Qwen3-0.6B is about 1.2 GB.
          Review the{' '}
          <a
            href={`https://huggingface.co/${encodeURIComponent(repo).replace('%2F', '/')}`}
            target="_blank"
            rel="noreferrer"
          >
            model card and license
          </a>{' '}
          before use. Downloads use your internet connection; training stays
          local.
        </p>
        <button
          disabled={!ready || !repo.trim() || !revision.trim()}
          onClick={() =>
            launch('hf.download', {
              repo: repo.trim(),
              revision: revision.trim(),
            })
          }
        >
          Download model
        </button>
      </section>
      <section className="aiide-card" aria-labelledby="hf-train">
        <h3 id="hf-train">3. Choose data & fine-tune</h3>
        <div className="aiide-form-grid">
          <label>
            Downloaded model or adapter
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Choose a model</option>
              {models.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.repo} ·{' '}
                  {item.kind === 'adapter'
                    ? `LoRA (${item.steps} steps)`
                    : 'base'}{' '}
                  · {item.path.slice(-8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Training dataset
            <select
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
            >
              <option value="">Choose a JSONL dataset</option>
              {files.map((file) => (
                <option key={file}>{file}</option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Place a UTF-8 JSONL file in this workspace with one example per line:{' '}
          <code>{'{"text":"Your training example"}'}</code>, or a chat example{' '}
          <code>
            {
              '{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}'
            }
          </code>{' '}
          (only the final assistant answer is learned, in the model's own chat
          format). Maximum 50 MB / 100,000 examples. Select a base model to
          train; adapters can be tested below.
        </p>
        {!files.length && (
          <Empty>
            No JSONL datasets found. Add your file to the workspace, then
            refresh files.
          </Empty>
        )}
        <div className="aiide-form-grid">
          <label>
            Training steps
            <input
              type="number"
              min={1}
              max={10000}
              value={steps}
              onChange={(e) => setSteps(Number(e.target.value))}
            />
          </label>
          <label>
            Learning rate
            <input
              type="number"
              min={0.000001}
              max={0.01}
              step={0.0001}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </label>
          <label>
            Batch size
            <input
              type="number"
              min={1}
              max={16}
              value={batch}
              onChange={(e) => setBatch(Number(e.target.value))}
            />
          </label>
          <label>
            Maximum tokens per example
            <input
              type="number"
              min={16}
              max={2048}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
            />
          </label>
          <label>
            LoRA rank
            <input
              type="number"
              min={1}
              max={64}
              value={rank}
              onChange={(e) => setRank(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="aiide-actions">
          <button
            disabled={!ready || !base || !dataset}
            onClick={() =>
              launch('hf.train', {
                model,
                dataset,
                steps: 1,
                learningRate: rate,
                batchSize: 1,
                maxLength: 64,
                rank: 4,
                device,
              })
            }
          >
            Run one-step smoke test
          </button>
          <button
            className="aiide-primary"
            disabled={!ready || !base || !dataset}
            onClick={() =>
              launch('hf.train', {
                model,
                dataset,
                steps,
                learningRate: rate,
                batchSize: batch,
                maxLength: length,
                rank,
                device,
              })
            }
          >
            Start LoRA fine-tuning
          </button>
        </div>
        <p className="aiide-note">
          The base weights stay intact. Each successful run saves a separate
          adapter. Loss and hardware metrics appear in Training and Runs. Reduce
          batch size or sequence length if memory is insufficient.
        </p>
      </section>
      <section className="aiide-card" aria-labelledby="hf-inference">
        <h3 id="hf-inference">4. Test the selected model</h3>
        <label>
          Prompt
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label>
          Maximum new tokens
          <input
            type="number"
            min={1}
            max={512}
            value={tokens}
            onChange={(e) => setTokens(Number(e.target.value))}
          />
        </label>
        <button
          disabled={!ready || !model || !prompt.trim()}
          onClick={() =>
            launch('hf.generate', {
              model,
              prompt,
              maxNewTokens: tokens,
              device,
            })
          }
        >
          Generate locally
        </button>
        {openEvals && (
          <button
            className="aiide-primary"
            disabled={!model}
            onClick={() => openEvals(model)}
          >
            Serve & evaluate this model →
          </button>
        )}
        <p className="aiide-note">
          The response is saved locally under .aiide/hf-results so it can be
          displayed after the run. It is not exported to telemetry.
        </p>
        {result && (
          <div role="status">
            <pre className="aiide-json">{result.text}</pre>
            <p>
              {result.tokens} tokens · {result.seconds.toFixed(2)} seconds ·{' '}
              {result.device}
            </p>
          </div>
        )}
      </section>
      {loadError && (
        <p role="alert">Could not refresh Hub status: {loadError}</p>
      )}
      <p role="status" aria-live="polite">
        {notice}
      </p>
      {jobs.length > 0 && (
        <section className="aiide-card">
          <h3>Recent Hub & fine-tuning runs</h3>
          <ul>
            {jobs.slice(0, 8).map((run) => (
              <li key={run.id}>
                {run.name} · <strong>{run.status}</strong>
                {openRun && (
                  <button
                    onClick={() => openRun(run.id)}
                    aria-label={`View diagnostics for ${run.name}`}
                  >
                    View diagnostics
                  </button>
                )}
                {run.status === 'running' && (
                  <button
                    onClick={() =>
                      void perform(async () => {
                        await call('runs.cancel', { id: run.id });
                        await refresh();
                      })
                    }
                    aria-label={`Cancel ${run.name}`}
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
          {running.length > 0 && (
            <p role="status">
              {running.length} active run(s). Downloads and jobs can be
              cancelled here.
            </p>
          )}
        </section>
      )}
    </>
  );
}
