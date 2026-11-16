import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { within, walk, hash, excluded, redact } from './security';
import { Store } from './store';
import { z } from 'zod';
import { AppleSandbox, appleEnvironmentImage } from './sandbox-apple';

export interface Change {
  file: string;
  before: string | null;
  after: string | null;
}
interface Session {
  id: string;
  directory: string;
  baseline: Record<string, string>;
  child?: ChildProcess;
  container: string;
  output: string;
  status: string;
  created?: number;
  environmentReady?: boolean;
  preparing?: boolean;
  preparationAbort?: AbortController;
  closed?: boolean;
  engine?: 'docker' | 'apple-vm';
}
const execute = promisify(execFile);
const savedSession = z.object({
  id: z.string().uuid(),
  baseline: z.record(z.string().max(500), z.string().regex(/^[a-f0-9]{64}$/)),
  status: z.string().max(30),
  output: z.string().max(100000),
  created: z.number().finite(),
  environmentReady: z.boolean().default(false),
  engine: z.enum(['docker', 'apple-vm']).default('docker'),
});

export class Sandbox {
  private readonly apple = new AppleSandbox();
  private sessions = new Map<string, Session>();
  readonly image = 'python:3.12.12-slim-bookworm';
  private readonly environmentImage = 'aiide-python:3.12.12-uv0.9.26';
  private readonly stateDirectory: string;
  private creating = false;
  private creationAbort?: AbortController;
  private creation?: Promise<unknown>;
  private stopped = false;
  private readonly preparations = new Map<string, Promise<unknown>>();
  private readonly commands = new Map<string, Promise<unknown>>();
  readonly recoveryErrors: string[] = [];
  constructor(
    readonly root: string,
    readonly directory: string,
    readonly store: Store,
  ) {
    const relativeDirectory = path.relative(root, directory);
    this.root = fs.realpathSync(root);
    this.directory = within(this.root, relativeDirectory, true);
    this.stateDirectory = within(this.root, '.aiide/sandbox-state', true);
    if (!fs.existsSync(this.stateDirectory)) return;
    const records = fs.readdirSync(this.stateDirectory);
    if (records.length > 32)
      this.recoveryErrors.push(
        'Only the first 32 recovery records were inspected; inspect sandbox-state manually.',
      );
    for (const entry of records.slice(0, 32)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(entry)) continue;
      try {
        const file = within(this.stateDirectory, entry);
        const info = fs.statSync(file);
        if (!info.isFile() || info.size > 4 * 1024 * 1024)
          throw new Error('Invalid session record');
        const data = savedSession.parse(
          JSON.parse(fs.readFileSync(file, 'utf8')),
        );
        if (
          `${data.id}.json` !== entry ||
          Object.keys(data.baseline).length > 10000
        )
          throw new Error('Invalid session record');
        const stage = within(
          this.root,
          path.relative(this.root, path.join(this.directory, data.id)),
        );
        if (!fs.statSync(stage).isDirectory())
          throw new Error('Missing staged files');
        for (const name of Object.keys(data.baseline)) {
          if (excluded(name)) throw new Error('Protected baseline path');
          within(stage, name, true);
        }
        this.sessions.set(data.id, {
          ...data,
          directory: stage,
          container: `aiide-${data.id}`,
          status: ['running', 'preparing'].includes(data.status)
            ? 'interrupted'
            : data.status,
        });
      } catch (error) {
        this.recoveryErrors.push(`${entry}: ${String(error)}`);
      }
    }
  }
  private persist(session: Session) {
    if (session.closed || this.sessions.get(session.id) !== session) return;
    try {
      const folder = within(
        this.root,
        path.relative(this.root, this.stateDirectory),
        true,
      );
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const target = within(folder, `${session.id}.json`, true);
      const temporary = within(folder, `${session.id}.tmp`, true);
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          id: session.id,
          baseline: session.baseline,
          output: session.output.slice(-100000),
          status: session.status,
          created: session.created || Date.now(),
          environmentReady: Boolean(session.environmentReady),
          engine: session.engine || 'docker',
        }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, target);
    } catch (error) {
      const message = `Sandbox ${session.id} recovery could not be saved: ${String(error)}`;
      if (!this.recoveryErrors.includes(message))
        this.recoveryErrors.push(message);
      if (this.recoveryErrors.length > 20) this.recoveryErrors.shift();
      this.store.dropped++;
      session.output = `${session.output}\n${message}`.slice(-100000);
    }
  }
  all() {
    return [...this.sessions.keys()].map((id) => this.status(id));
  }
  policy() {
    const file = within(this.root, '.aiide/sandbox-policy.json', true);
    if (!fs.existsSync(file)) return { engine: 'docker' as const };
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > 2048)
      throw new Error('Invalid sandbox policy file');
    return z
      .object({ engine: z.enum(['docker', 'apple-vm']) })
      .strict()
      .parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  configure(input: unknown) {
    if (
      this.stopped ||
      this.creating ||
      [...this.sessions.values()].some(
        (s) => s.child || s.preparing || s.status === 'running',
      )
    )
      throw new Error(
        'Stop active sandbox work before changing isolation policy',
      );
    const policy = z
      .object({ engine: z.enum(['docker', 'apple-vm']) })
      .strict()
      .parse(input);
    const file = within(this.root, '.aiide/sandbox-policy.json', true);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = within(
      this.root,
      `.aiide/${crypto.randomUUID()}.tmp`,
      true,
    );
    try {
      fs.writeFileSync(temporary, JSON.stringify(policy), {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return policy;
  }
  async capabilities() {
    return {
      policy: this.policy(),
      docker: { available: await this.dockerAvailable() },
      apple: await this.apple.status(),
    };
  }
  async recover() {
    if (!this.sessions.size) return;
    if ([...this.sessions.values()].some((s) => s.engine === 'apple-vm')) {
      try {
        await this.apple.recover(hash(this.root));
      } catch {
        this.recoveryErrors.push(
          'Dedicated VM recovery could not contact Apple Container; start its services before executing recovered work.',
        );
      }
    }
    const result = await execute(
      'docker',
      [
        'ps',
        '-a',
        '--no-trunc',
        '--filter',
        `label=aiide.workspace=${hash(this.root)}`,
        '--format',
        '{{.ID}} {{.Names}}',
      ],
      { timeout: 5000 },
    ).catch(() => undefined);
    if (!result) return;
    for (const row of result.stdout.trim().split('\n')) {
      const [containerId, name] = row.split(' ');
      if (
        !/^[a-f0-9]{64}$/.test(containerId) ||
        !/^aiide-[a-f0-9-]{36}$/.test(name)
      )
        continue;
      await execute('docker', ['rm', '-f', containerId], { timeout: 5000 });
      const session = this.sessions.get(name.slice(6));
      if (session) {
        session.status = 'interrupted';
        this.persist(session);
      }
    }
  }
  async available() {
    if (this.policy().engine === 'apple-vm')
      return (await this.apple.status()).available;
    return this.dockerAvailable();
  }
  async dockerAvailable() {
    try {
      await execute('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
  async prepareImage(image: string, signal?: AbortSignal) {
    try {
      await execute('docker', ['image', 'inspect', image], {
        timeout: 5000,
        signal,
      });
      return;
    } catch {
      /* Download pinned public image on first use. */
    }
    const { stdout } = await execute(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { timeout: 5000, signal },
    );
    const config = path.join(this.directory, 'docker-public');
    fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config, 'config.json'), '{}', { mode: 0o600 });
    await execute(
      'docker',
      ['--config', config, '--host', stdout.trim(), 'pull', image],
      { timeout: 180000, maxBuffer: 1024 * 1024, signal },
    );
  }
  async create() {
    if (this.stopped) throw new Error('Sandbox is stopped');
    if (this.creating) throw new Error('A sandbox is already being created');
    this.creating = true;
    const controller = new AbortController();
    this.creationAbort = controller;
    const operation = this.createStage(controller.signal);
    this.creation = operation;
    try {
      return await operation;
    } finally {
      this.creating = false;
      this.creationAbort = undefined;
      this.creation = undefined;
    }
  }
  private async createStage(signal: AbortSignal) {
    const engine = this.policy().engine;
    if (/[,\r\n]/.test(this.directory))
      throw new Error(
        'Sandbox workspace paths cannot contain commas or line breaks',
      );
    if (!(await this.available()))
      throw new Error(
        engine === 'apple-vm'
          ? 'Dedicated VM isolation is required. Start Apple Container 1.7.1+ on macOS 26 Apple Silicon; execution is disabled until it is available.'
          : 'Docker is unavailable. Start Docker to use autonomous agents. Host execution is disabled.',
      );
    signal.throwIfAborted();
    if (engine === 'apple-vm') await this.apple.prepare(this.image, signal);
    else await this.prepareImage(this.image, signal);
    signal.throwIfAborted();
    if (this.stopped) throw new Error('Sandbox is stopped');
    if (this.sessions.size >= 4)
      throw new Error('Close an agent session before creating another');
    const id = crypto.randomUUID(),
      directory = path.join(this.directory, id),
      baseline: Record<string, string> = {};
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 });
    try {
      for (const file of walk(this.root)) {
        const data = fs.readFileSync(within(this.root, file));
        // Binary files and recognizable credential-bearing files are never placed in agent context.
        if (
          data.includes(0) ||
          /(?:PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,})/.test(
            data.toString(),
          )
        )
          continue;
        const target = path.join(directory, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data, {
          mode: fs.statSync(within(this.root, file)).mode & 0o777,
        });
        baseline[file] = hash(data);
      }
      const session: Session = {
        id,
        directory,
        baseline,
        container: `aiide-${id}`,
        output: '',
        status: 'ready',
        created: Date.now(),
        engine,
      };
      this.sessions.set(id, session);
      this.persist(session);
      this.audit(id, 'session.created', {});
      return { id, status: session.status };
    } catch (error) {
      if (!this.sessions.has(id))
        fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Agent session not found');
    return session;
  }
  list(id: string) {
    return walk(this.session(id).directory);
  }
  read(id: string, file: string) {
    if (excluded(file)) throw new Error('Protected path');
    const target = within(this.session(id).directory, file);
    if (
      !fs.statSync(target).isFile() ||
      fs.statSync(target).size > 2 * 1024 * 1024
    )
      throw new Error('Choose a regular staged file up to 2 MB');
    return fs.readFileSync(target, 'utf8');
  }
  write(id: string, file: string, text: string) {
    if (excluded(file) || Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error('Protected path or file too large');
    const session = this.session(id);
    if (
      session.closed ||
      session.child ||
      session.preparing ||
      session.status === 'running'
    )
      throw new Error('Stop the active command before editing');
    const target = within(session.directory, file, true);
    if (fs.existsSync(target) && !fs.statSync(target).isFile())
      throw new Error('Choose a regular staged file');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    this.audit(id, 'file.write', { file });
    return { file };
  }
  prepareEnvironment(id: string) {
    if (this.stopped || this.session(id).closed)
      throw new Error('Sandbox is closed');
    if (
      this.policy().engine === 'apple-vm' &&
      this.session(id).engine !== 'apple-vm'
    )
      throw new Error(
        'This workspace requires a dedicated VM; create a new sandbox under the current isolation policy',
      );
    if (this.preparations.has(id))
      throw new Error('Environment setup is already running');
    const operation = this.installEnvironment(id);
    this.preparations.set(id, operation);
    void operation.finally(() => this.preparations.delete(id)).catch(() => {});
    return operation;
  }
  private async installEnvironment(id: string) {
    const session = this.session(id);
    if (session.child || session.preparing || session.status === 'running')
      throw new Error('Stop the active command first');
    for (const name of ['pyproject.toml', 'uv.lock']) {
      const file = within(session.directory, name);
      if (!fs.statSync(file).isFile())
        throw new Error('A locked uv project is required');
    }
    session.preparing = true;
    session.preparationAbort = new AbortController();
    const signal = session.preparationAbort.signal;
    session.status = 'preparing';
    this.persist(session);
    try {
      if (session.engine === 'apple-vm') {
        await this.apple.prepare(appleEnvironmentImage, signal);
      } else {
        await this.prepareImage(this.image, signal);
        await this.prepareImage('ghcr.io/astral-sh/uv:0.9.26', signal);
        const context = within(this.root, '.aiide/sandbox-build', true);
        fs.mkdirSync(context, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          within(context, 'Dockerfile', true),
          `FROM ${this.image}\nCOPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /usr/local/bin/uv\n`,
        );
        await execute(
          'docker',
          [
            'build',
            '--network=none',
            '--pull=false',
            '-t',
            this.environmentImage,
            context,
          ],
          { timeout: 60000, maxBuffer: 1024 * 1024, signal },
        );
      }
      if (!this.sessions.has(id) || session.status !== 'preparing')
        throw new Error('Environment setup cancelled');
      session.preparing = false;
      const result = await this.run(
        id,
        'uv sync --locked --no-install-project --no-dev --no-editable',
        true,
        session.engine === 'apple-vm'
          ? appleEnvironmentImage
          : this.environmentImage,
      );
      session.environmentReady = result.exitCode === 0;
      this.persist(session);
      return { ...result, environmentReady: session.environmentReady };
    } finally {
      session.preparing = false;
      session.preparationAbort = undefined;
      if (session.status === 'preparing') session.status = 'failed';
      if (this.sessions.has(id)) this.persist(session);
    }
  }
  run(id: string, command: string, network = false, image = this.image) {
    const session = this.session(id);
    if (this.policy().engine === 'apple-vm' && session.engine !== 'apple-vm')
      throw new Error(
        'This workspace requires a dedicated VM; create a new sandbox under the current isolation policy',
      );
    if (this.stopped || session.closed) throw new Error('Sandbox is closed');
    if (session.child || session.preparing || session.status === 'running')
      return Promise.reject(new Error('A command is already running'));
    const operation = this.executeCommand(id, command, network, image);
    this.commands.set(id, operation);
    void operation
      .finally(() => {
        if (this.commands.get(id) === operation) this.commands.delete(id);
      })
      .catch(() => {});
    return operation;
  }
  private async executeCommand(
    id: string,
    command: string,
    network: boolean,
    image: string,
  ) {
    const session = this.session(id);
    const vm = session.engine === 'apple-vm';
    const commandId = crypto.randomUUID();
    if (vm) session.container = `aiide-vm-${commandId}`;
    if (session.child || session.preparing || session.status === 'running')
      throw new Error('A command is already running');
    if (!command || command.length > 10000) throw new Error('Invalid command');
    session.status = 'running';
    session.output = '';
    this.persist(session);
    try {
      if (!vm) {
        // Recovered commands never resume automatically; remove only our labelled orphan.
        const old = await execute(
          'docker',
          [
            'inspect',
            '--format',
            '{{.Id}} {{index .Config.Labels "aiide.workspace"}}',
            session.container,
          ],
          { timeout: 5000 },
        ).catch(() => undefined);
        if (old) {
          const [containerId, owner] = old.stdout.trim().split(/\s+/);
          if (owner !== hash(this.root) || !/^[a-f0-9]{64}$/.test(containerId))
            throw new Error('Container name belongs to another owner');
          await execute('docker', ['rm', '-f', containerId], {
            timeout: 5000,
          });
        }
      }
    } catch (error) {
      if (session.status === 'running') session.status = 'failed';
      if (this.sessions.has(id)) this.persist(session);
      throw error;
    }
    if (
      session.closed ||
      this.sessions.get(id) !== session ||
      session.status !== 'running'
    )
      return { exitCode: -1, output: session.output };
    const args = vm
      ? this.apple.args(
          session.container,
          hash(this.root),
          commandId,
          session.directory,
          image,
          command,
          network,
        )
      : [
          'run',
          '--rm',
          '--pull=never',
          '--name',
          session.container,
          '--label',
          `aiide.workspace=${hash(this.root)}`,
          '--label',
          `aiide.command=${commandId}`,
          '--init',
          '--network',
          network ? 'bridge' : 'none',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--read-only',
          '--pids-limit=128',
          '--memory=1g',
          '--memory-swap=1g',
          '--ulimit',
          'nofile=1024:1024',
          '--ulimit',
          'fsize=1073741824:1073741824',
          '--cpus=2',
          '--user',
          `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=512m',
          '--mount',
          `type=bind,src=${session.directory},dst=/workspace`,
          '--workdir',
          '/workspace',
          '--env',
          'HOME=/tmp',
          '--env',
          'PATH=/workspace/.venv/bin:/usr/local/bin:/usr/bin:/bin',
          '--env',
          'UV_PYTHON_DOWNLOADS=never',
          '--env',
          'UV_CACHE_DIR=/tmp/uv-cache',
          '--env',
          'UV_LINK_MODE=copy',
          image,
          'sh',
          '-c',
          command,
        ];
    this.audit(id, 'command.start', { command, network });
    const assetPath = path.resolve(__dirname, '../resources');
    const helper = path.join(
      process.env.AIIDE_RESOURCES ||
        assetPath.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked'),
      'python',
      'aiide_runtime',
      vm ? 'sandbox_apple.py' : 'sandbox.py',
    );
    if (process.platform !== 'win32' && !fs.existsSync(helper)) {
      session.status = 'failed';
      this.persist(session);
      throw new Error(
        'The bundled sandbox supervisor is unavailable; rebuild core assets',
      );
    }
    const child =
      process.platform === 'win32'
        ? spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(
            'python3',
            [
              '-I',
              helper,
              session.container,
              hash(this.root),
              commandId,
              ...args,
            ],
            {
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
            },
          );
    // Only this IDE owns the write side; EOF also detects abrupt process death.
    child.stdio[3]?.on('error', () => {});
    session.child = child;
    const append = (data: Buffer) => {
      session.output = (
        session.output + String(redact(data.toString(), true))
      ).slice(-100000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    return new Promise<{ exitCode: number; output: string }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          void this.cancel(id, 'timed-out');
        }, 120000);
        // Bind mounts have no portable hard quota; stop jobs exceeding this monitored budget.
        const diskCheck = setInterval(() => {
          let bytes = 0,
            count = 0;
          const pending = [session.directory];
          try {
            while (pending.length) {
              for (const entry of fs.readdirSync(pending.pop()!, {
                withFileTypes: true,
              })) {
                if (++count > 50000) throw new Error('Too many staged entries');
                const target = path.join(entry.parentPath, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) pending.push(target);
                else if (entry.isFile()) bytes += fs.statSync(target).size;
                if (bytes > 2 * 1024 ** 3)
                  throw new Error('Staged storage budget exceeded');
              }
            }
          } catch (error) {
            clearInterval(diskCheck);
            session.output += `\nSandbox storage check: ${String(error)}`;
            void this.cancel(id, 'resource-limit');
          }
        }, 1000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          clearInterval(diskCheck);
          session.child = undefined;
          session.status = 'failed';
          this.persist(session);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          clearInterval(diskCheck);
          session.child = undefined;
          if (session.status === 'running')
            session.status =
              code === 0 ? 'completed' : code === 124 ? 'timed-out' : 'failed';
          this.persist(session);
          this.audit(id, 'command.end', { code });
          resolve({ exitCode: code ?? -1, output: session.output });
        });
      },
    );
  }
  start(id: string, command: string) {
    const session = this.session(id);
    if (this.stopped || session.closed) throw new Error('Sandbox is closed');
    if (session.child || session.preparing || session.status === 'running')
      throw new Error('A command is already running');
    if (!command || command.length > 10000) throw new Error('Invalid command');
    void this.run(id, command).catch((error) => {
      if (!session.closed && this.sessions.get(id) === session) {
        session.status = 'failed';
        session.output = String(redact(String(error), true));
      }
    });
    return this.status(id);
  }
  status(id: string) {
    const s = this.session(id);
    return {
      id,
      status: s.status,
      output: s.output,
      created: s.created,
      environmentReady: Boolean(s.environmentReady),
      engine: s.engine || 'docker',
      isolation:
        s.engine === 'apple-vm'
          ? 'dedicated Linux VM per command'
          : 'shared-kernel container',
      limits: {
        memoryMb: 1024,
        cpus: 2,
        pids: 128,
        timeoutSeconds: 120,
        maximumFileMb: 1024,
        monitoredStorageMb: 2048,
        maximumEntries: 50000,
        network: 'disabled unless explicitly granted for one command',
      },
    };
  }
  async cancel(
    id: string,
    reason: 'cancelled' | 'timed-out' | 'resource-limit' = 'cancelled',
  ) {
    const session = this.session(id);
    session.status = reason;
    session.preparationAbort?.abort();
    try {
      if (session.engine === 'apple-vm')
        await this.apple.cancel(session.container, hash(this.root));
      else {
        const owner = await execute(
          'docker',
          [
            'inspect',
            '--format',
            '{{.Id}} {{index .Config.Labels "aiide.workspace"}}',
            session.container,
          ],
          { timeout: 5000 },
        );
        const [containerId, workspace] = owner.stdout.trim().split(/\s+/);
        if (workspace === hash(this.root) && /^[a-f0-9]{64}$/.test(containerId))
          await execute('docker', ['kill', containerId], { timeout: 5000 });
      }
    } catch {
      /* Container may have exited. */
    }
    session.child?.kill();
    this.persist(session);
    this.audit(id, 'command.cancel', {});
  }
  diff(id: string): Change[] {
    const session = this.session(id);
    if (
      session.closed ||
      session.child ||
      session.preparing ||
      session.status === 'running'
    )
      throw new Error(
        'Wait for the command to finish before reviewing changes',
      );
    const files = new Set([
      ...Object.keys(session.baseline),
      ...walk(session.directory),
    ]);
    const result: Change[] = [];
    for (const file of files) {
      const staged = within(session.directory, file, true),
        host = within(this.root, file, true);
      for (const target of [staged, host])
        if (
          fs.existsSync(target) &&
          (!fs.statSync(target).isFile() ||
            fs.statSync(target).size > 2 * 1024 * 1024)
        )
          throw new Error('Review changes only for regular files up to 2 MB');
      const after = fs.existsSync(staged)
        ? fs.readFileSync(staged, 'utf8')
        : null;
      if ((after === null ? undefined : hash(after)) === session.baseline[file])
        continue;
      const before = fs.existsSync(host) ? fs.readFileSync(host, 'utf8') : null;
      result.push({ file, before, after });
    }
    return result;
  }
  apply(id: string, reviewedHash: string) {
    const session = this.session(id),
      changes = this.diff(id);
    if (hash(JSON.stringify(changes)) !== reviewedHash)
      throw new Error('Changes have changed since review; review again');
    for (const change of changes) {
      if (
        (change.before === null ? undefined : hash(change.before)) !==
        session.baseline[change.file]
      )
        throw new Error(`Concurrent edit conflict: ${change.file}`);
    }
    const modes = new Map(
      changes.map((change) => [
        change.file,
        change.before === null
          ? 0o644
          : fs.statSync(within(this.root, change.file)).mode & 0o777,
      ]),
    );
    // Preflight every file before applying; rollback already-written files on an I/O failure.
    const written: Change[] = [];
    try {
      for (const change of changes) {
        const target = within(this.root, change.file, true);
        if (change.after === null) fs.unlinkSync(target);
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const mode = modes.get(change.file)!;
          const temporary = target + '.aiide-tmp';
          let created = false,
            descriptor: number | undefined;
          try {
            descriptor = fs.openSync(temporary, 'wx', mode);
            created = true;
            fs.writeFileSync(descriptor, change.after);
            if (change.before !== null) fs.fchmodSync(descriptor, mode);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporary, target);
            created = false;
          } finally {
            try {
              if (descriptor !== undefined) fs.closeSync(descriptor);
            } finally {
              if (created) fs.rmSync(temporary, { force: true });
            }
          }
        }
        written.push(change);
      }
    } catch (error) {
      for (const change of written.reverse()) {
        const target = within(this.root, change.file, true);
        if (change.before === null) fs.rmSync(target);
        else {
          fs.writeFileSync(target, change.before, {
            mode: modes.get(change.file),
          });
          fs.chmodSync(target, modes.get(change.file)!);
        }
      }
      throw error;
    }
    for (const change of changes) {
      if (change.after === null) delete session.baseline[change.file];
      else session.baseline[change.file] = hash(change.after);
    }
    this.persist(session);
    this.audit(id, 'changes.applied', { files: changes.map((c) => c.file) });
    return { applied: changes.length };
  }
  private audit(id: string, name: string, value: unknown) {
    this.store.event({
      runId: id,
      kind: 'audit',
      name,
      value,
      timestamp: Date.now(),
    });
  }
  async close(id: string) {
    const session = this.session(id);
    session.closed = true;
    try {
      await this.cancel(id);
      await Promise.allSettled([
        this.commands.get(id),
        this.preparations.get(id),
      ]);
      fs.rmSync(session.directory, { recursive: true, force: true });
      this.sessions.delete(id);
      const record = within(this.stateDirectory, `${id}.json`, true);
      if (fs.existsSync(record)) fs.unlinkSync(record);
    } finally {
      if (this.sessions.get(id) === session) session.closed = false;
    }
  }
  async stop() {
    this.stopped = true;
    this.creationAbort?.abort();
    for (const session of this.sessions.values()) {
      if (session.child || session.preparing || session.status === 'running')
        await this.cancel(session.id);
      this.persist(session);
    }
    await Promise.allSettled([
      this.creation,
      ...this.preparations.values(),
      ...this.commands.values(),
    ]);
  }
}
