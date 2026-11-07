from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from aiide_sdk import span, metric, evaluation, flush

with span("classification.experiment"):
    x, y = load_iris(return_X_y=True)
    x_train, x_test, y_train, y_test = train_test_split(x, y, random_state=42, stratify=y)
    with span("model.fit"):
        model = RandomForestClassifier(n_estimators=50, random_state=42).fit(x_train, y_train)
    accuracy = model.score(x_test, y_test)
    metric("validation.accuracy", accuracy)
    evaluation("minimum accuracy", accuracy >= 0.8, True)
    print(f"Accuracy: {accuracy:.3f}")
flush()
