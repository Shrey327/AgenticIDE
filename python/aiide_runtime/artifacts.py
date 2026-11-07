"""Artifact paths remain inside the project; checkpoint inspection never loads weights."""
import json
import os
from pathlib import Path


def within(root, relative):
    root = Path(root).resolve()
    candidate = Path(relative)
    if candidate.is_absolute() or not candidate.parts or '..' in candidate.parts:
        raise ValueError('Artifact must be a relative project path')
    current = root
    for part in candidate.parts:
        current /= part
        if current.is_symlink():
            raise ValueError('Artifact symlinks are not allowed')
    if not current.resolve().is_relative_to(root):
        raise ValueError('Artifact escapes project')
    return current


def inspect(root, relative, framework=None):
    target = within(root, relative)
    if not target.exists():
        return {'path': relative, 'available': False, 'resumable': False, 'reason': 'Artifact is missing'}
    if target.is_file():
        return {'path': relative, 'available': True, 'size': target.stat().st_size, 'resumable': False, 'reason': 'Select a checkpoint directory'}
    files = []
    for entry in sorted(target.iterdir()):
        if entry.is_symlink():
            continue
        if len(files) == 100:
            break
        files.append({'name': entry.name, 'directory': entry.is_dir(), 'size': entry.stat().st_size if entry.is_file() else None})
    result = {'path': relative, 'available': True, 'files': files, 'resumable': False, 'reason': 'No supported resume metadata'}
    names = {f['name'] for f in files}
    if framework == 'transformers':
        if not {'trainer_state.json', 'optimizer.pt', 'scheduler.pt'}.issubset(names):
            result['reason'] = 'Trainer state, optimizer, or scheduler is missing'
        elif not any(n in names for n in ['model.safetensors', 'pytorch_model.bin', 'adapter_model.safetensors', 'model.safetensors.index.json', 'pytorch_model.bin.index.json']):
            result['reason'] = 'Model/adapter weights are missing'
        elif not any(n.startswith('rng_state') for n in names):
            result['reason'] = 'RNG state is missing'
        else:
            state = json.loads(within(root, str(target.relative_to(Path(root).resolve()) / 'trainer_state.json')).read_text())
            result.update(resumable=True, framework='transformers', step=state.get('global_step'), reason='Trainer checkpoint with optimizer, scheduler and RNG state')
    elif framework == 'pytorch' and 'aiide-checkpoint.json' in names:
        metadata = json.loads((target / 'aiide-checkpoint.json').read_text())
        payload = within(root, str(target.relative_to(Path(root).resolve()) / metadata.get('file', 'checkpoint.pt')))
        if metadata.get('format') == 'aiide-pytorch-v1' and metadata.get('file') == 'checkpoint.pt' and isinstance(metadata.get('step'), int) and payload.is_file():
            result.update(resumable=True, framework='pytorch', step=metadata.get('step'), reason='AIIDE PyTorch checkpoint', metadata=metadata)
    return result
