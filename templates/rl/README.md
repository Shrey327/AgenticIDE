# Local RL environment

Run **setup** to create the locked Python environment, then **example** to train a seeded Q-learning policy in GridWorld. **Train → RL environments** configures training, compares independent evaluation episodes with random actions, charts rewards, and inspects a policy rollout step by step.

The project copies `aiide_rl` and `aiide_sdk`, so `uv run main.py` also works outside the IDE. Tabular policies are plain JSON under `rl-policies/`; earlier runs are never overwritten. GridWorld uses randomized starting cells, a bottom-right goal, and configurable action slip.

For the standard slippery 4×4 **Gymnasium FrozenLake-v1** environment, add `gymnasium` using your project's package manager (`uv add gymnasium` in this template), then choose it in RL environments. Grid size and slip settings apply only to GridWorld. FrozenLake reports success only at its goal, not when falling in a terminal hole.

For **PPO** (CartPole/Pendulum) and **SAC** (Pendulum), run `uv sync --extra advanced --locked`, then select the algorithm in **RL environments** and recheck dependencies. You can configure spawned parallel environments, multiple training seeds, held-out evaluation and additional training from checkpoints. Neural policies include safe tensor-loaded ZIP checkpoints; SAC also saves numeric replay data. The interactive rollout shows CartPole/Pendulum state, observations, actions and rewards. This is CPU environment-control RL; language-model GRPO/RLHF, distributed GPU rollouts, robotics simulation and custom untrusted environment plugins are not implemented.

For a custom task, edit `custom_target.py` and use **Review a custom environment** in the RL panel. Its `make_env(parameters)` returns a Gymnasium environment with either discrete or continuous actions (`{"continuous":false,"target":0.7}` by default). Preview/review its sources, authorize local execution and register it, then run the checker and select `custom:<id>` for PPO/SAC. Source changes require a new review; custom code executes with your user privileges and is never exposed as host execution to MCP agents. The ordinary policy/evaluation/checkpoint/rollout flow applies.
