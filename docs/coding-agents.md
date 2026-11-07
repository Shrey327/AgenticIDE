# Codex, Claude Code, and other coding agents

AIIDE exposes a workspace-scoped MCP server. An agent can inspect AI engineering evidence and propose staged changes while you use the native IDE panels to review them. Codex and Claude Code can run in the ordinary IDE terminal or in a separate terminal on the same machine. Installing the IDE does not install or authenticate those coding clients.

## Connect

1. Open the project in AIIDE and keep it open.
2. Open **Build → External agents**. Choose **Read-only diagnostics** or **Read, staged edits, and container commands**. Editing/execution sessions require Docker.
3. Click **Issue scoped credential**, then **Copy token**.
4. Open a terminal in the same project directory. Start Bash and read the token without placing its value in shell history:

   ```sh
   bash
   read -rsp "AIIDE token: " AIIDE_MCP_TOKEN; export AIIDE_MCP_TOKEN; printf '\n'
   ```

5. Expand **Connect Codex or Claude Code**, copy the command for your client, and run it in that same shell. The generated commands use this workspace's current endpoint and environment-based authentication. They do not replace your global client configuration.
6. Check the server using `/mcp` in the client. Approve the project/server when the client requests it. This is the coding client's own trust decision; AIIDE does not disable it.

Example Codex command (replace the port with the one in Settings):

```sh
codex -c 'mcp_servers.aiide.url="http://127.0.0.1:PORT/mcp"' \
  -c 'mcp_servers.aiide.bearer_token_env_var="AIIDE_MCP_TOKEN"' \
  -c 'mcp_servers.aiide.tool_timeout_sec=150'
```

The generated Claude Code command supplies a JSON `--mcp-config` with `type: "http"`, the endpoint URL, and `Authorization: "Bearer ${AIIDE_MCP_TOKEN}"`. The single quotes around that JSON preserve the variable reference for Claude Code to resolve. No token is embedded in the command.

Desktop coding clients must inherit the environment variable from their launch environment, or use their own secure bearer-token configuration. Merely exporting a variable in a terminal does not update an already-running desktop client. Other MCP clients can use Streamable HTTP with the same URL and bearer header; their configuration formats vary. OAuth login is not used by this endpoint.

Credentials expire after eight hours and disappear when the IDE closes. The endpoint port changes on restart. Generate a new credential and copy a fresh launch command after restarting. **Revoke all credentials** stops and discards the sessions they own. Tokens are specific to one workspace. Cloud-hosted agents cannot reach this loopback address.

## Give the agent project guidance

New projects include `AGENTS.md` and `CLAUDE.md`. Existing projects can use **Project instructions for coding agents → Create missing agent guides** after reviewing the text. Existing files are preserved. If either file already exists, copy and merge the relevant guidance yourself.

The guides describe the project environment, telemetry workflow, staged editing, checkpoint preservation, and sandbox limits. They contain no tokens or machine-specific endpoints. Client configuration directories (`.codex`, `.claude`, `.cursor`) and `.mcp.json` are excluded from staged copies along with existing credential exclusions.

Try these requests:

> Use aiide to inspect this project's latest failed run. Read its errors and trace, explain the evidence, and propose a fix.

> Compare the loss curves and recorded configurations of these two training runs. Identify what changed and whether the metrics support an improvement.

> Create an aiide staged session, fix the failing function, run the available checks with start_command, and prepare a diff for me to review in the IDE.

## What agents can do

| MCP tools | Behavior |
| --- | --- |
| `get_workspace` | Discover project commands, frameworks, environment, permissions, and limits |
| `list_runs`, `inspect_run` | Read run status, configuration, and summary |
| `inspect_trace` | Page through persisted spans, errors, tool calls, and retrieval attributes |
| `inspect_events` | Page through logs, evaluations, artifacts, checkpoints, and hardware events |
| `inspect_metrics` | Discover metric names and inspect a downsampled training curve |
| `create_session`, `list_sessions` | Create an isolated stage; list sessions belonging to this credential |
| `list_files`, `read_file`, `write_file` | Work with files in that stage |
| `start_command`, `session_status`, `cancel_command` | Execute in the container, poll bounded output, and cancel |
| `review_changes`, `close_session` | Inspect the diff or discard the stage |

Tool discovery reflects the credential's permissions. A read-only connection does not advertise editing or execution tools. Structured results and descriptive schemas make the interface usable without navigating the IDE visually. Existing synchronous `run_command` remains available; prefer `start_command` and polling for longer checks.

Telemetry is already governed by the project's capture/redaction settings. A content-disabled log cannot be reconstructed by an agent. Training metrics report collected values; no GPU measurements are invented. MCP does not expose local/SSH job launch, dependency installation, W&B credentials, credential issuance, or automatic application of host changes.

## Review and apply

When the agent finishes, open **Build → External agents → External agent sessions**. Match the session ID returned by the agent. You can inspect command output, cancel a command, review changed files, apply the reviewed diff, or discard the stage.

The original files stay unchanged until you click **Apply reviewed external changes**. If a host file changed after staging, application fails with a conflict instead of overwriting it. The agent should leave its session open until you finish reviewing; closing or revoking it discards the stage.

## Execution boundaries and current limits

MCP commands run in the existing non-root container with no general network, no Docker socket, and bounded CPU/RAM/time/output. The host environment and `.venv` are not mounted. The current sandbox image contains Python, but neither uv nor arbitrary project dependencies. If those dependencies are required, have the user run the check through the IDE; the agent must not silently bypass the sandbox. Dependency-ready sandbox images remain future work.

A coding CLI's own native shell and file tools are controlled by that CLI, not by AIIDE. Running `codex` or `claude` in the normal IDE terminal does not automatically put the entire agent in a container. Use their permission controls and direct them to the AIIDE MCP tools when you want the staged workflow. Guidance files are instructions, not an enforcement boundary.

The IDE provides observability and an MCP workflow; it does not embed either vendor's complete chat UI or manage their subscriptions. Do not confuse the built-in local-model Assistant with these independently installed coding clients.

## Verification

`npm run test:agents` uses temporary workspaces and isolated client settings. It checks the installed Codex configuration parser, an actual Claude Code MCP handshake, a standard MCP SDK client, native Settings controls, real Docker execution, staged edits, user-side application, concurrent-edit protection, and revocation. It runs no paid model inference and does not change your normal client configuration. It requires Docker, Chrome, and installed `codex` and `claude` commands. Setting `AIIDE_ELECTRON_EXECUTABLE` tests a packaged app instead; close existing IDE instances first because Electron enforces a single-instance lock. Browser acceptance passed for 0.2.1; the packaged launch check was blocked by the running installed IDE.

The regression suite additionally tests read-only discovery, structured diagnostic results, event pagination, credential ownership, redaction, and preservation of existing guidance files.

Configuration references checked for this implementation: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [Claude Code MCP setup](https://code.claude.com/docs/en/mcp). Their installed CLI help was also checked.
