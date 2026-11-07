import React from '@theia/core/shared/react';
import type { Run, Span, Connection, EventRecord } from '../common/protocol.js';
import {
  Call,
  Perform,
  Empty,
  Json,
  Heading,
  ConnectionSelect,
  duration,
} from './shared.js';
const presets = [
  {
    id: 'ollama',
    label: 'Ollama',
    url: 'http://localhost:11434/v1',
    hint: 'qwen3:8b',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    url: 'http://localhost:1234/v1',
    hint: 'loaded model id',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    url: 'http://localhost:8000/v1',
    hint: 'served model name',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    url: 'http://localhost:8080/v1',
    hint: 'any',
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible (HTTPS)',
    url: 'https://api.openai.com/v1',
    hint: 'model id',
  },
];
export function ModelsPanel({
  connections,
  call,
  perform,
  refresh,
}: {
  connections: Connection[];
  call: Call;
  perform: Perform;
  refresh: () => Promise<void>;
}) {
  const [id, setId] = React.useState('ollama'),
    [url, setUrl] = React.useState(presets[0].url),
    [hint, setHint] = React.useState(presets[0].hint),
    [model, setModel] = React.useState(''),
    [secret, setSecret] = React.useState(''),
    [result, setResult] = React.useState<any>();
  const [inputPrice, setInputPrice] = React.useState(''),
    [outputPrice, setOutputPrice] = React.useState('');
  return (
    <>
      <Heading
        title="Models & playground"
        text="Connect a local model server or an HTTPS endpoint, test what it supports, and try prompts. Keys stay in your OS keychain."
      />
      {connections.some((c) => c.kind === 'model') && (
        <Playground connections={connections} call={call} perform={perform} />
      )}
      <div className="aiide-columns">
        <section className="aiide-card">
          <h3>Add a model connection</h3>
          <div className="aiide-chips" aria-label="Endpoint presets">
            {presets.map((p) => (
              <button
                key={p.id}
                aria-pressed={url === p.url}
                onClick={() => {
                  setId(p.id);
                  setUrl(p.url);
                  setHint(p.hint);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label>
            Connection name
            <input value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <label>
            API base URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label>
            Model name
            <input
              placeholder={`e.g. ${hint}`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label>
            API key (optional for local servers)
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <button
            className="aiide-primary"
            onClick={() =>
              void perform(async () => {
                await call('connections.save', {
                  connection: {
                    id,
                    url,
                    model,
                    kind: 'model',
                    inputPrice:
                      inputPrice === '' ? undefined : Number(inputPrice),
                    outputPrice:
                      outputPrice === '' ? undefined : Number(outputPrice),
                  },
                  secret,
                });
                setSecret('');
                await refresh();
              })
            }
          >
            Save connection
          </button>
          <details>
            <summary>Optional cost estimates</summary>
            <label>
              USD per million input tokens
              <input
                type="number"
                min="0"
                value={inputPrice}
                onChange={(e) => setInputPrice(e.target.value)}
              />
            </label>
            <label>
              USD per million output tokens
              <input
                type="number"
                min="0"
                value={outputPrice}
                onChange={(e) => setOutputPrice(e.target.value)}
              />
            </label>
            <p className="aiide-note">
              Estimates use your configured rates and reported token usage.
              Missing prices are not treated as zero.
            </p>
          </details>
          <p className="aiide-note">
            Use a separate connection for an embedding model. Capability tests
            send a short request to the configured endpoint.
          </p>
        </section>
        <section>
          <div className="aiide-connection-list">
            {connections
              .filter((c) => c.kind === 'model')
              .map((c) => (
                <section key={c.id} className="aiide-card">
                  <div className="aiide-row">
                    <h3>{c.id}</h3>
                    <span className="aiide-badge">
                      {c.url.includes('localhost') ||
                      c.url.includes('127.0.0.1')
                        ? 'Local'
                        : 'Remote'}
                    </span>
                  </div>
                  <p>{c.model || 'No model selected'}</p>
                  <p className="aiide-mono">{c.url}</p>
                  <div className="aiide-capabilities">
                    {['chat', 'streaming', 'tools', 'embeddings'].map((cap) => (
                      <span
                        key={cap}
                        className={c.capabilities?.[cap] ? 'supported' : ''}
                      >
                        {c.capabilities?.[cap] ? '✓' : '○'} {cap}
                      </span>
                    ))}
                  </div>
                  <div className="aiide-toolbar">
                    <button
                      onClick={() =>
                        void perform(async () => {
                          setResult(await call('models.probe', { id: c.id }));
                          await refresh();
                        })
                      }
                    >
                      Test capabilities
                    </button>
                    <button
                      onClick={() =>
                        void perform(async () =>
                          setResult(await call('models.list', { id: c.id })),
                        )
                      }
                    >
                      List models
                    </button>
                  </div>
                </section>
              ))}
          </div>
          {!connections.some((c) => c.kind === 'model') && (
            <Empty>
              No model connections yet. Pick a preset, add the model name, and
              save to unlock the playground.
            </Empty>
          )}
          {Array.isArray(result?.data) ? (
            <section className="aiide-card">
              <h3>Models served · {result.data.length}</h3>
              <div className="aiide-chips">
                {result.data.map((m: any) => (
                  <span key={m.id} className="aiide-chip">
                    {m.id}
                  </span>
                ))}
              </div>
            </section>
          ) : (
            result && (
              <details open>
                <summary>Connection test results</summary>
                <Json value={result} />
              </details>
            )
          )}
        </section>
      </div>
    </>
  );
}

type Message = {
  role: 'user' | 'assistant';
  content: string;
  stats?: { ms: number; usage?: any; cost?: number; model: string };
};

function Playground({
  connections,
  call,
  perform,
}: {
  connections: Connection[];
  call: Call;
  perform: Perform;
}) {
  const models = connections.filter((c) => c.kind === 'model');
  const [model, setModel] = React.useState(models[0]?.id || ''),
    [system, setSystem] = React.useState(''),
    [temperature, setTemperature] = React.useState(''),
    [maxTokens, setMaxTokens] = React.useState(''),
    [prompt, setPrompt] = React.useState(''),
    [messages, setMessages] = React.useState<Message[]>([]),
    [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    if (!model && models[0]) setModel(models[0].id);
  }, [models.length]);
  const connection = models.find((c) => c.id === model);
  const send = () => {
    if (!model || !prompt.trim() || pending) return;
    const history: Message[] = [...messages, { role: 'user', content: prompt }];
    setMessages(history);
    setPrompt('');
    setPending(true);
    const started = performance.now();
    void perform(async () => {
      try {
        const r = await call('models.complete', {
          id: model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            ...history.map(({ role, content }) => ({ role, content })),
          ],
          temperature: temperature === '' ? undefined : Number(temperature),
          maxTokens: maxTokens === '' ? undefined : Number(maxTokens),
        });
        const u = r.usage;
        const cost =
          u &&
          connection?.inputPrice !== undefined &&
          connection.outputPrice !== undefined
            ? ((u.prompt_tokens || 0) * connection.inputPrice +
                (u.completion_tokens || 0) * connection.outputPrice) /
              1e6
            : undefined;
        setMessages([
          ...history,
          {
            role: 'assistant',
            content: r.text || '(empty response)',
            stats: {
              ms: performance.now() - started,
              usage: u,
              cost,
              model: connection?.model || model,
            },
          },
        ]);
      } catch (e) {
        setPrompt(history.at(-1)!.content);
        setMessages(messages);
        throw e;
      } finally {
        setPending(false);
      }
    });
  };
  return (
    <section className="aiide-card aiide-playground">
      <div className="aiide-row">
        <h3>
          <i className="codicon codicon-comment-discussion" /> Inference
          playground
        </h3>
        {messages.length > 0 && (
          <button className="aiide-subtle" onClick={() => setMessages([])}>
            <i className="codicon codicon-clear-all" /> New chat
          </button>
        )}
      </div>
      {!models.length ? (
        <p>Add a model connection below to start sending prompts.</p>
      ) : (
        <>
          <div className="aiide-playground-controls">
            <ConnectionSelect
              label="Model"
              connections={connections}
              value={model}
              set={setModel}
              kind="model"
            />
            <label>
              Temperature
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                placeholder="default"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </label>
            <label>
              Max tokens
              <input
                type="number"
                min="1"
                max="32768"
                placeholder="default"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </label>
          </div>
          <details>
            <summary>System prompt {system && '· set'}</summary>
            <textarea
              rows={3}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="You are a helpful assistant…"
            />
          </details>
          {messages.length > 0 && (
            <div className="aiide-chat" aria-live="polite">
              {messages.map((m, i) => (
                <div key={i} className={`aiide-message ${m.role}`}>
                  <small>{m.role === 'user' ? 'You' : m.stats?.model}</small>
                  <pre>{m.content}</pre>
                  {m.stats && (
                    <div className="aiide-message-stats">
                      <span>{duration(m.stats.ms)}</span>
                      {m.stats.usage && (
                        <span>
                          {m.stats.usage.prompt_tokens ?? '?'} in ·{' '}
                          {m.stats.usage.completion_tokens ?? '?'} out
                        </span>
                      )}
                      {m.stats.usage?.completion_tokens > 0 && (
                        <span>
                          {(
                            m.stats.usage.completion_tokens /
                            (m.stats.ms / 1000)
                          ).toFixed(1)}{' '}
                          tok/s
                        </span>
                      )}
                      {m.stats.cost !== undefined && (
                        <span>${m.stats.cost.toFixed(5)}</span>
                      )}
                      <button
                        className="aiide-link"
                        onClick={() =>
                          void perform(() =>
                            navigator.clipboard.writeText(m.content),
                          )
                        }
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {pending && (
                <div className="aiide-message assistant">
                  <small>{connection?.model || model}</small>
                  <pre className="aiide-muted">Generating…</pre>
                </div>
              )}
            </div>
          )}
          <div className="aiide-composer">
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              }}
              placeholder="Send a prompt… (⌘/Ctrl + Enter)"
              aria-label="Prompt"
            />
            <button
              className="aiide-primary"
              disabled={!model || !prompt.trim() || pending}
              onClick={send}
            >
              <i className="codicon codicon-send" /> Send
            </button>
          </div>
          <p className="aiide-note">
            Non-streaming chat completion. Latency is measured end to end from
            the IDE. Not recorded as a run.
          </p>
        </>
      )}
    </section>
  );
}
