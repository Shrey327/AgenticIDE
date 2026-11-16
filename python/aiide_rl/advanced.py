"""Bounded SB3 experiments with safe tensor-only checkpoint loading."""
from __future__ import annotations

from contextlib import closing
import hashlib
import io
import json
import math
import re
from pathlib import Path
import statistics
import time
import zipfile

DEFAULTS = {"algorithm": "ppo", "environment": "CartPole-v1", "timesteps": 10000,
            "workers": 1, "seeds": [42], "evalEpisodes": 10, "maxSteps": 500,
            "learningRate": 0.0003, "resume": None, "customEnvironment": None}


def config(value):
    if not isinstance(value, dict) or set(value) - set(DEFAULTS):
        raise ValueError("Unknown advanced RL configuration field")
    c = {**DEFAULTS, **value}
    custom = isinstance(c['environment'],str) and c['environment'].startswith('custom:')
    if c["algorithm"] not in ("ppo", "sac") or not (custom or c["environment"] in ("CartPole-v1", "Pendulum-v1")):
        raise ValueError("Choose PPO with CartPole/Pendulum, or SAC with Pendulum")
    if custom:
        from .custom import definition
        definition(c['customEnvironment'])
        if c['environment'] != 'custom:' + c['customEnvironment']['id']:
            raise ValueError('Custom registration does not match its environment ID')
    elif c['customEnvironment'] is not None:
        raise ValueError('Built-in environments cannot load custom factories')
    if c["algorithm"] == "sac" and c["environment"] == "CartPole-v1":
        raise ValueError("SAC requires continuous actions: choose Pendulum-v1")
    for key, low, high in [("timesteps", 64, 2_000_000), ("workers", 1, 4),
                           ("evalEpisodes", 1, 100), ("maxSteps", 10, 500)]:
        if type(c[key]) is not int or not low <= c[key] <= high:
            raise ValueError(f"{key} must be an integer between {low} and {high}")
    seeds = c["seeds"]
    if not isinstance(seeds, list) or not 1 <= len(seeds) <= 4 or any(type(seed) is not int or not 0 <= seed <= 2147480000 for seed in seeds) or len(set(seeds)) != len(seeds):
        raise ValueError("Choose 1–4 distinct integer training seeds")
    batch = 64 * c["workers"] if c["algorithm"] == "ppo" else c["workers"]
    if math.ceil(c["timesteps"] / batch) * batch * len(seeds) > 2_000_000:
        raise ValueError("Limit all seeds together to two million training steps")
    if type(c["learningRate"]) not in (int, float) or not math.isfinite(c["learningRate"]) or not 1e-6 <= c["learningRate"] <= 0.01:
        raise ValueError("Learning rate must be between 0.000001 and 0.01")
    if c["resume"] is not None:
        p = Path(c["resume"])
        if p.is_absolute() or len(p.parts) != 2 or p.parts[0] != "rl-policies" or not all(ch.isalnum() or ch in "_-" for ch in p.parts[1]):
            raise ValueError("Resume a policy directory under rl-policies/")
    return c


def libraries():
    try:
        import gymnasium as gym
        import numpy as np
        import torch
        if not safe_torch_version(torch.__version__):
            raise ValueError('Torch >=2.10.0 is required: older weights_only checkpoint loaders are vulnerable to CVE-2026-24747. Upgrade the advanced environment before training or loading a policy.')
        from stable_baselines3 import PPO, SAC
        return gym, np, torch, {"ppo": PPO, "sac": SAC}
    except ImportError as error:
        raise ValueError("Advanced RL requires stable-baselines3==2.7.1, gymnasium==1.2.2 and torch==2.10.0 in the project environment. For the RL template run uv sync --extra advanced --locked, or use your project's package manager.") from error


def safe_torch_version(version):
    match=re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:\+[A-Za-z0-9_.-]+)?',str(version))
    return bool(match and tuple(map(int,match.groups())) >= (2,10,0))


def status():
    from importlib.metadata import PackageNotFoundError, version
    versions = {}
    for package in ("stable-baselines3", "gymnasium", "torch"):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = None
    return {"available": bool(all(versions.values()) and safe_torch_version(versions['torch'])), "versions": versions,
            "setup": "uv sync --extra advanced --locked (RL template), or install stable-baselines3==2.7.1 gymnasium==1.2.2 torch==2.10.0 with the project's package manager. Torch older than 2.10.0 is blocked for CVE-2026-24747."}


def make_environment(c, seed):
    gym, _, _, _ = libraries()
    if c.get('customEnvironment'):
        from .custom import make
        return make(c['customEnvironment'],c['algorithm'],c['maxSteps'],seed)
    env = gym.make(c["environment"], max_episode_steps=c["maxSteps"])
    env.reset(seed=seed)
    env.action_space.seed(seed)
    return env


def summary(rows):
    rewards = [row["reward"] for row in rows]
    return {"meanReward": statistics.mean(rewards), "stdReward": statistics.pstdev(rewards),
            "meanSteps": statistics.mean(row["steps"] for row in rows), "episodes": len(rows),
            "successRate": statistics.mean(row["success"] for row in rows)}


def episode(model, c, seed, random_policy=False, trace=False):
    with closing(make_environment(c, seed)) as env:
        observation, _ = env.reset(seed=seed)
        observations, actions, rewards = [observation.tolist()], [], []
        for _ in range(c["maxSteps"]):
            action = env.action_space.sample() if random_policy else model.predict(observation, deterministic=True)[0]
            observation, reward, terminated, truncated, info = env.step(action)
            rewards.append(float(reward))
            if trace:
                observations.append(observation.tolist())
                actions.append(action.tolist() if hasattr(action, "tolist") else int(action))
            if terminated or truncated:
                break
        # Pendulum has no success terminal; its continuous return is the relevant score.
        success = bool(info.get('is_success',False)) if c.get('customEnvironment') else bool(c["environment"] == "CartPole-v1" and truncated and not terminated)
        return {"reward": sum(rewards), "steps": len(rewards), "success": success,
                "terminated": bool(terminated), "truncated": bool(truncated),
                **({"observations": observations, "actions": actions, "rewards": rewards} if trace else {})}


def evaluate(model, c, training_seed, random_policy=False):
    # A separate environment and seed range shared by random and learned policies.
    seeds = [1_000_000_000_000 + training_seed * 1000 + i for i in range(c["evalEpisodes"])]
    return summary([episode(model, c, seed, random_policy) for seed in seeds])


def safe_path(directory, name):
    root = Path(directory).resolve()
    current = Path(directory)
    for part in current.parents:
        if part.is_symlink():
            raise ValueError("Symbolic links are not allowed for RL checkpoints")
    target = current / name
    if current.is_symlink() or target.is_symlink() or not target.is_file() or not target.resolve().is_relative_to(root):
        raise ValueError("Choose a regular checkpoint in its policy directory")
    if target.stat().st_size > 100_000_000:
        raise ValueError("Checkpoint exceeds 100 MB")
    return target


def manifest(directory):
    file = safe_path(directory, "policy.json")
    if file.stat().st_size > 1_000_000:
        raise ValueError("Policy metadata exceeds 1 MB")
    data = json.loads(file.read_text())
    if not isinstance(data, dict) or data.get("format") != "aiide-sb3-v1":
        raise ValueError("Unsupported neural policy format")
    c = config(data.get("config"))
    if data.get("environment") != c["environment"] or data.get("algorithm") != c["algorithm"] or data.get("status") not in ("running", "completed", "interrupted"):
        raise ValueError("Neural policy metadata does not match its configuration")
    models = data.get("models")
    if not isinstance(models, list) or not 1 <= len(models) <= 4:
        raise ValueError("Policy has no usable checkpoints")
    for model in models:
        if (not isinstance(model, dict) or model.get("seed") not in c["seeds"] or
            model.get("file") != f"seed-{model['seed']}.zip" or
            not isinstance(model.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", model["sha256"]) or
            type(model.get("timesteps")) is not int or not 0 <= model["timesteps"] <= 100_000_000):
            raise ValueError("Invalid neural checkpoint metadata")
        if model.get("replay") and (model["replay"] != f"seed-{model['seed']}.npz" or not isinstance(model.get("replaySha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", model["replaySha256"])):
            raise ValueError("Invalid replay checkpoint metadata")
    if len({model["seed"] for model in models}) != len(models):
        raise ValueError("Neural checkpoint seeds must be distinct")
    return data


def restore(model, directory, record):
    """Never call SB3.load: its JSON metadata can contain executable cloudpickle."""
    _, np, torch, _ = libraries()
    file = safe_path(directory, record["file"])
    if hashlib.sha256(file.read_bytes()).hexdigest() != record["sha256"]:
        raise ValueError("Checkpoint changed since it was saved")
    parameters = {}
    with zipfile.ZipFile(file) as archive:
        members = archive.infolist()
        if len(members) > 30 or sum(info.file_size for info in members) > 100_000_000:
            raise ValueError("Checkpoint archive exceeds safe bounds")
        for name in model.get_parameters():
            parameters[name] = torch.load(io.BytesIO(archive.read(name + ".pth")), map_location="cpu", weights_only=True)
        model.set_parameters(parameters, exact_match=True, device="cpu")
        variables = torch.load(io.BytesIO(archive.read("pytorch_variables.pth")), map_location="cpu", weights_only=True)
        if getattr(model, "log_ent_coef", None) is not None and variables.get("log_ent_coef") is not None:
            model.log_ent_coef.data.copy_(variables["log_ent_coef"])
    model.num_timesteps = int(record["timesteps"])
    if record.get("replay"):
        replay = safe_path(directory, record["replay"])
        if hashlib.sha256(replay.read_bytes()).hexdigest() != record.get("replaySha256"):
            raise ValueError("Replay buffer changed since it was saved")
        with zipfile.ZipFile(replay) as archive:
            fields = ("observations", "next_observations", "actions", "rewards", "dones", "timeouts", "pos", "full")
            if len(archive.infolist()) != len(fields) or sum(info.file_size for info in archive.infolist()) > 100_000_000:
                raise ValueError("Replay buffer exceeds safe bounds")
            # Validate dimensions before NumPy allocates arrays from a user-edited NPY header.
            for field in fields:
                expected = np.asarray(getattr(model.replay_buffer, field))
                with archive.open(field + ".npy") as stream:
                    if np.lib.format.read_magic(stream) != (1, 0):
                        raise ValueError("Unsupported replay array format")
                    shape, _, dtype = np.lib.format.read_array_header_1_0(stream)
                    if shape != expected.shape or dtype != expected.dtype or dtype.hasobject:
                        raise ValueError("Invalid replay array dimensions or dtype")
        with np.load(replay, allow_pickle=False) as data:
            buffer = model.replay_buffer
            for field in ("observations", "next_observations", "actions", "rewards", "dones", "timeouts"):
                value = data[field]
                if value.shape != getattr(buffer, field).shape or not np.isfinite(value).all():
                    raise ValueError("Invalid replay buffer shape or values")
                getattr(buffer, field)[:] = value
            buffer.pos, buffer.full = int(data["pos"]), bool(data["full"])
            if not 0 <= buffer.pos < buffer.buffer_size:
                raise ValueError("Invalid replay buffer cursor")


def checkpoint(model, directory, seed):
    _, np, _, _ = libraries()
    file = directory / f"seed-{seed}.zip"
    temporary = directory / f"seed-{seed}.tmp.zip"
    model.save(temporary)
    temporary.replace(file)
    record = {"seed": seed, "file": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "timesteps": int(model.num_timesteps)}
    if getattr(model, "replay_buffer", None) is not None:
        buffer = model.replay_buffer
        replay = directory / f"seed-{seed}.npz"
        temporary = directory / f"seed-{seed}.tmp.npz"
        np.savez_compressed(temporary, **{field: getattr(buffer, field) for field in ("observations", "next_observations", "actions", "rewards", "dones", "timeouts")}, pos=buffer.pos, full=buffer.full)
        temporary.replace(replay)
        record.update(replay=replay.name, replaySha256=hashlib.sha256(replay.read_bytes()).hexdigest())
    return record


def create_model(c, env, seed):
    _, _, torch, algorithms = libraries()
    torch.set_num_threads(1)
    options = {"policy_kwargs": {"net_arch": [64, 64]}, "seed": seed, "device": "cpu", "verbose": 0, "learning_rate": c["learningRate"]}
    if c["algorithm"] == "ppo":
        options.update(n_steps=64, batch_size=64, n_epochs=5)
    else:
        options.update(buffer_size=10000, batch_size=64, learning_starts=64, gradient_steps=1)
    return algorithms[c["algorithm"]]("MlpPolicy", env, **options)


def train(input, output, log=None):
    from functools import partial
    c = config(input)
    _, _, _, _ = libraries()
    from stable_baselines3.common.callbacks import BaseCallback
    from stable_baselines3.common.env_checker import check_env
    from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv
    with closing(make_environment(c,c['seeds'][0])) as checked:
        check_env(checked,warn=True,skip_render_check=True)
    directory = Path(output)
    directory.mkdir(parents=True, exist_ok=False)
    if directory.is_symlink():
        raise ValueError("Symbolic links are not allowed")
    previous = manifest(c["resume"]) if c["resume"] else None
    if previous and any(previous["config"].get(key) != c[key] for key in ("algorithm", "environment", "workers", "seeds", "maxSteps", "learningRate", "customEnvironment")):
        raise ValueError("Resume requires the same algorithm, environment, workers, seeds, episode limit and learning rate")
    result = {"format": "aiide-sb3-v1", "created": int(time.time() * 1000), "environment": c["environment"],
              "algorithm": c["algorithm"], "config": c, "models": [], "results": [], "status": "running", "packages": status()["versions"]}
    def write():
        temporary = directory / "policy.tmp.json"
        temporary.write_text(json.dumps(result, allow_nan=False))
        temporary.replace(directory / "policy.json")
    write()
    for seed in c["seeds"]:
        with closing(make_environment(c, seed)) as checked:
            check_env(checked, warn=True, skip_render_check=True)
        factories = [partial(_monitored_environment, c, seed + worker) for worker in range(c["workers"])]
        with closing(SubprocVecEnv(factories, start_method="spawn") if c["workers"] > 1 else DummyVecEnv(factories)) as env:
            model = create_model(c, env, seed)
            if previous:
                record = next((item for item in previous["models"] if item["seed"] == seed), None)
                if not record and previous["status"] == "completed":
                    raise ValueError(f"No checkpoint for seed {seed} in resume policy")
                if record:
                    restore(model, c["resume"], record)
            baseline = evaluate(model, c, seed, random_policy=True)
            record = None
            def save():
                nonlocal record
                record = checkpoint(model, directory, seed)
                result["models"] = [item for item in result["models"] if item["seed"] != seed] + [record]
                write()
            class Metrics(BaseCallback):
                last_report = -1
                def _on_step(self):
                    for info in self.locals.get("infos", []):
                        if "episode" in info and log and self.num_timesteps - self.last_report >= max(1, c["timesteps"] // 200):
                            log(self.num_timesteps, float(info["episode"]["r"]), int(info["episode"]["l"]), seed)
                            self.last_report = self.num_timesteps
                    if self.n_calls % max(64, c["timesteps"] // c["workers"] // 10) == 0:
                        save()
                    return True
            try:
                model.learn(total_timesteps=c["timesteps"], reset_num_timesteps=not bool(previous), callback=Metrics())
                evaluation = evaluate(model, c, seed)
                result["results"].append({"seed": seed, "baseline": baseline, "evaluation": evaluation})
            except BaseException:
                result["status"] = "interrupted"
                raise
            finally:
                save()
    result["status"] = "completed"
    result["baseline"] = _aggregate(result["results"], "baseline")
    result["evaluation"] = _aggregate(result["results"], "evaluation")
    write()
    return result


def _monitored_environment(c, seed):
    from stable_baselines3.common.monitor import Monitor
    return Monitor(make_environment(c, seed))


def _aggregate(results, key):
    means = [row[key]["meanReward"] for row in results]
    return {"meanReward": statistics.mean(means), "stdReward": statistics.pstdev(means),
            "meanSteps": statistics.mean(row[key]["meanSteps"] for row in results),
            "successRate": statistics.mean(row[key]["successRate"] for row in results),
            "episodes": sum(row[key]["episodes"] for row in results), "seeds": len(results)}


def rollout(file, seed=12345, custom_environment=None, allow_custom=True):
    if type(seed) is not int or not 0 <= seed <= 2147483647:
        raise ValueError("Choose an integer rollout seed between 0 and 2147483647")
    directory = Path(file).parent
    data = manifest(directory)
    c = config(data["config"])
    if c.get('customEnvironment') is not None:
        if not allow_custom:
            raise ValueError('Custom environments require an explicit IDE execution action')
        if c['customEnvironment'] != custom_environment:
            raise ValueError('Custom rollout requires the exact reviewed environment registration')
    with closing(make_environment(c, seed)) as env:
        model = create_model(c, env, data["models"][0]["seed"])
        restore(model, directory, data["models"][0])
        result = episode(model, c, seed, trace=True)
    names = ["cart position", "cart velocity", "pole angle", "pole angular velocity"] if c["environment"] == "CartPole-v1" else ["cos(angle)", "sin(angle)", "angular velocity"]
    if c.get('customEnvironment'):
        names = [f'observation {index}' for index in range(len(result['observations'][0]))]
    return {**result, "environment": c["environment"], "algorithm": c["algorithm"], "seed": seed, "observationNames":names}
