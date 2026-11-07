"""Small real PyTorch regression task; works offline on CPU or an available GPU."""
import time
import torch
from aiide_sdk import span, flush
from aiide_sdk.training import parameters, log_training, log_system, save_checkpoint, load_checkpoint

config = parameters({'steps': 20, 'learning_rate': 0.1, 'seed': 42, 'checkpoint_every': 10})
if not 1 <= int(config['steps']) <= 100000 or not 0 < float(config['learning_rate']) <= 1:
    raise ValueError('Use steps 1–100000 and learning_rate > 0 and <= 1')
torch.manual_seed(int(config['seed']))
torch.set_num_threads(1)
device = 'cuda' if torch.cuda.is_available() else 'cpu'
x = torch.linspace(-1, 1, 64, device=device).reshape(-1, 1)
y = 3 * x + 0.5
model = torch.nn.Linear(1, 1).to(device)
optimizer = torch.optim.SGD(model.parameters(), lr=float(config['learning_rate']))
start = load_checkpoint(model, optimizer)
with span('training.regression', device=device):
    for index in range(start, int(config['steps'])):
        before = time.monotonic()
        optimizer.zero_grad()
        loss = torch.nn.functional.mse_loss(model(x), y)
        loss.backward()
        norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 100.0)
        optimizer.step()
        step = index + 1
        log_training({'loss': loss.item(), 'validation.loss': torch.nn.functional.mse_loss(model(x), y).item(), 'learning_rate': optimizer.param_groups[0]['lr'], 'gradient_norm': norm.item(), 'samples_per_second': len(x) / max(0.000001, time.monotonic() - before), 'step': step, 'epoch': step}, step)
        if step % max(1, int(config['checkpoint_every'])) == 0:
            save_checkpoint(model, optimizer, f'checkpoints/step-{step}', step, config)
            log_system(step)
flush()
