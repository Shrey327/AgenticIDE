# Agent sandboxes and recovery

Open **Build → Sandboxes**, create a sandbox, and choose a container command. The project is copied into a stage; the host source changes only after **Review diff → Apply reviewed changes**. Concurrent host edits block application. Source staging still excludes credentials, symlinks, binaries, environments and large files; filtering cannot identify every secret embedded in arbitrary code.

The Docker runner uses a non-root user, read-only root filesystem, dropped capabilities, no privilege escalation, an init process, 1 GB memory/swap, 2 CPUs, 128 PIDs, 1,024 file descriptors, a 1 GB single-file limit, 512 MB temporary storage and a two-minute command timeout. The temporary filesystem accommodates larger locked dependency wheels and counts against the memory limit. Network is disabled unless the user explicitly grants it for one command. No Docker socket, host home, model keys or other host credentials are mounted. Cancellation, timeout and storage-limit termination retain their status separately.

Staged storage is scanned every second and commands stop above 2 GB or 50,000 entries. **This is a monitored budget, not a hard filesystem quota.** Writes can exceed the budget between scans. The Docker daemon, shared kernel and host filesystem remain part of the trust boundary; this is not a hardened virtual machine or a multi-user hosting service. [Docker security](https://docs.docker.com/engine/security/), [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

## Locked dependencies

**Install locked environment (network)** uses the staged `pyproject.toml` and `uv.lock`. A small local image combines pinned Python and uv images, then `uv sync --locked --no-install-project --no-dev --no-editable` installs into the stage's `.venv`. It can download packages and run package build scripts in the constrained container. No host environment or global package manager is modified. Subsequent commands use that `.venv` with network disabled. Large or incompatible environments can exceed the documented limits; failures are visible in command output.

The image assembly has a fixed Dockerfile with no project code or build commands and no build network. Environment creation occurs only through the IDE action; external MCP tools cannot grant network or call this setup endpoint. [uv Docker guidance](https://docs.astral.sh/uv/guides/integration/docker/).

## Recovery and ownership

Ordinary IDE shutdown preserves source stages and validated records under `.aiide/sessions` and `.aiide/sandbox-state`. Reopening the workspace restores them for review; a command never resumes automatically. Startup removes orphan containers only when their ownership label matches this exact workspace. A copied workspace cannot cancel the original workspace's container. Malformed records are reported without deleting them.

On macOS/Linux, a bundled standard-library Python guardian supervises each Docker command through a private IDE-owned pipe. A crash or `SIGKILL` closes the pipe; the guardian checks the exact container name, workspace label and unique command label, then removes the verified immutable container ID, including commands that ignore `SIGTERM`. An old guardian cannot adopt a new command reusing a recovered session name. Cancellation, preflight and recovery also act on immutable IDs rather than mutable names. The guardian enforces the two-minute deadline independently of the IDE event loop. A bounded retry window covers Docker create requests already in flight when the IDE dies. Host `python3` is required. If the Docker daemon is unresponsive or creation takes longer than that window, immediate cleanup cannot be guaranteed; reopening retries owned-orphan removal. Windows currently uses direct Docker execution and requires restart recovery after an abrupt IDE exit.

Recovered sessions belong to the IDE. Fresh external-agent credentials cannot adopt their IDs; each grant can access only sessions it creates. Explicit credential revocation still discards that grant's sessions. **Discard sandbox** deletes staged files and their recovery record. Host files remain intact.

The coding assistant also saves requests/replies locally under `.aiide/assistant`. Completed status survives reopening; interrupted requests can be reviewed or reused. Each new request appears in Runs with model/tool traces. Traces follow the content-capture and retention settings; chat history is independent and can be deleted from the assistant. Unsent assistant and text-voice drafts autosave selected fields, excluding credentials.

## Verification

`npm run test:sandboxes` uses actual Docker containers to verify network/root/credential isolation, resource configuration, locked environment activation, cancellation, monitored storage exhaustion, owned-orphan cleanup, source recovery and reviewed application. Core tests cover persisted baselines, invalid recovery records, duplicate-start rejection, shutdown/discard completion, failed-apply retry cleanup, a real IDE `SIGKILL` with a TERM-resistant container, delayed Docker creation after IDE death, and same-name foreign-container replacement during cancellation. The browser product journey also exercises sandbox creation, execution, diff review and application.

No kernel exploit testing, hostile Docker-daemon testing, remote microVM adapter or cross-platform packaging acceptance is implied by these checks.

## Dedicated VM isolation on Apple Silicon

**Sandbox isolation policy → Dedicated VM per command → Save isolation policy** requires [Apple Container 1.7.1 or newer](https://github.com/apple/container/tree/1.7.1) on Apple Silicon macOS 26. Install/start that runtime and its compatible kernel explicitly; the IDE does not install host services or change a runtime's default kernel. **Recheck runtimes** refreshes availability. Initial runtime/image setup can require network downloads even when the guest command has no network attachment.

The saved policy applies to IDE and external-agent sandbox commands. VM mode fails closed if the runtime is unavailable, and refuses existing weaker Docker sessions. Create a new session after changing policy. Unsaved policy choices block Create, Run and Install; cancellation remains available. Ordinary trusted local project runs and approved custom RL factories remain separate host workflows.

Each command boots a separate Linux VM through Apple's Virtualization framework. Its guest receives only the staged workspace folder; no host home, SSH agent, Docker socket or provider keys are forwarded. The workload is non-root, drops Linux capabilities, enables no-new-privileges, uses a read-only root, and has 2 CPU/1 GiB cgroup limits, 128-process/1 GiB-file limits and 512 MiB scratch storage. The VM itself uses additional CPU/memory for its kernel and agent. The stage still has a monitored 2 GiB budget, **not a hard host-filesystem quota**.

No network device or DNS is configured by default. A manual one-command network grant or the explicit locked-environment action can attach the runtime's default network. Environment setup uses the pinned public uv/Python image inside the VM, with no host package installation. Registry access and runtime configuration belong to the operator; this integration does not provide database or OS-user isolation from the same privileged host account.

VM IDs are unique per command, with workspace/management/command labels. A private-pipe guardian stops owned VMs after an IDE crash or independent timeout, including late creation; startup recovery retries owned cleanup. Unlike Docker's immutable container IDs, Apple Container 1.7.1 identifies a VM by name and has no delete-generation compare-and-swap. Hostile same-user CLI replacement is outside this guest isolation boundary. The hypervisor, runtime and staged filesystem service remain trusted components.

Actual acceptance: `npm run test:sandboxes:vm` and `npm run test:sandboxes:vm:ui` require an installed, running runtime and cached images. They exercise separate kernel boot IDs, real CPU/memory cgroups, no network route, credentials/mount restrictions, cancellation, IDE `SIGKILL`, policy persistence and reviewed host application. Tests on this machine used a verified existing Linux 6.12.76 kernel through **per-command test arguments**, with Apple vminit 0.54.0; the recommended Kata kernel and hostile-kernel escape resistance were not validated. No runtime default was changed.

`AIIDE_APPLE_CONTAINER` configures the backend executable for isolated test infrastructure. `AIIDE_APPLE_TEST_KERNEL` is accepted by these test scripts only; it adds a transient CLI kernel argument. Project files and MCP tools cannot set either backend environment variable.
