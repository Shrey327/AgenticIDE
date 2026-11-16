import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import core from '../packages/core/lib/index.js';
import { appleEnvironmentImage } from '../packages/core/lib/sandbox-apple.js';

const execute = promisify(execFile);
assert.equal(
  process.platform,
  'darwin',
  'Native environment acceptance requires Apple Silicon macOS 26',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-vm-environment-'));
const kernel = process.env.AIIDE_APPLE_TEST_KERNEL;
const store = new core.Store(path.join(root, '.aiide/test.sqlite'));
const sandbox = new core.Sandbox(
  root,
  path.join(root, '.aiide/sessions'),
  store,
);
if (kernel) {
  assert.ok(path.isAbsolute(kernel) && fs.statSync(kernel).isFile());
  const original = sandbox.apple.args.bind(sandbox.apple);
  sandbox.apple.args = (...args) => {
    const command = original(...args);
    return [command[0], '--kernel', kernel, ...command.slice(1)];
  };
}
const wait = async (check, seconds = 30) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    await check(),
    'Timed out waiting for actual UV environment workflow',
  );
};
const metadata = `Metadata-Version: 2.3\nName: slowdep\nVersion: 0.1.0\n`;
const backend = `import base64,csv,hashlib,io,os,sys,time,zipfile\nfrom pathlib import Path\ndef get_requires_for_build_wheel(config_settings=None):return []\ndef prepare_metadata_for_build_wheel(metadata_directory,config_settings=None):\n directory=Path(metadata_directory)/'slowdep-0.1.0.dist-info';directory.mkdir(exist_ok=True)\n (directory/'METADATA').write_text(${JSON.stringify(metadata)})\n return directory.name\ndef build_wheel(wheel_directory,config_settings=None,metadata_directory=None):\n if sys.platform!='linux' or not Path('/workspace').is_dir():raise RuntimeError('Fixture build must run inside its Linux VM')\n Path('/workspace/uv-build-started').write_text('guest-only build hook')\n __BUILD__\n`;
const slowBackend = backend.replace(
  '__BUILD__',
  "time.sleep(90)\n raise RuntimeError('Cancellation should interrupt this build')",
);
const fastBackend = backend.replace(
  '__BUILD__',
  `filename='slowdep-0.1.0-py3-none-any.whl'\n files={'slowdep/__init__.py':b'VALUE=42\\n','slowdep-0.1.0.dist-info/METADATA':${JSON.stringify(metadata)}.encode(),'slowdep-0.1.0.dist-info/WHEEL':b'Wheel-Version: 1.0\\nGenerator: aiide-local-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}\n records=io.StringIO();writer=csv.writer(records,lineterminator='\\n')\n for name,data in files.items():writer.writerow([name,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='),str(len(data))])\n writer.writerow(['slowdep-0.1.0.dist-info/RECORD','',''])\n with zipfile.ZipFile(Path(wheel_directory)/filename,'w') as archive:\n  for name,data in files.items():archive.writestr(name,data)\n  archive.writestr('slowdep-0.1.0.dist-info/RECORD',records.getvalue())\n return filename`,
);
try {
  assert.ok(
    (await sandbox.capabilities()).apple.available,
    'Start the installed task runtime before testing',
  );
  await sandbox.apple.call(['image', 'inspect', sandbox.image]);
  await sandbox.apple.call(['image', 'inspect', appleEnvironmentImage]);
  fs.mkdirSync(path.join(root, 'slowdep'));
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    '[project]\nname="vm-environment-check"\nversion="0.1.0"\nrequires-python=">=3.12"\ndependencies=["slowdep==0.1.0"]\n[tool.uv]\npackage=false\n[tool.uv.sources]\nslowdep={path="slowdep"}\n',
  );
  fs.writeFileSync(
    path.join(root, 'slowdep/pyproject.toml'),
    '[project]\nname="slowdep"\nversion="0.1.0"\nrequires-python=">=3.12"\n[build-system]\nrequires=[]\nbuild-backend="backend"\nbackend-path=["."]\n',
  );
  fs.writeFileSync(path.join(root, 'slowdep/backend.py'), slowBackend);
  await execute('uv', ['lock', '--offline', '--python', 'python3'], {
    cwd: root,
    env: {
      ...process.env,
      UV_PYTHON_DOWNLOADS: 'never',
      UV_CACHE_DIR: path.join(root, '.aiide/uv-fixture-cache'),
    },
    timeout: 30000,
  });
  assert.equal(
    fs.existsSync(path.join(root, 'uv-build-started')),
    false,
    'Host locking cannot execute the guest-only wheel build',
  );
  sandbox.configure({ engine: 'apple-vm' });
  const { id } = await sandbox.create();
  const stage = path.join(root, '.aiide/sessions', id);
  const preparing = sandbox.prepareEnvironment(id);
  const prepareOutcome = preparing.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await wait(() => {
    const current = sandbox.status(id);
    if (current.status === 'failed') throw new Error(current.output);
    return fs.existsSync(path.join(stage, 'uv-build-started'));
  });
  assert.equal(fs.existsSync(path.join(root, 'uv-build-started')), false);
  await sandbox.cancel(id);
  const interrupted = await prepareOutcome;
  assert.equal(interrupted.error, undefined);
  assert.equal(interrupted.value.environmentReady, false);
  assert.equal(sandbox.status(id).status, 'cancelled');
  assert.equal(sandbox.sessions.get(id).preparing, false);
  assert.equal(sandbox.sessions.get(id).child, undefined);
  assert.equal(sandbox.preparations.has(id), false);
  sandbox.write(id, 'slowdep/backend.py', fastBackend);
  const installed = await sandbox.prepareEnvironment(id);
  assert.equal(installed.exitCode, 0, installed.output);
  assert.equal(installed.environmentReady, true);
  const offline = await sandbox.run(
    id,
    `python -c "import json,os,slowdep,socket,sys;from pathlib import Path;assert slowdep.VALUE==42;assert sys.prefix=='/workspace/.venv';assert str(slowdep.__file__).startswith('/workspace/.venv/');assert not any((Path('/sys/class/net')/name/'device').exists() for _,name in socket.if_nameindex());assert len(Path('/proc/net/route').read_text().strip().splitlines())<=1;print(json.dumps({'venv':sys.prefix,'value':slowdep.VALUE,'offline':True}))"`,
  );
  assert.equal(offline.exitCode, 0, offline.output);
  assert.match(offline.output, /"offline": true/);
  assert.equal(
    fs.existsSync(path.join(root, '.venv')),
    false,
    'The environment remains in the stage, never the host project',
  );
  const fresh = await sandbox.create();
  const cancelled = assert.rejects(
    sandbox.prepareEnvironment(fresh.id),
    /abort|cancel/i,
  );
  await sandbox.cancel(fresh.id);
  await cancelled;
  assert.equal(sandbox.status(fresh.id).status, 'cancelled');
  assert.equal(sandbox.sessions.get(fresh.id).preparing, false);
  assert.equal(sandbox.sessions.get(fresh.id).child, undefined);
  assert.equal(
    fs.existsSync(
      path.join(root, '.aiide/sessions', fresh.id, 'uv-build-started'),
    ),
    false,
  );
  console.log(
    'PASS: actual native VM locked UV build → cancellation/cleanup → staged retry/install → offline venv package import, plus cancelled preflight cannot launch late work',
  );
  console.log(
    'Environment image:',
    appleEnvironmentImage,
    '(exact public image; no fixture substitution)',
  );
  if (kernel)
    console.log(
      'Test-only per-VM kernel:',
      kernel,
      '(runtime default unchanged)',
    );
} finally {
  await sandbox.stop();
  await sandbox.apple.recover(core.hash(fs.realpathSync(root))).catch(() => {});
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
