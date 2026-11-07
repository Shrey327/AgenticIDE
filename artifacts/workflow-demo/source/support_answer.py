"""Deterministic retrieval example for the demo; no model or network required."""
import argparse
import time
from aiide_sdk import span, metric, evaluation, flush

DOCUMENTS = [
    ("models", "Model connections are optional and support local endpoints."),
    ("storage", "Telemetry is stored locally on this device by default."),
    ("training", "Training jobs can record metrics and resume checkpoints."),
]
QUESTION = "Where is telemetry stored by default?"


def retrieve(ranked):
    if not ranked:
        return DOCUMENTS[:1]
    terms = set(QUESTION.lower().rstrip("?").split())
    return sorted(DOCUMENTS, key=lambda item: len(terms & set(item[1].lower().split())), reverse=True)[:1]


def answer(ranked):
    with span("support.answer", mode="ranked" if ranked else "baseline"):
        with span("retrieve.documents", strategy="keyword_rank" if ranked else "first_chunk", top_k=1) as attrs:
            matches = retrieve(ranked)
            attrs["retrieved.id"] = matches[0][0]
            time.sleep(0.12)
        with span("compose.answer", engine="deterministic.extractive"):
            result = matches[0][1]
            time.sleep(0.06)
        with span("evaluate.correctness", dataset="demo-storage-check"):
            passed = "stored locally" in result.lower()
            evaluation("answer.correctness", passed, True)
            metric("answer.correctness", int(passed))
            metric("retrieval.documents", len(matches))
    print(f"{'PASS' if passed else 'FAIL'}: {result}")
    flush()
    return passed


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ranked", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        assert retrieve(False)[0][0] == "models"
        assert retrieve(True)[0][0] == "storage"
        assert not answer(False)
        assert answer(True)
        print("Self-check passed: the baseline misses and ranking finds the answer.")
    else:
        answer(args.ranked)
