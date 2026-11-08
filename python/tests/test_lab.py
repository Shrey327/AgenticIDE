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

    def test_rejects_fractional_integers_nonfinite_values_and_unknown_parameters(self):
        for value in ("1.5", "nan", "inf"):
            with self.assertRaisesRegex(ValueError, "not a valid int"):
                lab._parse("int", value, "n_neighbors")
        with self.assertRaisesRegex(ValueError, "not a valid float"):
            lab._parse("float", "nan", "C")
        with self.assertRaisesRegex(ValueError, "Unknown hyperparameter"):
            lab.trials({"task": "classification", "models": [{"id": "svm", "grid": {"typo": "1"}}]})

    def test_random_search_does_not_expand_huge_grid(self):
        values = ",".join(str(i) for i in range(1, 1001))
        config = {"task": "regression", "search": "random", "trials": 3, "models": [{"id": "random_forest", "grid": {
            "n_estimators": values, "max_depth": values, "min_samples_leaf": values}}]}
        self.assertEqual(len(lab.trials(config)), 3)


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

    def test_iris_sample_multimodel_classification_and_final_inference(self):
        pathlib.Path("iris.csv").write_text(lab.sample()["csv"])
        profile = lab.inspect({"file": "iris.csv"})
        self.assertEqual(profile["rows"], 150)
        self.assertEqual(profile["target"], "species")
        config = {"file": "iris.csv", "target": "species", "task": "classification", "metrics": ["accuracy", "f1", "roc_auc"], "primary": "f1",
                  "validation": {"type": "kfold", "folds": 3}, "models": [
                      {"id": "svm", "grid": {"C": "1, 10"}}, {"id": "logistic", "grid": {"C": "1"}}]}
        events = []
        with patch("aiide_sdk._event", lambda kind, name, value, step=None: events.append((kind, value))):
            lab.sweep(config)
        trials = [v for k, v in events if k == "trial"]
        self.assertEqual(len(trials), 3)
        self.assertTrue(all(t["status"] == "completed" and t["scores"]["f1"] > 0.9 for t in trials))
        with patch("aiide_sdk._event", lambda *a, **k: None):
            lab.final({**config, "features": ["petal length (cm)"], "model": "svm", "params": {"C": "1"}})
        directory = next(pathlib.Path("models").iterdir())
        pathlib.Path("predict.csv").write_text("petal length (cm)\n1.4\n4.5\n")
        result = lab.predict({"model": str(directory), "file": "predict.csv", "output": "predictions.csv", "output_display": "predictions.csv"})
        self.assertEqual(result["count"], 2)
        pathlib.Path("bad.csv").write_text("wrong\n1.4\n")
        with self.assertRaisesRegex(ValueError, "missing feature columns"):
            lab.predict({"model": str(directory), "file": "bad.csv"})

    def test_categorical_histogram_boosting_and_failed_sweeps(self):
        pathlib.Path("categorical.csv").write_text("category,target\n" + "".join(f"city-{i % 20},{i % 2}\n" for i in range(120)))
        config = {"file": "categorical.csv", "target": "target", "task": "classification", "metrics": ["f1"], "primary": "f1",
                  "validation": {"type": "kfold", "folds": 3}, "models": [{"id": "hist_gradient_boosting", "grid": {"max_iter": "5", "learning_rate": "0.1"}}]}
        with patch("aiide_sdk._event", lambda *a, **k: None):
            lab.sweep(config)
            with self.assertRaisesRegex(ValueError, "Every trial failed"):
                lab.sweep({**config, "models": [{"id": "svm", "grid": {"C": "-1"}}]})
        with self.assertRaisesRegex(ValueError, "at least one feature"):
            lab._load({**config, "features": []})
        pathlib.Path("rare.csv").write_text("feature,target\n" + "".join(f"{i},{'rare' if i < 2 else 'common'}\n" for i in range(20)))
        with self.assertRaisesRegex(ValueError, "smallest target class has 2 rows"):
            lab.sweep({**config, "file": "rare.csv"})


if __name__ == "__main__":
    unittest.main()
