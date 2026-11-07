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
export function AssistantPanel({
  connections,
  call,
  perform,
  context,
  setContext,
  selection,
}: {
  connections: Connection[];
  call: Call;
  perform: Perform;
  context: string;
  setContext: (s: string) => void;
  selection: () => string;
}) {
  const [model, setModel] = React.useState(''),
    [prompt, setPrompt] = React.useState(''),
    [autonomous, setAutonomous] = React.useState(false),
    [chat, setChat] = React.useState<any>(),
    [review, setReview] = React.useState<any>();
  const [command, setCommand] = React.useState('python --version'),
    [session, setSession] = React.useState(''),
    [terminal, setTerminal] = React.useState('');
  React.useEffect(() => {
    if (!chat || chat.status !== 'running') return;
    const timer = setInterval(() => {
      void call('assistant.status', { id: chat.id })
        .then((next: any) => {
          setChat(next);
          if (next.session) setSession(next.session);
        })
        .catch(() => clearInterval(timer));
    }, 500);
    return () => clearInterval(timer);
  }, [chat?.id, chat?.status, call]);
  const current = connections.find((c) => c.id === model);
  return (
    <>
      <Heading
        title="An assistant in your workspace"
        text="Use your own model. Let it inspect context, propose changes, and test inside an isolated container."
      />
      <div className="aiide-columns wide-left">
        <section className="aiide-card">
          <ConnectionSelect
            label="Coding model"
            connections={connections}
            value={model}
            set={setModel}
            kind="model"
          />
          <label>
            What would you like to do?
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Explain this trace, fix a failing test, or build a feature…"
            />
          </label>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={autonomous}
              disabled={!current?.capabilities?.tools}
              onChange={(e) => setAutonomous(e.target.checked)}
            />{' '}
            Autonomous in a container
          </label>
          {!current?.capabilities?.tools && (
            <p className="aiide-note">
              Test tool-calling support in Models to enable autonomous work.
            </p>
          )}
          <div className="aiide-toolbar">
            <button
              className="aiide-primary"
              disabled={!model || !prompt || chat?.status === 'running'}
              onClick={() =>
                void perform(async () => {
                  setReview(undefined);
                  setChat(
                    await call('assistant.start', {
                      model,
                      prompt,
                      autonomous,
                      context,
                    }),
                  );
                })
              }
            >
              Send request →
            </button>
            {chat?.status === 'running' && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await call('assistant.cancel', { id: chat.id });
                    setChat(await call('assistant.status', { id: chat.id }));
                  })
                }
              >
                Stop
              </button>
            )}
            <button onClick={() => setContext(selection())}>
              Attach editor selection
            </button>
          </div>
          {context && (
            <details>
              <summary>
                Attached context · {context.length.toLocaleString()} characters
              </summary>
              <pre>{context}</pre>
              <button onClick={() => setContext('')}>Remove context</button>
            </details>
          )}
          {chat && (
            <div className="aiide-response">
              <span className={`aiide-badge ${chat.status}`}>
                {chat.status}
              </span>
              <pre>{chat.text || 'Waiting for the model…'}</pre>
              {chat.actions?.map((a: any, i: number) => (
                <div className="aiide-action" key={i}>
                  {a.tool} <span>{a.status}</span>
                </div>
              ))}
              {chat.error && <p role="alert">{chat.error}</p>}
            </div>
          )}
        </section>
        <section className="aiide-card">
          <h3>Agent terminal</h3>
          <p>
            Commands execute only in the staged container. No host shell or
            network access is granted.
          </p>
          <div className="aiide-toolbar">
            <button
              disabled={Boolean(session)}
              onClick={() =>
                void perform(async () =>
                  setSession((await call('sandbox.create')).id),
                )
              }
            >
              Create session
            </button>
            {session && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await call('sandbox.close', { id: session });
                    setSession('');
                    setReview(undefined);
                  })
                }
              >
                Close session
              </button>
            )}
          </div>
          <label>
            Command
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </label>
          <div className="aiide-toolbar">
            <button
              disabled={!session}
              onClick={() =>
                void perform(async () => {
                  const r = await call('sandbox.run', { id: session, command });
                  setTerminal(r.output + '\nExit code: ' + r.exitCode);
                })
              }
            >
              Run in container
            </button>
            <button
              disabled={!session}
              onClick={() =>
                void perform(() => call('sandbox.cancel', { id: session }))
              }
            >
              Cancel command
            </button>
          </div>
          {terminal && <pre className="aiide-terminal">{terminal}</pre>}
          <button
            disabled={!session}
            onClick={() =>
              void perform(async () =>
                setReview(await call('sandbox.diff', { id: session })),
              )
            }
          >
            Review staged changes
          </button>
        </section>
      </div>
      {review && (
        <section className="aiide-card">
          <h3>Review changes · {review.changes.length} files</h3>
          {review.changes.map((c: any) => (
            <details open key={c.file}>
              <summary>{c.file}</summary>
              <div className="aiide-columns">
                <div>
                  <small>CURRENT WORKSPACE</small>
                  <pre className="aiide-diff before">
                    {c.before ?? '(new file)'}
                  </pre>
                </div>
                <div>
                  <small>STAGED CHANGE</small>
                  <pre className="aiide-diff after">
                    {c.after ?? '(deleted)'}
                  </pre>
                </div>
              </div>
            </details>
          ))}
          <button
            className="aiide-primary"
            disabled={!review.changes.length}
            onClick={() =>
              void perform(async () => {
                await call('sandbox.apply', {
                  id: session,
                  reviewHash: review.reviewHash,
                });
                setReview(undefined);
              })
            }
          >
            Apply reviewed changes
          </button>
          <p className="aiide-note">
            Application is blocked if a file changed in the workspace after the
            session was created.
          </p>
        </section>
      )}
    </>
  );
}
