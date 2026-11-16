import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pickle
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiide_rl import advanced


class AdvancedValidationTests(unittest.TestCase):
    def test_refuses_vulnerable_or_prerelease_torch_checkpoint_loaders(self):
        for version in ('2.9.1','2.6.0','2.10.0rc1','2.10.0.dev0','unknown',None):
            self.assertFalse(advanced.safe_torch_version(version))
        for version in ('2.10.0','2.10.0+cpu','2.11.1'):
            self.assertTrue(advanced.safe_torch_version(version))
    def test_rejects_invalid_actions_budgets_and_resume_paths(self):
        for value in ({"algorithm": "sac", "environment": "CartPole-v1"},
                      {"seeds": [42, 42]}, {"workers": 5}, {"timesteps": 2_000_000, "seeds": [1, 2]},
                      {"resume": "../../weights.zip"}, {"resume": "/tmp/model"},
                      {"learningRate": float("nan")}, {"seeds": [{}]}, {"customEnvironment": "eval(code)"}):
            with self.assertRaises(ValueError):
                advanced.config(value)

    def test_malformed_neural_metadata_is_rejected_without_loading_tensors(self):
        with tempfile.TemporaryDirectory() as root:
            c = advanced.config({})
            metadata = {"format": "aiide-sb3-v1", "config": c, "environment": c["environment"], "algorithm": c["algorithm"], "status": "completed"}
            for models in ([None], [{}], [{"seed": 42, "file": "../escape.zip", "sha256": "0" * 64, "timesteps": 100}], [{"seed": 42, "file": "seed-42.zip", "sha256": "invalid", "timesteps": 100}]):
                Path(root, "policy.json").write_text(json.dumps({**metadata, "models": models}))
                with self.assertRaisesRegex(ValueError, "checkpoint metadata"):
                    advanced.manifest(Path(root).resolve())


@unittest.skipUnless(os.environ.get("AIIDE_REAL_RL") == "1", "set AIIDE_REAL_RL=1 with the optional advanced environment for real CPU training")
class RealAdvancedTests(unittest.TestCase):
    def test_real_ppo_multiseed_process_workers_save_resume_and_safe_rollout(self):
        with tempfile.TemporaryDirectory() as root:
            previous = Path.cwd()
            os.chdir(root)
            try:
                c = {"algorithm": "ppo", "environment": "CartPole-v1", "timesteps": 8000,
                     "workers": 2, "seeds": [42, 43], "evalEpisodes": 5, "maxSteps": 200}
                logged = []
                policy = advanced.train(c, "rl-policies/ppo", lambda *row: logged.append(row))
                self.assertTrue(logged)
                self.assertEqual(policy["status"], "completed")
                self.assertEqual(len(policy["results"]), 2)
                self.assertGreater(policy["evaluation"]["meanReward"], policy["baseline"]["meanReward"] + 10)
                first = advanced.rollout("rl-policies/ppo/policy.json", 12345)
                self.assertEqual(first, advanced.rollout("rl-policies/ppo/policy.json", 12345))
                self.assertEqual(len(first["observations"]), len(first["actions"]) + 1)
                resumed = advanced.train({**c, "timesteps": 256, "resume": "rl-policies/ppo"}, "rl-policies/resumed")
                self.assertTrue(all(new["timesteps"] > old["timesteps"] for new, old in zip(resumed["models"], policy["models"])))
                self.assertTrue(Path("rl-policies/ppo/seed-42.zip").is_file())
                print("REAL PPO:", json.dumps({"baseline": policy["baseline"], "evaluation": policy["evaluation"], "checkpoints": resumed["models"]}))
                # Arbitrary SB3 data metadata is not deserialized: only weights_only tensors are read.
                sentinel = str(Path(root) / "must-not-exist")
                class Evil:
                    def __reduce__(self):
                        return (os.system, ("touch " + sentinel,))
                file = Path("rl-policies/ppo/seed-42.zip")
                with zipfile.ZipFile(file, "a") as archive:
                    archive.writestr("data", json.dumps({"danger": {":serialized:": base64.b64encode(pickle.dumps(Evil())).decode()}}))
                policy["models"][0]["sha256"] = hashlib.sha256(file.read_bytes()).hexdigest()
                Path("rl-policies/ppo/policy.json").write_text(json.dumps(policy))
                advanced.rollout("rl-policies/ppo/policy.json", 12345)
                self.assertFalse(Path(sentinel).exists())
            finally:
                os.chdir(previous)

    def test_real_sac_continuous_control_replay_resume(self):
        with tempfile.TemporaryDirectory() as root:
            previous = Path.cwd()
            os.chdir(root)
            try:
                c = {"algorithm": "sac", "environment": "Pendulum-v1", "timesteps": 8000,
                     "workers": 1, "seeds": [42], "evalEpisodes": 5, "maxSteps": 200}
                policy = advanced.train(c, "rl-policies/sac")
                self.assertGreater(policy["evaluation"]["meanReward"], policy["baseline"]["meanReward"] + 50)
                self.assertTrue(Path("rl-policies/sac/seed-42.npz").is_file())
                rollout = advanced.rollout("rl-policies/sac/policy.json", 12345)
                self.assertIsInstance(rollout["actions"][0], list)
                self.assertEqual(len(rollout["actions"][0]), 1)
                self.assertEqual(rollout["steps"], 200)
                resumed = advanced.train({**c, "timesteps": 64, "resume": "rl-policies/sac"}, "rl-policies/sac-resumed")
                self.assertGreater(resumed["models"][0]["timesteps"], policy["models"][0]["timesteps"])
                print("REAL SAC:", json.dumps({"baseline": policy["baseline"], "evaluation": policy["evaluation"]}))
                json.dumps(rollout, allow_nan=False)
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
