import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const appleEnvironmentImage =
  'ghcr.io/astral-sh/uv:0.9.26-python3.12-bookworm-slim';

/** The executable is configured by the IDE process, never by a project or agent. */
export class AppleSandbox {
  readonly binary = process.env.AIIDE_APPLE_CONTAINER || 'container';
  async call(args: string[], timeout = 5000, signal?: AbortSignal) {
    const result = await execute(this.binary, args, {
      timeout,
      signal,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  }
  async status() {
    const setup =
      'Install Apple Container 1.7.1 or newer on macOS 26 Apple Silicon, then run container system start --enable-kernel-install. VM isolation never falls back to Docker or host execution.';
    if (process.platform !== 'darwin' || process.arch !== 'arm64')
      return { available: false, setup };
    try {
      const version = (await this.call(['--version'])).trim();
      const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
      if (
        !match ||
        +match[1] < 1 ||
        (+match[1] === 1 &&
          (+match[2] < 7 || (+match[2] === 7 && +match[3] < 1)))
      )
        return { available: false, version, setup };
      await this.call(['system', 'status']);
      return { available: true, version, setup };
    } catch {
      return { available: false, setup };
    }
  }
  async prepare(image: string, signal?: AbortSignal) {
    try {
      await this.call(['image', 'inspect', image], 5000, signal);
    } catch {
      signal?.throwIfAborted();
      await this.call(['image', 'pull', image], 180000, signal);
    }
  }
  async owned(name: string, workspace: string) {
    if (!/^aiide-vm-[a-f0-9-]{36}$/.test(name)) return undefined;
    try {
      const data = JSON.parse(await this.call(['inspect', name]));
      const config = data?.[0]?.configuration;
      return config?.id === name &&
        config.labels?.['aiide.workspace'] === workspace &&
        config.labels?.['aiide.command'] === name.slice('aiide-vm-'.length) &&
        config.labels?.['aiide.managed'] === 'sandbox-vm-v1'
        ? config
        : undefined;
    } catch {
      return undefined;
    }
  }
  async cancel(name: string, workspace: string) {
    if (await this.owned(name, workspace))
      await this.call(['delete', '--force', name]);
  }
  async recover(workspace: string) {
    const records = JSON.parse(
      await this.call(['list', '--all', '--format', 'json']),
    );
    if (!Array.isArray(records) || records.length > 10000)
      throw new Error('Invalid VM inventory');
    for (const record of records) {
      const config = record.configuration;
      if (
        config?.labels?.['aiide.workspace'] === workspace &&
        config.labels?.['aiide.managed'] === 'sandbox-vm-v1' &&
        /^aiide-vm-[a-f0-9-]{36}$/.test(config.id)
      )
        await this.cancel(config.id, workspace);
    }
  }
  args(
    name: string,
    owner: string,
    commandId: string,
    directory: string,
    image: string,
    command: string,
    network: boolean,
  ) {
    if (/[,\r\n]/.test(directory))
      throw new Error(
        'Sandbox stage paths cannot contain commas or line breaks',
      );
    // prctl blocks setuid elevation; the VM receives only the selected stage, never the host home.
    const launcher =
      'import ctypes,os,sys;libc=ctypes.CDLL(None,use_errno=True);result=libc.prctl(38,1,0,0,0);sys.exit("Cannot enforce no-new-privileges") if result else os.execl("/bin/sh","sh","-c",sys.argv[1])';
    return [
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      `aiide.workspace=${owner}`,
      '--label',
      'aiide.managed=sandbox-vm-v1',
      '--label',
      `aiide.command=${commandId}`,
      '--network',
      network ? 'default' : 'none',
      ...(network ? [] : ['--no-dns']),
      '--read-only',
      '--cap-drop',
      'ALL',
      '--cpus',
      '2',
      '--memory',
      '1G',
      '--ulimit',
      'nofile=1024:1024',
      '--ulimit',
      'nproc=128:128',
      '--ulimit',
      'fsize=1073741824:1073741824',
      '--user',
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=512m',
      '--mount',
      `type=bind,source=${directory},target=/workspace`,
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
      '/usr/local/bin/python3',
      '-I',
      '-c',
      launcher,
      command,
    ];
  }
}
