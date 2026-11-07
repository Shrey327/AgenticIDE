"""Run from the IDE to inspect a complete local trace without a model server."""
from aiide_sdk import span, metric, evaluation, flush

with span("example.pipeline"):
    with span("retrieve", documents=2):
        documents = ["Telemetry stays on this device.", "Cloud connections are optional."]
    with span("answer"):
        answer = "Local storage"
    metric("retrieval.documents", len(documents))
    evaluation("telemetry default", answer, "Local storage")
    print(answer)
flush()
