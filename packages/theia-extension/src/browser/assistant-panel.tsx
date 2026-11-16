import React from '@theia/core/shared/react';
import { VoiceInput } from './voice-input.js';
import { useProjectDraft } from './use-project-draft.js';
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
  const [draft, setDraft, draftError] = useProjectDraft(call, 'assistant', {
    model: '',
    prompt: '',
    command: 'python --version',
  });
  const { model, prompt, command } = draft;
  const setModel = (value: string) =>
    setDraft((previous) => ({ ...previous, model: value }));
  const setPrompt = (update: React.SetStateAction<string>) =>
    setDraft((previous) => ({
      ...previous,
      prompt: typeof update === 'function' ? update(previous.prompt) : update,
    }));
  const setCommand = (value: string) =>
    setDraft((previous) => ({ ...previous, command: value }));
  const [autonomous, setAutonomous] = React.useState(false),
    [chat, setChat] = React.useState<any>(),
    [review, setReview] = React.useState<any>();
  const [session, setSession] = React.useState(''),
    [terminal, setTerminal] = React.useState('');
  const [history, setHistory] = React.useState<any[]>([]);
  const [historyError, setHistoryError] = React.useState('');
  React.useEffect(() => {
    let mounted = true;
    void call('assistant.list')
      .then(async (records) => {
        if (!mounted || !Array.isArray(records)) return;
        setHistory(records);
        if (records.length) {
          const saved = await call('assistant.status', { id: records[0].id });
          if (mounted) {
            setChat(saved);
            if (saved.session) setSession(saved.session);
          }
        }
      })
      .catch((error) => {
        if (mounted) setHistoryError(String(error));
      });
    return () => {
      mounted = false;
    };
  }, [call]);
  React.useEffect(() => {
    if (!chat) return;
    void call('assistant.list')
      .then((records) => {
        if (Array.isArray(records)) setHistory(records);
      })
      .catch((error) => setHistoryError(String(error)));
  }, [chat?.id, chat?.status, call]);
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
          {draftError && (
            <p role="alert">
              Could not save or restore the local draft: {draftError}
            </p>
          )}
          {!!history.length && (
            <label>
              Saved requests
              <select
                value={chat?.id || ''}
                onChange={(event) => {
                  const id = event.target.value;
                  if (!id) {
                    setChat(undefined);
                    setReview(undefined);
                    return;
                  }
                  void perform(async () => {
                    const saved = await call('assistant.status', { id });
                    setChat(saved);
                    setSession(saved.session || '');
                    setReview(undefined);
                  });
                }}
              >
                <option value="">New request</option>
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.status} · {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {historyError && (
            <p role="alert">
              Could not restore request history: {historyError}
            </p>
          )}
          <p className="aiide-note">
            Requests and replies are saved locally under .aiide/assistant,
            independently of telemetry capture. Unsent prompt drafts also
            autosave locally; clear the prompt to remove its draft text. Delete
            a saved request to remove its history; staged source changes remain
            separately reviewable in Sandboxes.
          </p>
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
          <VoiceInput
            append={(text) =>
              setPrompt((value) => (value ? value + ' ' : '') + text)
            }
            disabled={chat?.status === 'running'}
          />
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
              disabled={!model || !prompt.trim() || chat?.status === 'running'}
              onClick={() =>
                void perform(async () => {
                  setReview(undefined);
                  setChat(
                    await call('assistant.start', {
                      model,
                      prompt,
                      autonomous:
                        autonomous && Boolean(current?.capabilities?.tools),
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
              <details>
                <summary>Original request</summary>
                <pre>{chat.prompt}</pre>
              </details>
              <span className={`aiide-badge ${chat.status}`} role="status">
                {chat.status}
              </span>
              <pre tabIndex={0} aria-label="Assistant response">
                {chat.text || 'Waiting for the model…'}
              </pre>
              {chat.actions?.map((a: any, i: number) => (
                <div className="aiide-action" key={i}>
                  {a.tool} <span>{a.status}</span>
                </div>
              ))}
              {chat.error && <p role="alert">{chat.error}</p>}
              {chat.status !== 'running' && (
                <div className="aiide-toolbar">
                  <button
                    onClick={() => {
                      setPrompt(chat.prompt || '');
                      setModel(chat.model || model);
                    }}
                  >
                    Reuse request
                  </button>
                  <button
                    onClick={() =>
                      void perform(async () => {
                        await call('assistant.delete', { id: chat.id });
                        setChat(undefined);
                        setReview(undefined);
                        setHistory(await call('assistant.list'));
                      })
                    }
                  >
                    Delete request history
                  </button>
                </div>
              )}
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
          {terminal && (
            <pre
              className="aiide-terminal"
              tabIndex={0}
              aria-label="Container command output"
            >
              {terminal}
            </pre>
          )}
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
