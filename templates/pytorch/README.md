# PyTorch experiment

Run `uv sync --locked`, then use the IDE Training workspace. Configuration JSON supports `steps`, `learning_rate`, `seed`, and `checkpoint_every`. No model or data download is required. The regression model trains on generated data and logs actual loss, gradients, throughput, system measurements, and checkpoints.

Resume a recorded checkpoint in the Training panel with a larger `steps` value. The example restores model/optimizer and PyTorch RNG state with `weights_only=True`. Existing checkpoint directories are never overwritten. Use a new project or move old outputs before starting another fresh run with the same step numbers.
