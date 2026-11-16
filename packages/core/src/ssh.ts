import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { z } from 'zod';
import { within, redact } from './security';

export const sshSchema = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,200}$/),
  user: z
    .string()
    .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/)
    .optional(),
  port: z.number().int().min(1).max(65535).default(22),
  root: z
    .string()
    .min(2)
    .max(1000)
    .refine(
      (s) => s.startsWith('/') && !s.includes('\0'),
      'Use an absolute remote directory',
    ),
  python: z.string().min(1).max(1000).default('python3'),
  identityFile: z.string().max(1000).optional(),
  knownHostsFile: z.string().max(1000).optional(),
});
export type SshProfile = z.infer<typeof sshSchema>;
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

let helperPython: string | undefined;
let activeHelpers = 0;
export function subprocess(
  command: string,
  args: string[],
  input: unknown,
  timeout = 30000,
  env = process.env,
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request cancelled'));
      return;
    }
    if (activeHelpers >= 8)
      throw new Error(
        'Eight helper operations are already active; wait or cancel one before retrying',
      );
    const payload = JSON.stringify(input);
    if (
      typeof payload !== 'string' ||
      Buffer.byteLength(payload) > 24 * 1024 * 1024
    )
      throw new Error('Helper input must be valid JSON below 24 MB');
    const supervised = process.platform !== 'win32';
    const helper = path.join(
      process.env.AIIDE_RESOURCES ||
        path
          .resolve(__dirname, '../resources')
          .replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked'),
      'python',
      'aiide_runtime',
      'local.py',
    );
    if (supervised) {
      if (!fs.statSync(helper).isFile())
        throw new Error(
          'Helper supervisor is unavailable; rebuild core assets',
        );
      helperPython ??= execFileSync(
        'python3',
        ['-I', '-c', 'import sys;print(sys.executable)'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    }
    const child = spawn(
      supervised ? helperPython! : command,
      supervised ? ['-I', helper, '--forward-stdin', command, ...args] : args,
      {
        env,
        detached: supervised,
        stdio: supervised
          ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe'],
      },
    );
    activeHelpers++;
    child.once('close', () => {
      activeHelpers--;
    });
    child.stdio[3]?.on('error', () => {});
    let terminationError: Error | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      try {
        if (supervised) {
          child.stdio[3]?.destroy();
          child.kill('SIGTERM');
        } else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      terminationTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdin!.destroy();
        child.stdout!.destroy();
        child.stderr!.destroy();
        finish(
          new Error(
            `${error.message}; helper termination could not be confirmed`,
          ),
        );
      }, 5000);
    };
    const chunks: Buffer[] = [];
    let bytes = 0,
      errors = '',
      settled = false;
    let abort: (() => void) | undefined;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (abort) signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      terminate(
        new Error(
          'Request timed out; reconnect to inspect the job before retrying',
        ),
      );
    }, timeout);
    abort = () => {
      terminate(new Error('Request cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 24 * 1024 * 1024) {
        terminate(new Error('Response exceeds 24 MB'));
      } else chunks.push(chunk);
    });
    child.stdio[4]?.on('data', (chunk) => {
      errors = (errors + String(chunk)).slice(-3000);
    });
    child.stderr!.on('data', (chunk) => {
      errors = (errors + String(chunk)).slice(-3000);
    });
    child.stdin!.on('error', () => {});
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (terminationError) return finish(terminationError);
      if (code !== 0)
        return finish(
          new Error(`Process exited ${code}: ${String(redact(errors, true))}`),
        );
      try {
        const envelope = JSON.parse(Buffer.concat(chunks).toString());
        if (!envelope.ok)
          throw new Error(
            String(redact(envelope.error || 'Request failed', true)),
          );
        finish(undefined, envelope.result);
      } catch (error) {
        finish(error as Error);
      }
    });
    child.stdin!.end(payload);
  });
}

// Feed runtime and arguments over stdin, never interpolate project data into remote shell syntax.
const bootstrap = `import json,sys,types\nr=json.load(sys.stdin)\nfor name in ('aiide_sdk','aiide_runtime'):\n m=types.ModuleType(name);m.__path__=[];sys.modules[name]=m\nfor name in ('aiide_sdk.spool','aiide_runtime.artifacts','aiide_runtime.remote'):\n m=types.ModuleType(name);m.__package__=name.rsplit('.',1)[0];sys.modules[name]=m;exec(compile(r['files'][name.replace('.','/')+'.py'],name,'exec'),m.__dict__)\ntry:\n print(json.dumps({'ok':True,'result':sys.modules['aiide_runtime.remote'].main(r)},allow_nan=False))\nexcept Exception as e:\n print(json.dumps({'ok':False,'error':str(e)}))`;

export class Ssh {
  readonly files: Record<string, string> = {};
  private readonly file: string;
  constructor(
    readonly directory: string,
    assets: string,
  ) {
    this.file = path.join(directory, 'ssh.json');
    for (const packageName of ['aiide_sdk', 'aiide_runtime']) {
      const base = path.join(assets, 'python', packageName);
      for (const file of fs.readdirSync(base).filter((s) => s.endsWith('.py')))
        this.files[`${packageName}/${file}`] = fs.readFileSync(
          path.join(base, file),
          'utf8',
        );
    }
  }
  list(): SshProfile[] {
    if (
      fs.existsSync(this.file) &&
      (!fs.lstatSync(this.file).isFile() ||
        fs.statSync(this.file).size > 1024 * 1024)
    )
      throw new Error('SSH profiles must be a regular JSON file below 1 MB');
    return fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8')).map((p: unknown) =>
          sshSchema.parse(p),
        )
      : [];
  }
  get(id: string) {
    const result = this.list().find((p) => p.id === id);
    if (!result) throw new Error('SSH profile not found');
    return result;
  }
  save(input: unknown) {
    const profile = sshSchema.parse(input);
    for (const field of ['identityFile', 'knownHostsFile'] as const) {
      if (
        profile[field] &&
        (!path.isAbsolute(profile[field]) ||
          !fs.statSync(profile[field]).isFile())
      )
        throw new Error(`${field} must refer to an existing absolute file`);
    }
    fs.writeFileSync(
      this.file + '.tmp',
      JSON.stringify(
        [...this.list().filter((p) => p.id !== profile.id), profile],
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.renameSync(this.file + '.tmp', this.file);
    return profile;
  }
  request(profile: SshProfile, request: Record<string, unknown>) {
    profile = sshSchema.parse(profile);
    const args = [
      '-T',
      '-a',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=2',
      '-p',
      String(profile.port),
    ];
    if (profile.user) args.push('-l', profile.user);
    if (profile.identityFile)
      args.push('-i', profile.identityFile, '-o', 'IdentitiesOnly=yes');
    if (profile.knownHostsFile)
      args.push('-o', `UserKnownHostsFile=${profile.knownHostsFile}`);
    args.push(
      profile.host,
      `${quote(profile.python)} -I -c ${quote(bootstrap)}`,
    );
    return subprocess('ssh', args, {
      ...request,
      root: profile.root,
      files: this.files,
    });
  }
  local(root: string, request: Record<string, unknown>, python = 'python3') {
    return subprocess(python, ['-I', '-c', bootstrap], {
      ...request,
      root,
      files: this.files,
    });
  }
}
