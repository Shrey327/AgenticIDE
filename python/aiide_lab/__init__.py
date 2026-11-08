"""Experiment lab: no-code model sweeps, final training, and inference for tabular CSV data.

Runs inside the project's own Python environment (needs scikit-learn). The IDE calls:
  catalog / inspect / predict  -> JSON request on stdin, {"ok", "result"} envelope on stdout
  sweep / final                -> as a recorded run, config in AIIDE_LAB_CONFIG
"""
import csv
import hashlib
import importlib
import importlib.util
import io
import json
import math
import os
import random
import re
import time
from pathlib import Path

MAX_TRIALS = 200
MAX_ROWS = 1_000_000
MAX_CATEGORIES = 50
MISSING = {"", "na", "n/a", "nan", "null", "none", "?"}
MISSING_CATEGORY = "__missing__"

# id: (module, class, {param: (type, default grid, help)}, needs_scaling, note)
_REGRESSORS = {
    "linear": ("sklearn.linear_model", "LinearRegression", {}, True, "Fast baseline"),
    "ridge": ("sklearn.linear_model", "Ridge", {"alpha": ("float", [0.1, 1.0, 10.0], "L2 strength")}, True, "Linear + L2"),
    "lasso": ("sklearn.linear_model", "Lasso", {"alpha": ("float", [0.001, 0.01, 0.1], "L1 strength"), "max_iter": ("int", [5000], "Solver iterations")}, True, "Linear + L1, sparse"),
    "knn": ("sklearn.neighbors", "KNeighborsRegressor", {"n_neighbors": ("int", [5, 15], "Neighbours"), "weights": ("choice", ["uniform", "distance"], "uniform | distance")}, True, "Slow on large data"),
    "random_forest": ("sklearn.ensemble", "RandomForestRegressor", {"n_estimators": ("int", [200], "Trees"), "max_depth": ("int_or_none", [None, 12], "None = unlimited"), "min_samples_leaf": ("int", [1, 5], "Leaf size")}, False, "Strong default"),
    "extra_trees": ("sklearn.ensemble", "ExtraTreesRegressor", {"n_estimators": ("int", [200], "Trees"), "max_depth": ("int_or_none", [None], "None = unlimited"), "min_samples_leaf": ("int", [1, 5], "Leaf size")}, False, "Randomised forest"),
    "gradient_boosting": ("sklearn.ensemble", "GradientBoostingRegressor", {"n_estimators": ("int", [200], "Boosting stages"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "max_depth": ("int", [3], "Tree depth"), "subsample": ("float", [1.0], "Row sampling")}, False, "Accurate, slower"),
    "hist_gradient_boosting": ("sklearn.ensemble", "HistGradientBoostingRegressor", {"max_iter": ("int", [200], "Boosting stages"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "max_leaf_nodes": ("int", [31], "Leaves per tree"), "l2_regularization": ("float", [0.0], "L2 strength")}, False, "Fast boosting, large data"),
    "svm": ("sklearn.svm", "SVR", {"C": ("float", [1.0, 10.0], "Regularisation"), "epsilon": ("float", [0.1], "Tube width"), "kernel": ("choice", ["rbf"], "rbf | linear | poly")}, True, "Slow above ~10k rows"),
    "xgboost": ("xgboost", "XGBRegressor", {"n_estimators": ("int", [300], "Trees"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "max_depth": ("int", [6], "Tree depth")}, False, "Needs xgboost"),
    "lightgbm": ("lightgbm", "LGBMRegressor", {"n_estimators": ("int", [300], "Trees"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "num_leaves": ("int", [31], "Leaves per tree"), "verbose": ("int", [-1], "Logging")}, False, "Needs lightgbm"),
}
_CLASSIFIERS = {
    "logistic": ("sklearn.linear_model", "LogisticRegression", {"C": ("float", [0.1, 1.0, 10.0], "Inverse regularisation"), "max_iter": ("int", [2000], "Solver iterations")}, True, "Fast baseline"),
    "knn": ("sklearn.neighbors", "KNeighborsClassifier", {"n_neighbors": ("int", [5, 15], "Neighbours"), "weights": ("choice", ["uniform", "distance"], "uniform | distance")}, True, "Slow on large data"),
    "random_forest": ("sklearn.ensemble", "RandomForestClassifier", {"n_estimators": ("int", [200], "Trees"), "max_depth": ("int_or_none", [None, 12], "None = unlimited"), "min_samples_leaf": ("int", [1, 5], "Leaf size")}, False, "Strong default"),
    "extra_trees": ("sklearn.ensemble", "ExtraTreesClassifier", {"n_estimators": ("int", [200], "Trees"), "max_depth": ("int_or_none", [None], "None = unlimited"), "min_samples_leaf": ("int", [1, 5], "Leaf size")}, False, "Randomised forest"),
    "gradient_boosting": ("sklearn.ensemble", "GradientBoostingClassifier", {"n_estimators": ("int", [200], "Boosting stages"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "max_depth": ("int", [3], "Tree depth")}, False, "Accurate, slower"),
    "hist_gradient_boosting": ("sklearn.ensemble", "HistGradientBoostingClassifier", {"max_iter": ("int", [200], "Boosting stages"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "max_leaf_nodes": ("int", [31], "Leaves per tree")}, False, "Fast boosting, large data"),
    "svm": ("sklearn.svm", "SVC", {"C": ("float", [1.0, 10.0], "Regularisation"), "kernel": ("choice", ["rbf"], "rbf | linear | poly"), "probability": ("bool", [True], "Needed for ROC AUC / log loss")}, True, "Slow above ~10k rows"),
    "xgboost": ("xgboost", "XGBClassifier", {"n_estimators": ("int", [300], "Trees"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "max_depth": ("int", [6], "Tree depth")}, False, "Needs xgboost"),
    "lightgbm": ("lightgbm", "LGBMClassifier", {"n_estimators": ("int", [300], "Trees"), "learning_rate": ("float", [0.05, 0.1], "Shrinkage"), "num_leaves": ("int", [31], "Leaves per tree"), "verbose": ("int", [-1], "Logging")}, False, "Needs lightgbm"),
}
_LABELS = {"linear": "Linear regression", "ridge": "Ridge", "lasso": "Lasso", "logistic": "Logistic regression", "knn": "K-nearest neighbours",
           "random_forest": "Random forest", "extra_trees": "Extra trees", "gradient_boosting": "Gradient boosting",
           "hist_gradient_boosting": "Histogram gradient boosting", "svm": "Support vector machine", "xgboost": "XGBoost", "lightgbm": "LightGBM"}
# metric id: (label, higher_is_better)
_METRICS = {
    "regression": {"rmse": ("RMSE", False), "mae": ("MAE", False), "r2": ("R²", True), "mape": ("MAPE", False)},
    "classification": {"accuracy": ("Accuracy", True), "f1": ("F1 (macro)", True), "precision": ("Precision (macro)", True),
                       "recall": ("Recall (macro)", True), "roc_auc": ("ROC AUC", True), "log_loss": ("Log loss", False)},
}


def _models(task):
    return _REGRESSORS if task == "regression" else _CLASSIFIERS


def _available(module):
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def catalog(_request=None):
    sklearn = _available("sklearn")
    version = importlib.import_module("sklearn").__version__ if sklearn else None
    return {
        "sklearn": version,
        "error": None if sklearn else "scikit-learn is not installed in this project's Python environment. Add the sklearn integration from Home, or install it, then reopen the lab.",
        "tasks": {
            task: {
                "models": {
                    key: {"label": _LABELS[key], "note": note, "available": sklearn and _available(module.split(".")[0]),
                          "params": {name: {"type": kind, "default": ", ".join(_show(v) for v in grid), "help": help_}
                                     for name, (kind, grid, help_) in params.items()}}
                    for key, (module, _cls, params, _scale, note) in _models(task).items()
                },
                "metrics": {key: {"label": label, "higher": higher} for key, (label, higher) in _METRICS[task].items()},
            }
            for task in ("regression", "classification")
        },
    }


def _show(value):
    return "None" if value is None else str(value)


# ---------- data ----------

def _missing(value):
    return value.strip().lower() in MISSING


def _number(value):
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _read(file, min_columns=2):
    path = Path(file)
    if path.suffix.lower() not in (".csv", ".tsv", ".txt"):
        raise ValueError("Choose a .csv or .tsv file")
    with open(path, newline="", encoding="utf-8-sig") as stream:
        sample = stream.read(65536)
        stream.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel_tab if path.suffix.lower() == ".tsv" else csv.excel
        reader = csv.reader(stream, dialect)
        header = [h.strip() or f"column_{i + 1}" for i, h in enumerate(next(reader, []))]
        if len(header) < min_columns:
            raise ValueError(f"The file needs a header row and at least {min_columns} columns")
        if len(set(header)) != len(header):
            raise ValueError("Column names must be unique")
        rows = []
        for row in reader:
            if not any(cell.strip() for cell in row):
                continue
            if len(rows) >= MAX_ROWS:
                raise ValueError(f"More than {MAX_ROWS:,} rows; sample the file first")
            if len(row) > len(header):
                raise ValueError(f"Row {reader.line_num} has more values than the header; check the delimiter and quoting")
            rows.append((row + [""] * len(header))[: len(header)])
    if not rows:
        raise ValueError("The file has no data rows")
    return header, rows


def _profile(header, rows):
    columns = []
    for index, name in enumerate(header):
        values = [row[index] for row in rows]
        present = [v for v in values if not _missing(v)]
        numbers = [_number(v) for v in present]
        numeric = bool(present) and all(n is not None for n in numbers)
        distinct = {}
        for v in present:
            if len(distinct) > 1000:
                break
            distinct[v] = distinct.get(v, 0) + 1
        column = {"name": name, "type": "numeric" if numeric else "categorical", "missing": len(values) - len(present),
                  "unique": len(distinct) if len(distinct) <= 1000 else "1000+"}
        if numeric:
            ordered = sorted(numbers)
            column.update(min=ordered[0], max=ordered[-1], median=ordered[len(ordered) // 2],
                          mean=sum(ordered) / len(ordered), integer=all(float(n).is_integer() for n in ordered))
        top = sorted(distinct.items(), key=lambda p: -p[1])[:MAX_CATEGORIES]
        if not numeric or len(distinct) <= 20:
            column["values"] = [v for v, _ in top]
        columns.append(column)
    return columns


def _suggest_task(column):
    if column["type"] == "categorical":
        return "classification"
    unique = column["unique"] if isinstance(column["unique"], int) else 1001
    return "classification" if column.get("integer") and unique <= 20 else "regression"


def inspect(request):
    header, rows = _read(request["file"])
    columns = _profile(header, rows)
    return {"file": request["file"], "rows": len(rows), "columns": columns, "sample": rows[:8],
            "tasks": {c["name"]: _suggest_task(c) for c in columns}, "target": header[-1]}


def sample(_request=None):
    from sklearn.datasets import load_iris
    data = load_iris()
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow([*data.feature_names, "species"])
    for row, target in zip(data.data, data.target):
        writer.writerow([*row, data.target_names[target]])
    return {"csv": stream.getvalue()}


def _matrix(header, rows, features, target, task, columns):
    import numpy as np
    index = {name: i for i, name in enumerate(header)}
    kinds = {c["name"]: c["type"] for c in columns}
    keep = [row for row in rows if not _missing(row[index[target]])]
    if len(keep) < 10:
        raise ValueError("Need at least 10 rows with a target value")
    data = np.empty((len(keep), len(features)), dtype=object)
    for j, name in enumerate(features):
        i = index[name]
        if kinds[name] == "numeric":
            data[:, j] = [np.nan if _missing(r[i]) else float(r[i]) for r in keep]
        else:
            data[:, j] = [MISSING_CATEGORY if _missing(r[i]) else r[i].strip() for r in keep]
    if task == "regression":
        if kinds[target] != "numeric":
            raise ValueError(f"Regression needs a numeric target; '{target}' has text values. Choose classification.")
        y = np.array([float(r[index[target]]) for r in keep])
    else:
        y = np.array([r[index[target]].strip() for r in keep], dtype=object)
        counts = {}
        for label in y:
            counts[label] = counts.get(label, 0) + 1
        if len(counts) < 2:
            raise ValueError("Classification needs at least two target classes")
        if len(counts) > 200:
            raise ValueError(f"'{target}' has {len(counts)} classes; choose regression or another target")
    numeric = [j for j, n in enumerate(features) if kinds[n] == "numeric"]
    categorical = [j for j, n in enumerate(features) if kinds[n] != "numeric"]
    return data, y, numeric, categorical, len(rows) - len(keep)


def _pipeline(model_id, params, task, numeric, categorical, seed):
    import numpy as np
    from sklearn.compose import ColumnTransformer
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import FunctionTransformer, OneHotEncoder, StandardScaler
    module, name, _spec, scale, _note = _models(task)[model_id]
    steps = [("cast", FunctionTransformer(np.asarray, kw_args={"dtype": "float64"})), ("impute", SimpleImputer(strategy="median"))]
    if scale:
        steps.append(("scale", StandardScaler()))
    parts = []
    if numeric:
        parts.append(("numeric", Pipeline(steps), numeric))
    if categorical:
        parts.append(("categorical", OneHotEncoder(handle_unknown="ignore", max_categories=MAX_CATEGORIES), categorical))
    estimator = getattr(importlib.import_module(module), name)
    options = dict(params)
    if "random_state" in estimator().get_params():
        options.setdefault("random_state", seed)
    # Histogram boosting requires dense input; other estimators can retain sparse encoding.
    threshold = 0 if model_id == "hist_gradient_boosting" else 0.3
    return Pipeline([("prepare", ColumnTransformer(parts, sparse_threshold=threshold)), ("model", estimator(**options))])


# ---------- sweeps ----------

def _parse(kind, text, name):
    items = [t.strip() for t in str(text).split(",") if t.strip()]
    if not items:
        raise ValueError(f"Give at least one value for {name}")
    values = []
    for item in items:
        try:
            if kind == "int" or (kind == "int_or_none" and item.lower() != "none"):
                number = float(item)
                if not math.isfinite(number) or not number.is_integer():
                    raise ValueError
                values.append(int(number))
            elif kind == "int_or_none":
                values.append(None)
            elif kind == "float":
                number = float(item)
                if not math.isfinite(number):
                    raise ValueError
                values.append(number)
            elif kind == "bool":
                if item.lower() not in ("true", "false"):
                    raise ValueError
                values.append(item.lower() == "true")
            elif re.fullmatch(r"[A-Za-z0-9_.\-]{1,40}", item):
                values.append(item)
            else:
                raise ValueError
        except ValueError:
            raise ValueError(f"'{item}' is not a valid {kind.replace('_', ' ')} for {name}") from None
    return list(dict.fromkeys(values))


def trials(config):
    task, grids = config["task"], []
    total = 0
    for entry in config["models"]:
        model_id = entry["id"]
        if model_id not in _models(task):
            raise ValueError(f"Unknown model: {model_id}")
        spec = _models(task)[model_id][2]
        unknown = set(entry.get("grid", {})) - set(spec)
        if unknown:
            raise ValueError(f"Unknown hyperparameter: {sorted(unknown)[0]}")
        grid = {name: _parse(kind, entry.get("grid", {}).get(name, ", ".join(_show(v) for v in default)), name)
                for name, (kind, default, _help) in spec.items()}
        count = math.prod(len(v) for v in grid.values())
        total += count
        grids.append((model_id, grid, count))
    if not total:
        raise ValueError("Select at least one model")
    count = total
    if config.get("search") == "random":
        count = min(int(config.get("trials", 20)), total)
    if not 1 <= count <= MAX_TRIALS:
        raise ValueError(f"{count} trials; reduce the grid or use random search (max {MAX_TRIALS})")
    # Decode sampled indices without allocating every hyperparameter combination.
    indices = random.Random(int(config.get("seed", 42))).sample(range(total), count) if config.get("search") == "random" else range(total)
    result = []
    for index in indices:
        for model_id, grid, size in grids:
            if index >= size:
                index -= size
                continue
            params = {}
            for name, values in reversed(list(grid.items())):
                params[name] = values[index % len(values)]
                index //= len(values)
            result.append((model_id, params))
            break
    return result


def _splitter(config, task):
    from sklearn.model_selection import KFold, ShuffleSplit, StratifiedKFold, StratifiedShuffleSplit
    seed = int(config.get("seed", 42))
    validation = config.get("validation", {})
    if validation.get("type") == "holdout":
        size = float(validation.get("test_size", 0.2))
        if not 0.05 <= size <= 0.5:
            raise ValueError("Holdout size must be between 5% and 50%")
        return (StratifiedShuffleSplit if task == "classification" else ShuffleSplit)(n_splits=1, test_size=size, random_state=seed)
    folds = int(validation.get("folds", 5))
    if not 2 <= folds <= 10:
        raise ValueError("Use 2–10 folds")
    return (StratifiedKFold if task == "classification" else KFold)(n_splits=folds, shuffle=True, random_state=seed)


def _scorers(task, metrics, classes):
    names = {"rmse": "neg_root_mean_squared_error", "mae": "neg_mean_absolute_error", "r2": "r2",
             "mape": "neg_mean_absolute_percentage_error", "accuracy": "accuracy", "f1": "f1_macro",
             "precision": "precision_macro", "recall": "recall_macro",
             "roc_auc": "roc_auc" if classes == 2 else "roc_auc_ovr", "log_loss": "neg_log_loss"}
    unknown = [m for m in metrics if m not in _METRICS[task]]
    if unknown:
        raise ValueError(f"Unknown {task} metric: {unknown[0]}")
    chosen = list(dict.fromkeys(metrics))
    if not chosen:
        raise ValueError("Choose at least one metric")
    return {m: names[m] for m in chosen}


def _load(config):
    header, rows = _read(config["file"])
    columns = _profile(header, rows)
    target, task = config["target"], config["task"]
    features = [f for f in config.get("features", header) if f != target]
    unknown = [f for f in [target, *features] if f not in header]
    if unknown:
        raise ValueError(f"Unknown column: {unknown[0]}")
    if task not in _METRICS or not features:
        raise ValueError("Choose a task and at least one feature")
    x, y, numeric, categorical, dropped = _matrix(header, rows, features, target, task, columns)
    return header, rows, columns, features, x, y, numeric, categorical, dropped


def sweep(config):
    import warnings
    import numpy as np
    from sklearn.model_selection import cross_validate
    from aiide_sdk import _event, flush, metric, span
    warnings.filterwarnings("ignore", category=UserWarning)
    header, rows, columns, features, x, y, numeric, categorical, dropped = _load(config)
    task, primary = config["task"], config["primary"]
    scoring = _scorers(task, config["metrics"], len(set(y)) if task == "classification" else 0)
    if primary not in scoring:
        raise ValueError("The primary metric must be one of the selected metrics")
    higher = _METRICS[task][primary][1]
    plan = trials(config)
    splitter = _splitter(config, task)
    if task == "classification":
        from collections import Counter
        counts = Counter(y)
        minimum = min(counts.values())
        needed = config.get("validation", {}).get("folds", 5) if config.get("validation", {}).get("type") != "holdout" else 2
        if minimum < needed:
            raise ValueError(f"The smallest target class has {minimum} rows; this validation needs at least {needed} per class. Reduce folds or add examples.")
    # Validate the split once so dataset errors don't repeat for every candidate.
    splits = list(splitter.split(x, y))
    print(f"{len(plan)} trials · {len(y):,} rows ({dropped} without target) · {len(features)} features · {task}", flush=True)
    metric("lab.trials_total", len(plan))
    best = None
    with span("lab.sweep", file=config["file"], target=config["target"], task=task, trials=len(plan)):
        for number, (model_id, params) in enumerate(plan, 1):
            label = _LABELS[model_id]
            started = time.monotonic()
            record = {"trial": number, "model": model_id, "label": label, "params": {k: _show(v) for k, v in params.items()}}
            with span(f"trial {number} · {label}", model=model_id, **{f"param.{k}": _show(v) for k, v in params.items()}):
                try:
                    pipe = _pipeline(model_id, params, task, numeric, categorical, int(config.get("seed", 42)))
                    result = cross_validate(pipe, x, y, cv=splits, scoring=scoring, return_train_score=True,
                                            n_jobs=int(config.get("jobs", 1)), error_score="raise")
                    if any(not np.isfinite(result[f"test_{m}"]).all() for m in scoring):
                        raise ValueError("A validation metric is undefined; use more rows per fold or another metric.")
                except Exception as error:  # A broken combination must not end the sweep.
                    record.update(status="failed", error=f"{type(error).__name__}: {error}"[:600])
                    _event("trial", f"trial-{number}", record, number)
                    print(f"[{number}/{len(plan)}] {label} failed: {record['error']}", flush=True)
                    continue
            sign = lambda m: -1.0 if scoring[m].startswith("neg_") else 1.0
            record.update(
                status="completed",
                seconds=round(time.monotonic() - started, 3),
                fit_seconds=round(float(np.mean(result["fit_time"])), 4),
                scores={m: float(sign(m) * np.mean(result[f"test_{m}"])) for m in scoring},
                std={m: float(np.std(result[f"test_{m}"])) for m in scoring},
                train={m: float(sign(m) * np.mean(result[f"train_{m}"])) for m in scoring},
            )
            score = record["scores"][primary]
            if best is None or (score > best if higher else score < best):
                best = score
            _event("trial", f"trial-{number}", record, number)
            metric(f"trial.{primary}", score, number)
            metric(f"best.{primary}", best, number)
            print(f"[{number}/{len(plan)}] {label} {record['params']} → {primary} {score:.4g}", flush=True)
    flush()
    if best is None:
        raise ValueError("Every trial failed. Inspect the trial errors and adjust the data or hyperparameters before retrying.")


# ---------- final model + inference ----------

def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "model"


def final(config):
    import joblib
    import warnings
    from aiide_sdk import _event, artifact, flush, metric, span
    warnings.filterwarnings("ignore", category=UserWarning)
    header, rows, columns, features, x, y, numeric, categorical, dropped = _load(config)
    task, model_id = config["task"], config["model"]
    if model_id not in _models(task):
        raise ValueError(f"Unknown model: {model_id}")
    spec = _models(task)[model_id][2]
    params = {k: _parse(kind, config.get("params", {}).get(k, _show(default[0])), k)[0] for k, (kind, default, _h) in spec.items()}
    name = config.get("name") or f"{model_id}-{config['target']}"
    directory = Path("models") / f"{_slug(name)}-{time.strftime('%Y%m%d-%H%M%S')}"
    with span("lab.final", model=model_id, rows=len(y)):
        with span("model.fit", model=model_id):
            pipe = _pipeline(model_id, params, task, numeric, categorical, int(config.get("seed", 42)))
            pipe.fit(x, y)
        with span("model.save"):
            directory.mkdir(parents=True)
            joblib.dump(pipe, directory / "model.joblib")
            by_name = {c["name"]: c for c in columns}
            meta = {
                "format": "aiide-lab-v1", "name": name, "task": task, "model": model_id, "label": _LABELS[model_id],
                "params": {k: _show(v) for k, v in params.items()}, "target": config["target"],
                "features": [{k: by_name[f].get(k) for k in ("name", "type", "min", "max", "median", "values", "integer")} for f in features],
                "classes": [str(c) for c in getattr(pipe, "classes_", [])], "rows": len(y), "file": config["file"],
                "file_sha256": hashlib.sha256(Path(config["file"]).read_bytes()).hexdigest(),
                "scores": config.get("scores") or {}, "sweep": config.get("sweep"), "created": time.time(),
                "example": dict(zip(features, [rows[0][header.index(f)] for f in features])),
            }
            (directory / "model.json").write_text(json.dumps(meta, indent=2))
    for key, value in (config.get("scores") or {}).items():
        metric(f"cv.{key}", value)
    artifact("model", str(directory), framework="sklearn", task=task, model=model_id)
    print(f"Saved {directory}/model.joblib ({task}, {len(y):,} rows, {len(features)} features)", flush=True)
    flush()


def _model(path):
    import joblib
    directory = Path(path)
    meta = json.loads((directory / "model.json").read_text())
    if meta.get("format") != "aiide-lab-v1":
        raise ValueError("Not an Experiment lab model")
    return meta, joblib.load(directory / "model.joblib")


def _rows_to_matrix(meta, records):
    import numpy as np
    data = np.empty((len(records), len(meta["features"])), dtype=object)
    for i, record in enumerate(records):
        for j, feature in enumerate(meta["features"]):
            raw = record.get(feature["name"], "")
            raw = "" if raw is None else str(raw)
            if feature["type"] == "numeric":
                if _missing(raw):
                    data[i, j] = np.nan
                elif _number(raw) is None:
                    raise ValueError(f"{feature['name']} must be a number (row {i + 1})")
                else:
                    data[i, j] = float(raw)
            else:
                data[i, j] = MISSING_CATEGORY if _missing(raw) else raw.strip()
    return data


def predict(request):
    meta, pipe = _model(request["model"])
    started = time.monotonic()
    if request.get("file"):
        header, rows = _read(request["file"], min_columns=1)
        missing = [f["name"] for f in meta["features"] if f["name"] not in header]
        if missing:
            raise ValueError(f"Prediction CSV is missing feature columns: {', '.join(missing)}")
        records = [dict(zip(header, row)) for row in rows]
    else:
        records = request.get("rows") or []
    if not records:
        raise ValueError("Nothing to predict")
    if len(records) > MAX_ROWS:
        raise ValueError("Too many rows")
    x = _rows_to_matrix(meta, records)
    predictions = pipe.predict(x)
    out = [{"prediction": float(p) if meta["task"] == "regression" else str(p)} for p in predictions]
    if meta["task"] == "classification" and hasattr(pipe, "predict_proba"):
        try:
            for row, probabilities in zip(out, pipe.predict_proba(x)):
                ranked = sorted(zip(pipe.classes_, probabilities), key=lambda p: -p[1])[:5]
                row["probabilities"] = {str(c): round(float(p), 4) for c, p in ranked}
        except Exception:
            pass
    result = {"task": meta["task"], "target": meta["target"], "count": len(out), "ms": round((time.monotonic() - started) * 1000, 1)}
    if request.get("file"):
        output = Path(request["output"])
        output.parent.mkdir(parents=True, exist_ok=True)
        with open(output, "w", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow([*header, f"predicted_{meta['target']}"])
            for row, value in zip(rows, out):
                writer.writerow([*row, value["prediction"]])
        result.update(output=request["output_display"], preview=out[:20], rows=records[:20])
    else:
        result["predictions"] = out
    return result
