"""Dependency-free, seeded tabular RL with portable JSON policies."""
from __future__ import annotations

from contextlib import closing
import json
import math
from pathlib import Path
import random
import time

DEFAULTS = {"environment": "gridworld", "size": 5, "episodes": 1500, "maxSteps": 100, "learningRate": 0.2,
            "discount": 0.95, "epsilon": 0.3, "slip": 0.1, "seed": 42, "evalEpisodes": 100}


def config(input):
    if not isinstance(input, dict) or set(input) - set(DEFAULTS):
        raise ValueError("Unknown RL configuration field")
    value = {**DEFAULTS, **input}
    if value["environment"] not in ("gridworld", "FrozenLake-v1"):
        raise ValueError("Choose gridworld or FrozenLake-v1")
    for key, low, high in [("size", 3, 12), ("episodes", 1, 20000), ("maxSteps", 5, 500),
                           ("seed", 0, 2147483647), ("evalEpisodes", 1, 500)]:
        if type(value[key]) is not int or not low <= value[key] <= high:
            raise ValueError(f"{key} must be an integer between {low} and {high}")
    for key, low, high in [("learningRate", 0.001, 1), ("discount", 0, 0.999),
                           ("epsilon", 0.01, 1), ("slip", 0, 0.5)]:
        if type(value[key]) not in (int, float) or not math.isfinite(value[key]) or not low <= value[key] <= high:
            raise ValueError(f"{key} must be between {low} and {high}")
    if value["episodes"] * value["maxSteps"] > 2_000_000:
        raise ValueError("Limit training to two million steps")
    return value


class GridWorld:
    """Gymnasium-style reset/step contract; no Gymnasium dependency or registration."""
    def __init__(self, size=5, max_steps=100, slip=0.1):
        self.size, self.max_steps, self.slip = size, max_steps, slip
        self.rng = random.Random()
        self.state = None
        self.steps = 0
        self.done = True

    def reset(self, *, seed=None):
        if seed is not None:
            self.rng.seed(seed)
        # Random starts train the entire table; the bottom-right cell is the goal.
        self.state = self.rng.randrange(self.size * self.size - 1)
        self.steps, self.done = 0, False
        return self.state, {}

    def step(self, action):
        if self.done:
            raise ValueError("Reset the environment before stepping")
        if type(action) is not int or action not in range(4):
            raise ValueError("Action must be 0 (up), 1 (right), 2 (down), or 3 (left)")
        if self.rng.random() < self.slip:
            action = self.rng.randrange(4)
        row, col = divmod(self.state, self.size)
        dr, dc = [(-1, 0), (0, 1), (1, 0), (0, -1)][action]
        row, col = max(0, min(self.size - 1, row + dr)), max(0, min(self.size - 1, col + dc))
        self.state = row * self.size + col
        self.steps += 1
        terminated = self.state == self.size * self.size - 1
        truncated = not terminated and self.steps >= self.max_steps
        self.done = terminated or truncated
        return self.state, 1.0 if terminated else -0.02, terminated, truncated, {}


    def close(self):
        pass


def environment(c):
    if c["environment"] == "gridworld":
        return GridWorld(c["size"], c["maxSteps"], c["slip"])
    try:
        import gymnasium as gym
    except ImportError as error:
        raise ValueError("FrozenLake-v1 requires gymnasium in the project environment; install it with your project's package manager, or choose built-in GridWorld") from error
    return gym.make("FrozenLake-v1", map_name="4x4", is_slippery=True, max_episode_steps=c["maxSteps"])


def states(c):
    return c["size"] ** 2 if c["environment"] == "gridworld" else 16


def episode(env, q, seed, rng, random_policy=False, trace=False):
    state, _ = env.reset(seed=seed)
    states, actions, rewards = [int(state)], [], []
    while True:
        action = rng.randrange(4) if random_policy else max(range(4), key=lambda a: q[state][a])
        state, reward, terminated, truncated, _ = env.step(action)
        rewards.append(float(reward))
        if trace:
            states.append(int(state))
            actions.append(int(action))
        if terminated or truncated:
            return {"reward": sum(rewards), "steps": len(rewards), "success": bool(terminated and reward > 0),
                    "terminated": bool(terminated), "truncated": bool(truncated),
                    **({"states": states, "actions": actions, "rewards": rewards} if trace else {})}


def evaluate(q, c, random_policy=False):
    rng = random.Random(c["seed"] + 2_000_000)
    # Evaluation randomness is independent of training and identical for each policy.
    with closing(environment(c)) as env:
        rows = [episode(env, q, c["seed"] + 1_000_000 + i, rng, random_policy)
                for i in range(c["evalEpisodes"])]
    return {"meanReward": sum(r["reward"] for r in rows) / len(rows),
            "successRate": sum(r["success"] for r in rows) / len(rows),
            "meanSteps": sum(r["steps"] for r in rows) / len(rows), "episodes": len(rows)}


def train(input, output, log=None):
    c = config(input)
    rng = random.Random(c["seed"])
    q = [[0.0] * 4 for _ in range(states(c))]
    baseline = evaluate(q, c, random_policy=True)
    with closing(environment(c)) as env:
        for index in range(c["episodes"]):
            state, _ = env.reset(seed=c["seed"] + index)
            reward_sum, episode_steps = 0.0, 0
            epsilon = max(0.01, c["epsilon"] * (1 - index / c["episodes"]))
            while True:
                action = rng.randrange(4) if rng.random() < epsilon else max(range(4), key=lambda a: q[state][a])
                next_state, reward, terminated, truncated, _ = env.step(action)
                episode_steps += 1
                # Time-limit truncation is not terminal: keep its bootstrap value.
                target = reward + (0 if terminated else c["discount"] * max(q[next_state]))
                q[state][action] += c["learningRate"] * (target - q[state][action])
                state, reward_sum = next_state, reward_sum + reward
                if terminated or truncated:
                    break
            if log and (index % max(1, c["episodes"] // 100) == 0 or index == c["episodes"] - 1):
                log(index + 1, reward_sum, episode_steps)
    result = {"format": "aiide-rl-v1", "environment": c["environment"], "algorithm": "q-learning",
              "created": int(time.time() * 1000), "config": c, "q": q,
              "baseline": baseline, "evaluation": evaluate(q, c)}
    directory = Path(output)
    directory.mkdir(parents=True, exist_ok=False)
    # Exclusive creation never replaces a user's previous policy.
    with (directory / "policy.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, allow_nan=False)
    return result


def load_policy(file):
    file = Path(file)
    if file.is_symlink() or file.stat().st_size > 1_000_000:
        raise ValueError("Policy must be a regular JSON file under 1 MB")
    value = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("format") != "aiide-rl-v1" or value.get("environment") not in ("gridworld", "FrozenLake-v1"):
        raise ValueError("Unsupported policy format")
    c = config(value.get("config"))
    if value["environment"] != c["environment"]:
        raise ValueError("Policy environment does not match configuration")
    q = value.get("q")
    if (not isinstance(q, list) or len(q) != states(c) or
        any(not isinstance(row, list) or len(row) != 4 or
            any(type(v) not in (float, int) or not math.isfinite(v) or abs(v) > 1e6 for v in row) for row in q)):
        raise ValueError("Invalid Q table")
    return value


def rollout(file, seed=12345):
    if type(seed) is not int or not 0 <= seed <= 2147483647:
        raise ValueError("Seed must be an integer between 0 and 2147483647")
    policy = load_policy(file)
    c = policy["config"]
    with closing(environment(c)) as env:
        result = episode(env, policy["q"], seed, random.Random(seed), trace=True)
    return {**result, "size": c["size"] if c["environment"] == "gridworld" else 4,
            "goal": states(c) - 1,
            "actionNames": ["up", "right", "down", "left"] if c["environment"] == "gridworld" else ["left", "down", "right", "up"],
            "holes": [] if c["environment"] == "gridworld" else [5, 7, 11, 12], "seed": seed}
