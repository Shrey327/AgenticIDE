"""Training helpers import optional frameworks only when requested."""
import os
import resource
from . import artifact, metric


def log_training(metrics, step=None):
    for name, value in metrics.items():
        if hasattr(value, "item"):
            value = value.item()
        metric(name, value, step)


def log_system(step=None):
    import sys
    usage = resource.getrusage(resource.RUSAGE_SELF)
    metric("process.peak_rss_bytes", usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024), step)
    metric("process.cpu_seconds", usage.ru_utime + usage.ru_stime, step)
    # GPU statistics are emitted only when the CUDA runtime actually supports them.
    try:
        import torch
        if torch.cuda.is_available():
            metric("gpu.memory_allocated_bytes", torch.cuda.memory_allocated(), step)
            metric("gpu.memory_reserved_bytes", torch.cuda.memory_reserved(), step)
    except ImportError:
        pass


def trainer_callback():
    from transformers import TrainerCallback

    class AIIDETrainerCallback(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            if state.is_world_process_zero:
                log_training(logs or {}, state.global_step)
                log_system(state.global_step)

        def on_save(self, args, state, control, **kwargs):
            if state.is_world_process_zero:
                artifact("checkpoint", os.path.join(args.output_dir, f"checkpoint-{state.global_step}"), step=state.global_step)

    return AIIDETrainerCallback()
