"""Optional training integrations; checkpoints are resumed only at the caller's request."""
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
from . import artifact, metric, _event

_sample = None


def parameters(defaults=None):
    result = dict(defaults or {})
    result.update(json.loads(os.getenv('AIIDE_TRAIN_CONFIG', '{}')))
    return result


def log_training(metrics, step=None):
    for name, value in metrics.items():
        if hasattr(value, 'item'):
            value = value.item()
        metric(name, value, step)


def log_system(step=None):
    global _sample
    usage = resource.getrusage(resource.RUSAGE_SELF)
    cpu = usage.ru_utime + usage.ru_stime
    now = time.monotonic()
    metric('process.peak_rss_bytes', usage.ru_maxrss * (1 if sys.platform == 'darwin' else 1024), step)
    metric('process.cpu_seconds', cpu, step)
    if _sample:
        metric('process.cpu_percent', 100 * (cpu - _sample[1]) / max(0.001, now - _sample[0]), step)
    _sample = (now, cpu)
    if sys.platform == 'linux':
        try:
            for line in Path('/proc/self/status').read_text().splitlines():
                if line.startswith('VmRSS:'):
                    metric('process.rss_bytes', int(line.split()[1]) * 1024, step)
        except (OSError, ValueError):
            pass
    available = []
    try:
        lines = subprocess.check_output(['nvidia-smi', '--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], text=True, timeout=2).splitlines()
        for line in lines:
            index, *values = [v.strip() for v in line.split(',')]
            for name, value in zip(['utilization_percent', 'memory_used_mb', 'memory_total_mb', 'temperature_c'], values):
                try:
                    number = float(value)
                except ValueError:
                    continue
                metric(f'gpu.{index}.{name}', number, step)
                available.append(f'gpu.{index}.{name}')
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        import torch
        if torch.cuda.is_available():
            for index in range(torch.cuda.device_count()):
                metric(f'gpu.{index}.allocated_bytes', torch.cuda.memory_allocated(index), step)
                metric(f'gpu.{index}.reserved_bytes', torch.cuda.memory_reserved(index), step)
    except ImportError:
        pass
    _event('hardware', 'availability', {'gpuStatus': 'available' if available else 'unavailable', 'measurements': available}, step)


def _digest(file):
    checksum = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def save_checkpoint(model, optimizer, directory, step, config=None):
    import torch
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    file = directory / 'checkpoint.pt'
    state = {'model': model.state_dict(), 'optimizer': optimizer.state_dict(), 'step': int(step), 'torch_rng': torch.get_rng_state(), 'config': dict(config or {})}
    if torch.cuda.is_available():
        state['cuda_rng'] = torch.cuda.get_rng_state_all()
    torch.save(state, file)
    digest = _digest(file)
    (directory / 'aiide-checkpoint.json').write_text(json.dumps({'format': 'aiide-pytorch-v1', 'file': file.name, 'step': int(step), 'sha256': digest}))
    artifact('checkpoint', directory, framework='pytorch', step=int(step))
    return str(directory)


def load_checkpoint(model, optimizer, directory=None):
    import torch
    directory = directory or os.getenv('AIIDE_RESUME_CHECKPOINT')
    if not directory:
        return 0
    directory = Path(directory)
    metadata = json.loads((directory / 'aiide-checkpoint.json').read_text())
    if metadata.get('format') != 'aiide-pytorch-v1' or metadata.get('file') != 'checkpoint.pt':
        raise ValueError('Unsupported checkpoint format')
    file = directory / 'checkpoint.pt'
    if file.is_symlink() or _digest(file) != metadata['sha256']:
        raise ValueError('Checkpoint checksum mismatch')
    state = torch.load(file, map_location='cpu', weights_only=True)
    model.load_state_dict(state['model'])
    optimizer.load_state_dict(state['optimizer'])
    torch.set_rng_state(state['torch_rng'])
    if 'cuda_rng' in state and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(state['cuda_rng'])
    return int(state['step'])


def trainer_callback():
    from transformers import TrainerCallback

    class AIIDETrainerCallback(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            if state.is_world_process_zero:
                values = {**(logs or {}), 'step': state.global_step, 'epoch': state.epoch or 0, 'total_steps': state.max_steps}
                log_training(values, state.global_step)
                log_system(state.global_step)

        def on_save(self, args, state, control, **kwargs):
            if state.is_world_process_zero:
                artifact('checkpoint', os.path.join(args.output_dir, f'checkpoint-{state.global_step}'), framework='transformers', step=state.global_step)

    return AIIDETrainerCallback()
