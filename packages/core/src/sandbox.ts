import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { within, walk, hash, excluded, redact } from './security';
import { Store } from './store';

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
}
const execute = promisify(execFile);

export class Sandbox {
  private sessions = new Map<string, Session>();
  readonly image = 'python:3.12.12-slim-bookworm';
  constructor(
    readonly root: string,
    readonly directory: string,
    readonly store: Store,
  ) {}
  async available() {
    try {
      await execute('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
  async prepareImage(image: string) {
    try {
      await execute('docker', ['image', 'inspect', image], { timeout: 5000 });
      return;
    } catch {
      /* Download pinned public image on first use. */
    }
    const { stdout } = await execute(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { timeout: 5000 },
    );
    const config = path.join(this.directory, 'docker-public');
    fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config, 'config.json'), '{}', { mode: 0o600 });
    await execute(
      'docker',
      ['--config', config, '--host', stdout.trim(), 'pull', image],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
    );
  }
  async create() {
    if (!(await this.available()))
      throw new Error(
        'Docker is unavailable. Start Docker to use autonomous agents. Host execution is disabled.',
      );
    await this.prepareImage(this.image);
    if (this.sessions.size >= 4)
      throw new Error('Close an agent session before creating another');
    const id = crypto.randomUUID(),
      directory = path.join(this.directory, id),
      baseline: Record<string, string> = {};
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
    };
    this.sessions.set(id, session);
    this.audit(id, 'session.created', {});
    return { id, status: session.status };
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
    return fs.readFileSync(within(this.session(id).directory, file), 'utf8');
  }
  write(id: string, file: string, text: string) {
    if (excluded(file) || Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error('Protected path or file too large');
    const session = this.session(id);
    if (session.child)
      throw new Error('Stop the active command before editing');
    const target = within(session.directory, file, true);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    this.audit(id, 'file.write', { file });
    return { file };
  }
  async run(id: string, command: string, network = false) {
    const session = this.session(id);
    if (session.child) throw new Error('A command is already running');
    if (!command || command.length > 10000) throw new Error('Invalid command');
    const args = [
      'run',
      '--rm',
      '--pull=never',
      '--name',
      session.container,
      '--network',
      network ? 'bridge' : 'none',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--read-only',
      '--pids-limit=128',
      '--memory=1g',
      '--cpus=2',
      '--user',
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=128m',
      '--mount',
      `type=bind,src=${session.directory},dst=/workspace`,
      '--workdir',
      '/workspace',
      '--env',
      'HOME=/tmp',
      this.image,
      'sh',
      '-lc',
      command,
    ];
    session.status = 'running';
    session.output = '';
    this.audit(id, 'command.start', { command, network });
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
          void this.cancel(id);
        }, 120000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          session.child = undefined;
          session.status = 'failed';
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          session.child = undefined;
          session.status = code === 0 ? 'completed' : 'failed';
          this.audit(id, 'command.end', { code });
          resolve({ exitCode: code ?? -1, output: session.output });
        });
      },
    );
  }
  start(id: string, command: string) {
    const session = this.session(id);
    if (session.child) throw new Error('A command is already running');
    if (!command || command.length > 10000) throw new Error('Invalid command');
    void this.run(id, command).catch((error) => {
      if (this.sessions.has(id)) {
        session.status = 'failed';
        session.output = String(redact(String(error), true));
      }
    });
    return this.status(id);
  }
  status(id: string) {
    const s = this.session(id);
    return { id, status: s.status, output: s.output };
  }
  async cancel(id: string) {
    const session = this.session(id);
    try {
      await execute('docker', ['kill', session.container], { timeout: 5000 });
    } catch {
      /* Container may have exited. */
    }
    session.child?.kill();
    this.audit(id, 'command.cancel', {});
  }
  diff(id: string): Change[] {
    const session = this.session(id);
    if (session.child)
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
    // Preflight every file before applying; rollback already-written files on an I/O failure.
    const written: Change[] = [];
    try {
      for (const change of changes) {
        const target = within(this.root, change.file, true);
        if (change.after === null) fs.unlinkSync(target);
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const mode = fs.existsSync(target)
            ? fs.statSync(target).mode & 0o777
            : 0o644;
          fs.writeFileSync(target + '.aiide-tmp', change.after, {
            flag: 'wx',
            mode,
          });
          fs.renameSync(target + '.aiide-tmp', target);
        }
        written.push(change);
      }
    } catch (error) {
      for (const change of written.reverse()) {
        const target = within(this.root, change.file, true);
        if (change.before === null) fs.rmSync(target);
        else fs.writeFileSync(target, change.before);
      }
      throw error;
    }
    for (const change of changes) {
      if (change.after === null) delete session.baseline[change.file];
      else session.baseline[change.file] = hash(change.after);
    }
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
    if (session.child) await this.cancel(id);
    fs.rmSync(session.directory, { recursive: true, force: true });
    this.sessions.delete(id);
  }
  async stop() {
    for (const id of this.sessions.keys()) await this.close(id);
  }
}
