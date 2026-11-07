import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import aiide_lab as lab

HAS_SKLEARN = importlib.util.find_spec("sklearn") is not None


class GridTests(unittest.TestCase):
    def test_grid_expands_typed_values(self):
        config = {"task": "regression", "models": [{"id": "random_forest", "grid": {"n_estimators": "50, 100", "max_depth": "None, 8", "min_samples_leaf": "1"}}]}
        plan = lab.trials(config)
        self.assertEqual(len(plan), 4)
        self.assertIn(("random_forest", {"n_estimators": 100, "max_depth": None, "min_samples_leaf": 1}), plan)

    def test_random_search_samples_without_repeats(self):
        config = {"task": "regression", "search": "random", "trials": 3, "seed": 1, "models": [{"id": "ridge", "grid": {"alpha": "0.1, 1, 10, 100"}}]}
        plan = lab.trials(config)
        self.assertEqual(len(plan), 3)
        self.assertEqual(len({p[1]["alpha"] for p in plan}), 3)

    def test_rejects_bad_values_and_huge_grids(self):
        with self.assertRaisesRegex(ValueError, "not a valid int"):
            lab.trials({"task": "regression", "models": [{"id": "knn", "grid": {"n_neighbors": "five"}}]})
        with self.assertRaisesRegex(ValueError, "not a valid choice"):
            lab.trials({"task": "regression", "models": [{"id": "knn", "grid": {"weights": "__import__('os')"}}]})
        with self.assertRaisesRegex(ValueError, "max 200"):
            lab.trials({"task": "regression", "models": [{"id": "ridge", "grid": {"alpha": ", ".join(str(i) for i in range(1, 202))}}]})
        with self.assertRaisesRegex(ValueError, "Unknown model"):
            lab.trials({"task": "classification", "models": [{"id": "ridge"}]})


@unittest.skipUnless(HAS_SKLEARN, "scikit-learn not installed")
class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.directory.name)
        rows = ["size,city,rooms,price"]
        for i in range(120):
            city = ["north", "south", ""][i % 3]
            rooms = "" if i % 17 == 0 else str(1 + i % 4)
            rows.append(f"{50 + i},{city},{rooms},{1000 + 20 * i + (300 if city == 'north' else 0)}")
        pathlib.Path("homes.csv").write_text("\n".join(rows) + "\n")

    def tearDown(self):
        os.chdir(self.cwd)
        self.directory.cleanup()

    def test_inspect_sweep_final_predict(self):
        profile = lab.inspect({"file": "homes.csv"})
        self.assertEqual(profile["rows"], 120)
        self.assertEqual(profile["tasks"]["price"], "regression")
        self.assertEqual({c["name"]: c["type"] for c in profile["columns"]}["city"], "categorical")
        events = []
        config = {"file": "homes.csv", "target": "price", "task": "regression", "metrics": ["rmse", "r2"], "primary": "rmse",
                  "validation": {"type": "kfold", "folds": 3},
                  "models": [{"id": "ridge", "grid": {"alpha": "0.1, 1"}}, {"id": "random_forest", "grid": {"n_estimators": "20", "max_depth": "4", "min_samples_leaf": "1"}}]}
        with patch("aiide_sdk._event", lambda kind, name, value, step=None: events.append((kind, value))):
            lab.sweep(config)
        trials = [v for k, v in events if k == "trial"]
        self.assertEqual(len(trials), 3)
        self.assertTrue(all(t["status"] == "completed" and t["scores"]["r2"] > 0.8 for t in trials))
        with patch("aiide_sdk._event", lambda *a, **k: None):
            lab.final({**config, "model": "ridge", "params": {"alpha": "1"}, "name": "Homes ridge"})
        directory = next(pathlib.Path("models").iterdir())
        meta = json.loads((directory / "model.json").read_text())
        self.assertEqual([f["name"] for f in meta["features"]], ["size", "city", "rooms"])
        result = lab.predict({"model": str(directory), "rows": [{"size": "100", "city": "north", "rooms": "2"}, {"size": "100", "city": "unseen"}]})
        self.assertEqual(result["count"], 2)
        self.assertGreater(result["predictions"][0]["prediction"], result["predictions"][1]["prediction"])
        with self.assertRaisesRegex(ValueError, "must be a number"):
            lab.predict({"model": str(directory), "rows": [{"size": "big"}]})

    def test_classification_reports_probabilities(self):
        config = {"file": "homes.csv", "target": "city", "task": "classification", "features": ["size", "price"],
                  "model": "logistic", "params": {"C": "1"}}
        with patch("aiide_sdk._event", lambda *a, **k: None):
            lab.final(config)
        directory = next(pathlib.Path("models").iterdir())
        result = lab.predict({"model": str(directory), "rows": [{"size": "60", "price": "2500"}]})
        self.assertIn(result["predictions"][0]["prediction"], {"north", "south", lab.MISSING_CATEGORY})
        self.assertAlmostEqual(sum(result["predictions"][0]["probabilities"].values()), 1.0, places=2)


if __name__ == "__main__":
    unittest.main()
