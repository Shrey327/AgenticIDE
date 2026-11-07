import React from '@theia/core/shared/react';
import { Call, Perform, Json } from './shared.js';

export function AgentAccessPanel({
  call,
  perform,
}: {
  call: Call;
  perform: Perform;
}) {
  const [access, setAccess] = React.useState('read'),
    [grant, setGrant] = React.useState<any>(),
    [setup, setSetup] = React.useState<any>(),
    [sessions, setSessions] = React.useState<any[]>([]),
    [review, setReview] = React.useState<any>(),
    [installed, setInstalled] = React.useState<any>();
  React.useEffect(() => {
    let active = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const [s, list] = await Promise.all([
          call('agents.setup'),
          call('mcp.sessions'),
        ]);
        if (active) {
          setSetup(s);
          setSessions(list);
        }
      } catch {
        /* Explicit actions surface errors through perform. */
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
  }, [call]);
  const copy = (text: string) =>
    void perform(() => navigator.clipboard.writeText(text));
  return (
    <section className="aiide-card" data-testid="agent-access-panel">
      <h3>External agent access</h3>
      <p>
        Connect Codex, Claude Code, or another MCP client running on this
        machine. Keep this workspace open while the agent works.
      </p>
      <label>
        Agent permissions
        <select value={access} onChange={(e) => setAccess(e.target.value)}>
          <option value="read">Read-only diagnostics</option>
          <option value="work">
            Read, staged edits, and container commands
          </option>
        </select>
      </label>
      <div className="aiide-toolbar">
        <button
          onClick={() =>
            void perform(async () =>
              setGrant(
                await call('mcp.issue', {
                  scopes:
                    access === 'read' ? ['read'] : ['read', 'edit', 'execute'],
                }),
              ),
            )
          }
        >
          Issue scoped credential
        </button>
        <button
          onClick={() =>
            void perform(async () => {
              await call('mcp.revoke');
              setGrant(undefined);
              setReview(undefined);
              setSessions([]);
            })
          }
        >
          Revoke all credentials
        </button>
      </div>
      {grant && (
        <>
          <label>
            MCP endpoint
            <input readOnly value={grant.url} />
          </label>
          <label>
            Bearer token
            <input readOnly type="password" value={grant.token} />
          </label>
          <button onClick={() => copy(grant.token)}>Copy token</button>
          <p>
            Expires in eight hours or when the IDE closes. Revoking credentials
            stops and discards their staged sessions.
          </p>
        </>
      )}
      {setup && (
        <>
          <details>
            <summary>Connect Codex or Claude Code</summary>
            <p>
              In the terminal that will launch the agent, set AIIDE_MCP_TOKEN to
              the copied token. The following Bash command reads it without
              adding the value to shell history. Launch the agent from that same
              shell.
            </p>
            <pre className="aiide-json">
              {
                'bash\nread -rsp "AIIDE token: " AIIDE_MCP_TOKEN; export AIIDE_MCP_TOKEN; printf "\\n"'
              }
            </pre>
            <p>
              Run one of these commands from your project directory. They
              configure this agent invocation without replacing your global
              settings.
            </p>
            <label>
              Codex command
              <textarea readOnly rows={4} value={setup.codexCommand} />
            </label>
            <button onClick={() => copy(setup.codexCommand)}>
              Copy Codex command
            </button>
            <label>
              Claude Code command
              <textarea readOnly rows={4} value={setup.claudeCommand} />
            </label>
            <button onClick={() => copy(setup.claudeCommand)}>
              Copy Claude Code command
            </button>
            <p>
              Use /mcp in the agent to check the connection. Start with: “Use
              aiide to inspect this project's latest failed run, explain the
              evidence, and propose a fix.”
            </p>
            <details>
              <summary>Configuration snippets and other clients</summary>
              <p>
                For persistent configuration, merge these entries into the
                client's configuration; preserve existing entries. The endpoint
                changes after IDE restart. Desktop clients must inherit
                AIIDE_MCP_TOKEN from their launch environment, or use their own
                secure bearer-token configuration.
              </p>
              <pre className="aiide-json">{setup.codex}</pre>
              <pre className="aiide-json">{setup.claude}</pre>
              <p>
                Other clients: Streamable HTTP, the endpoint above, and an
                Authorization: Bearer header containing the issued token. No
                OAuth login is required.
              </p>
            </details>
          </details>
          <details>
            <summary>Project instructions for coding agents</summary>
            <p>
              New templates include AGENTS.md and CLAUDE.md. For an existing
              project, review the text below before creating missing files.
              Existing files are preserved; merge the guidance manually if they
              already exist.
            </p>
            <pre className="aiide-json">{setup.instructions}</pre>
            <button
              onClick={() =>
                void perform(async () =>
                  setInstalled(await call('agents.installGuides')),
                )
              }
            >
              Create missing agent guides
            </button>
            <button onClick={() => copy(setup.instructions)}>
              Copy agent guidance
            </button>
            {installed && <Json value={installed} />}
          </details>
        </>
      )}
      <h4>External agent sessions</h4>
      {!sessions.length && (
        <p>
          No staged sessions yet. A connected agent with execution permission
          can create one.
        </p>
      )}
      {sessions.map((session) => (
        <div key={session.id} className="aiide-card">
          <p>
            {session.id} · {session.status}
          </p>
          <button
            disabled={session.status === 'running'}
            onClick={() =>
              void perform(async () =>
                setReview({
                  ...(await call('sandbox.diff', { id: session.id })),
                  session: session.id,
                }),
              )
            }
          >
            Review external changes
          </button>
          <button
            onClick={() =>
              void perform(() => call('sandbox.cancel', { id: session.id }))
            }
          >
            Cancel external command
          </button>
          <button
            onClick={() =>
              void perform(async () => {
                await call('sandbox.close', { id: session.id });
                setReview(undefined);
                setSessions(await call('mcp.sessions'));
              })
            }
          >
            Discard external session
          </button>
          <details>
            <summary>Command output</summary>
            <pre className="aiide-terminal">
              {session.output || 'No command output'}
            </pre>
          </details>
        </div>
      ))}
      {review && (
        <div>
          <h4>Review external changes · {review.changes.length} files</h4>
          {review.changes.map((change: any) => (
            <details open key={change.file}>
              <summary>{change.file}</summary>
              <div className="aiide-columns">
                <div>
                  <small>CURRENT WORKSPACE</small>
                  <pre className="aiide-diff before">
                    {change.before ?? '(new file)'}
                  </pre>
                </div>
                <div>
                  <small>STAGED CHANGE</small>
                  <pre className="aiide-diff after">
                    {change.after ?? '(deleted)'}
                  </pre>
                </div>
              </div>
            </details>
          ))}
          <button
            disabled={!review.changes.length}
            onClick={() =>
              void perform(async () => {
                await call('sandbox.apply', {
                  id: review.session,
                  reviewHash: review.reviewHash,
                });
                setReview(undefined);
              })
            }
          >
            Apply reviewed external changes
          </button>
          <p>
            Concurrent workspace edits block application. External agents cannot
            apply their own changes.
          </p>
        </div>
      )}
      <p className="aiide-note">
        MCP commands use the container sandbox. A coding CLI's own terminal and
        file tools retain that CLI's permissions; launching it here does not
        automatically sandbox those native tools. Cloud agents cannot reach this
        loopback endpoint.
      </p>
    </section>
  );
}
