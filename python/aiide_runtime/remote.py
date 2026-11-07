"""SSH job supervisor and JSON RPC helper. Standard-library only; Linux remote hosts."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time
import uuid

from aiide_runtime.artifacts import within, inspect
from aiide_sdk.spool import append

POLL_BYTES = 8 * 1024 * 1024


def atomic(file, value):
    temporary = str(file) + '.tmp'
    with open(temporary, 'w') as stream:
        json.dump(value, stream)
    os.replace(temporary, file)


def identity(pid):
    try:
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def hardware():
    result = {'platform': sys.platform, 'python': sys.version.split()[0], 'gpu': [], 'gpuStatus': 'unavailable'}
    try:
        lines = subprocess.check_output(['nvidia-smi', '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], text=True, timeout=2).splitlines()
        for line in lines:
            index, name, utilization, used, total, temperature = [x.strip() for x in line.split(',')]
            def number(v):
                try: return float(v)
                except ValueError: return None
            result['gpu'].append({'index': int(index), 'name': name, 'utilization_percent': number(utilization), 'memory_used_mb': number(used), 'memory_total_mb': number(total), 'temperature_c': number(temperature)})
        result['gpuStatus'] = 'available' if result['gpu'] else 'unavailable'
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return result


def supervise(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'job.json').read_text())
    status = {'status': 'running', 'pid': os.getpid(), 'identity': identity(os.getpid()), 'started': time.time() * 1000, 'dropped': 0}
    source = {'revision': None, 'commandFiles': {}}
    try:
        source['revision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=manifest['cwd'], stderr=subprocess.DEVNULL, text=True, timeout=2).strip()
    except (OSError, subprocess.SubprocessError):
        pass
    for arg in manifest['argv'][1:]:
        try:
            file = within(manifest['cwd'], arg)
            if file.is_file() and file.stat().st_size < 2 * 1024 * 1024:
                source['commandFiles'][arg] = hashlib.sha256(file.read_bytes()).hexdigest()
        except (OSError, ValueError):
            pass
    status['source'] = source
    spool = str(directory / 'events.jsonl')
    capture = manifest['capture']
    def event(kind, name, value):
        if not append(spool, '/events', {'events': [{'runId': manifest['id'], 'kind': kind, 'name': name, 'value': value, 'timestamp': time.time() * 1000}]}, capture):
            status['dropped'] += 1
    environment = {k: os.environ[k] for k in ['PATH', 'HOME', 'LANG', 'LD_LIBRARY_PATH', 'CUDA_HOME', 'CUDA_VISIBLE_DEVICES'] if k in os.environ}
    environment.update(manifest['env'])
    environment.update(PYTHONPATH=str(directory / 'runtime'), AIIDE_SPOOL_PATH=spool, AIIDE_RUN_ID=manifest['id'], AIIDE_PROJECT=manifest['project'], AIIDE_CAPTURE_CONTENT=str(capture).lower(), PYTHONUNBUFFERED='1', WANDB_MODE='disabled', LANGSMITH_TRACING='false')
    child = None
    stop = False
    def request_stop(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        child = subprocess.Popen(manifest['argv'], cwd=manifest['cwd'], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        selector = selectors.DefaultSelector()
        for stream, label in [(child.stdout, 'stdout'), (child.stderr, 'stderr')]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, label)
        stopped_at = None
        sampled = 0
        atomic(directory / 'status.json', status)
        while child.poll() is None or selector.get_map():
            if (stop or (directory / 'cancel').exists()) and stopped_at is None:
                stopped_at = time.monotonic()
                try: os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError: pass
            if stopped_at is not None and time.monotonic() - stopped_at > 3:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            for key, _ in selector.select(0.2):
                data = os.read(key.fileobj.fileno(), 8192)
                if data:
                    event('log', key.data, data.decode(errors='replace'))
                else:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
            if time.monotonic() - sampled >= 2:
                event('hardware', 'system', hardware())
                status['heartbeat'] = time.time() * 1000
                atomic(directory / 'status.json', status)
                sampled = time.monotonic()
        code = child.wait()
        status.update(status='cancelled' if stopped_at is not None else 'completed' if code == 0 else 'failed', exitCode=code)
    except Exception as error:
        status.update(status='failed', error=type(error).__name__)
        event('diagnostic', 'Supervisor failure', type(error).__name__)
    finally:
        if child and child.poll() is None:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait()
        status['ended'] = time.time() * 1000
        atomic(directory / 'status.json', status)


def main(request):
    action = request['action']
    if action == 'probe':
        result = hardware()
        root = Path(request['root'])
        result['directoryExists'] = root.is_absolute() and root.is_dir()
        result['writable'] = result['directoryExists'] and os.access(root, os.W_OK)
        return result
    root = Path(request['root'])
    if not root.is_absolute() or not root.is_dir() or str(root) == '/':
        raise ValueError('An existing absolute project directory is required')
    if action == 'artifact':
        return inspect(root, request['path'], request.get('framework'))
    if action == 'artifact.read':
        target = within(root, request['path'])
        if not target.is_file() or target.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('Download individual files up to 16 MB; keep larger checkpoints on the remote host')
        return {'data': base64.b64encode(target.read_bytes()).decode(), 'size': target.stat().st_size}
    job_id = request['id']
    if not re.fullmatch(r'[a-f0-9-]{36}', job_id) or str(uuid.UUID(job_id)) != job_id:
        raise ValueError('Invalid job ID')
    directory = within(root, '.aiide/jobs/' + job_id)
    if action == 'launch':
        if sys.platform != 'linux' or identity(os.getpid()) is None:
            raise ValueError('Remote training requires Linux with /proc process identity support')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = open(directory / 'launch.lock', 'a')
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (directory / 'job.json').exists():
            return {'accepted': True, 'existing': True}
        manifest = request['job']
        if manifest.get('checkpoint'):
            checked = inspect(root, manifest['checkpoint'], manifest['framework'])
            if not checked['resumable']:
                raise ValueError(checked['reason'])
        manifest.update(id=job_id, cwd=str(root.resolve()))
        # Write only the bundled SDK/runtime into this job's private directory.
        for file, content in request['files'].items():
            target = within(directory, 'runtime/' + file)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        atomic(directory / 'job.json', manifest)
        atomic(directory / 'status.json', {'status': 'launching', 'started': time.time() * 1000})
        with open(directory / 'supervisor.log', 'ab') as log:
            subprocess.Popen([sys.executable, str(directory / 'runtime/aiide_runtime/remote.py'), '--supervise', str(directory)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, env={**os.environ, 'PYTHONPATH': str(directory / 'runtime')})
        return {'accepted': True}
    if not (directory / 'status.json').is_file():
        return {'status': 'missing', 'records': [], 'cursor': request.get('cursor', 0)}
    status = json.loads((directory / 'status.json').read_text())
    if status['status'] == 'running' and identity(status['pid']) != status.get('identity'):
        status.update(status='interrupted', ended=time.time() * 1000)
        atomic(directory / 'status.json', status)
    if status['status'] == 'launching' and time.time() * 1000 - status['started'] > 30000:
        status.update(status='interrupted', error='Supervisor did not start', ended=time.time() * 1000)
    if action == 'cancel':
        (directory / 'cancel').touch(mode=0o600)
        return status
    if action != 'poll':
        raise ValueError('Unsupported remote operation')
    cursor = request.get('cursor', 0)
    if not isinstance(cursor, int) or cursor < 0:
        raise ValueError('Invalid telemetry cursor')
    records = []
    file = directory / 'events.jsonl'
    if file.exists():
        with open(file, 'rb') as stream:
            fcntl.flock(stream, fcntl.LOCK_SH)
            if cursor > os.fstat(stream.fileno()).st_size:
                raise ValueError('Remote journal was truncated')
            stream.seek(cursor)
            batch_bytes = 0
            for _ in range(200):
                line = stream.readline(256 * 1024 + 1)
                if not line or not line.endswith(b'\n'):
                    break
                if batch_bytes + len(line) > POLL_BYTES:
                    break
                records.append(json.loads(line))
                batch_bytes += len(line)
                cursor = stream.tell()
            status['hasMore'] = cursor < os.fstat(stream.fileno()).st_size
    try:
        status['dropped'] = int((directory / 'events.jsonl.dropped').read_text())
    except (OSError, ValueError):
        pass
    return {**status, 'records': records, 'cursor': cursor}


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--supervise':
        supervise(sys.argv[2])
    else:
        try:
            print(json.dumps({'ok': True, 'result': main(json.load(sys.stdin))}, allow_nan=False))
        except Exception as error:
            print(json.dumps({'ok': False, 'error': str(error)}))
