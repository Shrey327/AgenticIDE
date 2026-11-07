"""House-price regression with gradient boosting, trained in increments so curves stream live."""
import csv
import os
import time
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from aiide_sdk import artifact, evaluation, flush, metric, span
from aiide_sdk.training import log_system, log_training, parameters

config = parameters({'n_estimators': 200, 'learning_rate': 0.1, 'max_depth': 3, 'subsample': 1.0, 'seed': 42})
trees, step_size = int(config['n_estimators']), 10

with span('house_prices.experiment', **{k: str(v) for k, v in config.items()}):
    with span('data.load', file='data/houses.csv'):
        with open('data/houses.csv') as f:
            rows = list(csv.reader(f))
        header, values = rows[0], np.array(rows[1:], dtype=float)
        x, y = values[:, :-1], values[:, -1]
        metric('dataset.rows', len(y))

    with span('data.split', test_size='0.2'):
        x_train, x_val, y_train, y_val = train_test_split(x, y, test_size=0.2, random_state=int(config['seed']))

    model = GradientBoostingRegressor(
        n_estimators=0, warm_start=True, learning_rate=float(config['learning_rate']),
        max_depth=int(config['max_depth']), subsample=float(config['subsample']), random_state=int(config['seed']),
    )
    with span('model.fit', trees=trees):
        for count in range(step_size, trees + 1, step_size):
            started = time.monotonic()
            model.n_estimators = count
            model.fit(x_train, y_train)
            rmse = lambda a, b: round(float(np.sqrt(np.mean((a - b) ** 2))))
            log_training({
                'train.rmse': rmse(model.predict(x_train), y_train),
                'validation.rmse': rmse(model.predict(x_val), y_val),
                'seconds_per_step': round(time.monotonic() - started, 3),
            }, count)
        log_system(trees)

    with span('model.evaluate'):
        predictions = model.predict(x_val)
        mae, r2 = mean_absolute_error(y_val, predictions), r2_score(y_val, predictions)
        metric('validation.mae', round(mae))
        metric('validation.r2', round(r2, 4))
        evaluation('validation R² ≥ 0.85', bool(r2 >= 0.85), True, score=r2)
        top = sorted(zip(header, model.feature_importances_), key=lambda p: -p[1])[:3]
        for name, weight in top:
            metric(f'importance.{name}', round(float(weight), 3))

    with span('model.save'):
        directory = Path('models') / f"gbr-{config['n_estimators']}t-lr{config['learning_rate']}-d{config['max_depth']}-{int(time.time())}"
        directory.mkdir(parents=True)
        joblib.dump(model, directory / 'model.joblib')
        artifact('model', str(directory), framework='sklearn', step=trees)

print(f'Validation MAE ${mae:,.0f} · R² {r2:.3f} · top features: ' + ', '.join(n for n, _ in top))
flush()
