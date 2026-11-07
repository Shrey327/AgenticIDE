import React from '@theia/core/shared/react';
import type { Run, Span, Connection, EventRecord } from '../common/protocol.js';
import {
  Call,
  Perform,
  format,
  time,
  Card,
  Empty,
  Json,
  Heading,
  RunSelect,
  ConnectionSelect,
} from './shared.js';
export function SettingsPanel({
  project,
  status,
  call,
  perform,
  refresh,
  connections,
}: {
  project: any;
  status: any;
  call: Call;
  perform: Perform;
  refresh: () => Promise<void>;
  connections: Connection[];
}) {
  const [capture, setCapture] = React.useState(
      project.config.telemetry.captureContent,
    ),
    [commands, setCommands] = React.useState(format(project.config.commands));
  const [chat, setChat] = React.useState(project.config.services?.chat || ''),
    [embeddings, setEmbeddings] = React.useState(
      project.config.services?.embeddings || '',
    ),
    [vectorStore, setVectorStore] = React.useState(
      project.config.services?.vectorStore || '',
    );
  const [python, setPython] = React.useState(project.config.environment.python);
  const [id, setId] = React.useState('vector-db'),
    [kind, setKind] = React.useState('qdrant'),
    [url, setUrl] = React.useState('http://localhost:6333'),
    [secret, setSecret] = React.useState('');
  const [exportConnection, setExportConnection] = React.useState(
    project.config.telemetry.exportConnection || '',
  );
  const [retention, setRetention] = React.useState(
      project.config.telemetry.retentionDays,
    ),
    [budget, setBudget] = React.useState(project.config.telemetry.budgetMb);
  const [monitor, setMonitor] = React.useState(''),
    [query, setQuery] = React.useState('up'),
    [result, setResult] = React.useState<any>();
  return (
    <>
      <Heading
        title="Workspace settings"
        text="Project commands, template defaults, telemetry, and service connections. External agent access has its own page under Build."
      />
      <div className="aiide-columns">
        <section className="aiide-card">
          <h3>Project execution</h3>
          <label>
            Python executable
            <input value={python} onChange={(e) => setPython(e.target.value)} />
          </label>
          <label>
            Named commands (JSON argument arrays)
            <textarea
              rows={7}
              value={commands}
              onChange={(e) => setCommands(e.target.value)}
            />
          </label>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={capture}
              onChange={(e) => setCapture(e.target.checked)}
            />{' '}
            Capture content in local telemetry
          </label>
          <ConnectionSelect
            label="Template chat model"
            connections={connections}
            value={chat}
            set={setChat}
            kind="model"
          />
          <ConnectionSelect
            label="Template embedding model"
            connections={connections}
            value={embeddings}
            set={setEmbeddings}
            kind="model"
          />
          <ConnectionSelect
            label="Template vector database"
            connections={connections}
            value={vectorStore}
            set={setVectorStore}
            kind="qdrant"
          />
          <p className="aiide-note">
            Includes prompts, responses, logs, documents, and state when
            instrumented. Secret redaction stays enabled. External export
            requires an explicit connection.
          </p>
          <ConnectionSelect
            label="External OTLP export (optional)"
            connections={connections}
            value={exportConnection}
            set={setExportConnection}
            kind="otlp"
          />
          <div className="aiide-form-grid">
            <label>
              Retention (days)
              <input
                type="number"
                min="1"
                max="365"
                value={retention}
                onChange={(e) => setRetention(Number(e.target.value))}
              />
            </label>
            <label>
              Telemetry budget (MB)
              <input
                type="number"
                min="1"
                max="2048"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </label>
          </div>
          <button
            className="aiide-primary"
            onClick={() =>
              void perform(async () => {
                await call('project.save', {
                  config: {
                    ...project.config,
                    environment: { python },
                    commands: JSON.parse(commands),
                    services: {
                      chat: chat || undefined,
                      embeddings: embeddings || undefined,
                      vectorStore: vectorStore || undefined,
                    },
                    telemetry: {
                      ...project.config.telemetry,
                      captureContent: capture,
                      retentionDays: retention,
                      budgetMb: budget,
                      exportConnection: exportConnection || undefined,
                    },
                  },
                });
                await refresh();
              })
            }
          >
            Save settings
          </button>
        </section>
        <div>
          <section className="aiide-card">
            <h3>Service connection</h3>
            <p>
              Vector databases, monitoring, and OTLP export. Model endpoints
              live in Models &amp; playground.
            </p>
            <label>
              Name
              <input value={id} onChange={(e) => setId(e.target.value)} />
            </label>
            <label>
              Service
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="qdrant">Qdrant</option>
                <option value="prometheus">Prometheus</option>
                <option value="grafana">Grafana</option>
                <option value="otlp">OTLP / LangSmith export</option>
              </select>
            </label>
            <label>
              Base URL
              <input value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label>
              API key
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
              />
            </label>
            <button
              onClick={() =>
                void perform(async () => {
                  await call('connections.save', {
                    connection: { id, kind, url },
                    secret,
                  });
                  setSecret('');
                  await refresh();
                })
              }
            >
              Save connection
            </button>
          </section>
          <section className="aiide-card">
            <h3>Monitoring explorer</h3>
            <label>
              Connection
              <select
                value={monitor}
                onChange={(e) => setMonitor(e.target.value)}
              >
                <option value="">Choose a service</option>
                {connections
                  .filter((c) => ['prometheus', 'grafana'].includes(c.kind))
                  .map((c) => (
                    <option key={c.id}>{c.id}</option>
                  ))}
              </select>
            </label>
            <label>
              PromQL query or Grafana dashboard UID
              <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button
              disabled={!monitor}
              onClick={() =>
                void perform(async () => {
                  const connection = connections.find((c) => c.id === monitor)!;
                  setResult(
                    await call(
                      connection.kind === 'prometheus'
                        ? 'monitoring.prometheus'
                        : 'monitoring.grafana',
                      {
                        id: monitor,
                        query,
                        uid: query,
                        start: Math.floor(Date.now() / 1000) - 3600,
                        end: Math.floor(Date.now() / 1000),
                        step: 15,
                      },
                    ),
                  );
                })
              }
            >
              Query service
            </button>
            {result && <Json value={result} />}
            <p className="aiide-note">
              Grafana returns dashboard metadata. Custom dashboard panel
              rendering is not available in this preview.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
