import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiide_rl import GridWorld, config, load_policy, rollout, train


class RLTests(unittest.TestCase):
    def test_seeded_reset_and_termination_are_explicit(self):
        env = GridWorld(size=3, max_steps=1, slip=0)
        first = env.reset(seed=10)
        self.assertEqual(env.reset(seed=10), first)
        _, _, terminated, truncated, _ = env.step(0)
        self.assertFalse(terminated)
        self.assertTrue(truncated)
        with self.assertRaisesRegex(ValueError, "Reset"):
            env.step(0)
        env.reset(seed=1)
        env.state = 7
        _, reward, terminated, truncated, _ = env.step(1)
        self.assertEqual(reward, 1)
        self.assertTrue(terminated)
        self.assertFalse(truncated)

    def test_training_improves_held_out_rollouts_and_roundtrips(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "first"
            first = train({"episodes": 1000}, path)
            second = train({"episodes": 1000}, Path(root) / "second")
            self.assertEqual(first["q"], second["q"])
            self.assertEqual(first["evaluation"], second["evaluation"])
            self.assertGreater(first["evaluation"]["successRate"], 0.95)
            self.assertGreater(first["evaluation"]["meanReward"], first["baseline"]["meanReward"] + 0.5)
            result = rollout(path / "policy.json", seed=99)
            self.assertEqual(result, rollout(path / "policy.json", seed=99))
            self.assertTrue(result["success"])
            self.assertEqual(len(result["states"]), len(result["actions"]) + 1)
            self.assertEqual(result["states"][-1], result["goal"])
            with self.assertRaises(FileExistsError):
                train({"episodes": 1}, path)

    def test_missing_gymnasium_has_actionable_guidance(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(sys.modules, {"gymnasium": None}):
            with self.assertRaisesRegex(ValueError, "requires gymnasium.*package manager"):
                train({"environment": "FrozenLake-v1"}, Path(root) / "policy")

    def test_training_logs_and_closes_wrapped_environments(self):
        wrappers = []
        class Wrapped:
            def __init__(self):
                self.env = GridWorld()
                self.closed = False
                wrappers.append(self)
            def reset(self, **kwargs):
                return self.env.reset(**kwargs)
            def step(self, action):
                return self.env.step(action)
            def close(self):
                self.closed = True
        logs = []
        with tempfile.TemporaryDirectory() as root, patch("aiide_rl.environment", lambda c: Wrapped()):
            train({"episodes": 3}, Path(root) / "policy", log=lambda *row: logs.append(row))
        self.assertEqual(len(logs), 3)
        self.assertTrue(all(row[2] > 0 for row in logs))
        self.assertEqual(len(wrappers), 3)
        self.assertTrue(all(env.closed for env in wrappers))

    @unittest.skipUnless(importlib.util.find_spec("gymnasium"), "optional gymnasium not installed")
    def test_real_frozenlake_adapter_logs_and_serializes_rollouts(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "policy"
            logs = []
            value = train({"environment": "FrozenLake-v1", "episodes": 100, "evalEpisodes": 10}, path,
                          log=lambda *row: logs.append(row))
            self.assertEqual(len(value["q"]), 16)
            self.assertEqual(len(logs), 100)
            result = rollout(path / "policy.json")
            self.assertEqual(result["actionNames"], ["left", "down", "right", "up"])
            if result["terminated"]:
                self.assertIn(result["states"][-1], [5, 7, 11, 12, 15])
            self.assertEqual(result["success"], result["states"][-1] == 15)
            json.dumps(result, allow_nan=False)
            self.assertLessEqual(result["steps"], value["config"]["maxSteps"])

    def test_rejects_unbounded_invalid_config_and_corrupt_policy(self):
        for value in [{"size": 1}, {"episodes": 1.5}, {"seed": True}, {"epsilon": float("nan")},
                      {"episodes": 20000, "maxSteps": 500}, {"customCode": "exec"}]:
            with self.assertRaises(ValueError):
                config(value)
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "policy"
            value = train({"episodes": 1}, path)
            original = copy.deepcopy(value)
            for table in [[[0] * 4], [[float("nan")] * 4] * 25, [[0] * 5] * 25, [["exec"] * 4] * 25]:
                value = {**original, "q": table}
                file = path / "policy.json"
                file.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, "Invalid Q"):
                    load_policy(file)


if __name__ == "__main__":
    unittest.main()
