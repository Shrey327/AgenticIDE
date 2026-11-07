from aiide_sdk import span, metric, evaluation, flush


with span("example.pipeline"):
    with span("retrieve", documents=2):
        documents = ["AI Engineering IDE stores telemetry locally.", "Cloud services are optional."]
    with span("answer"):
        answer = "Local storage" if "locally" in documents[0] else "Unknown"
    metric("retrieval.documents", len(documents))
    evaluation("telemetry default", answer, "Local storage")
    print(answer)
flush()
