"""Small, failure-isolated OTLP/HTTP JSON exporter; no cloud dependencies."""
from __future__ import annotations

import atexit
import contextlib
import contextvars
import inspect
import json
import math
import os
import pathlib
import queue
import secrets
import threading
import time
import urllib.request

__all__ = ["span", "metric", "artifact", "evaluation", "flush", "run_context"]
_parent = contextvars.ContextVar("aiide_span", default=None)
_run = contextvars.ContextVar("aiide_run", default=None)
_queue = queue.Queue(maxsize=256)
_thread = None
_lock = threading.Lock()
dropped = 0


def _resource(run_id=None):
    return {"attributes": _attrs({"service.name": os.getenv("AIIDE_PROJECT", "python"),
                                  "aiide.run.id": run_id or _run.get() or os.getenv("AIIDE_RUN_ID", "")})}


def _attrs(values):
    result = []
    for key, value in values.items():
        if value is None:
            continue
        if isinstance(value, bool):
            wrapped = {"boolValue": value}
        elif isinstance(value, int):
            wrapped = {"intValue": str(value)}
        elif isinstance(value, float) and math.isfinite(value):
            wrapped = {"doubleValue": value}
        else:
            wrapped = {"stringValue": str(value)[:16384]}
        result.append({"key": key, "value": wrapped})
    return result


def _worker():
    global dropped
    # Ignore proxy environment variables: local telemetry must stay local.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while True:
        item = _queue.get()
        try:
            url, token, body = item
            req = urllib.request.Request(url, json.dumps(body).encode(),
                {"Content-Type": "application/json", "Authorization": "Bearer " + token})
            with opener.open(req, timeout=0.5) as response:
                response.read(1024)
        except Exception:
            dropped += 1
        finally:
            _queue.task_done()


def _send(route, body, events=False):
    global _thread, dropped
    endpoint = os.getenv("AIIDE_EVENTS_ENDPOINT" if events else "OTEL_EXPORTER_OTLP_ENDPOINT", "")
    token = os.getenv("AIIDE_TOKEN", "")
    if not endpoint or not token:
        return
    try:
        from urllib.parse import urlparse
        if urlparse(endpoint).hostname not in ("127.0.0.1", "localhost", "::1"):
            return
        with _lock:
            if _thread is None:
                _thread = threading.Thread(target=_worker, name="aiide-exporter", daemon=True)
                _thread.start()
        _queue.put_nowait((endpoint.rstrip("/") + route, token, body))
    except Exception:
        dropped += 1


def flush(timeout=2.0):
    deadline = time.monotonic() + timeout
    while _queue.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.01)
    return _queue.unfinished_tasks == 0


atexit.register(flush)


@contextlib.contextmanager
def run_context(run_id):
    token = _run.set(run_id)
    try:
        yield
    finally:
        _run.reset(token)


def emit_span(name, start, end, trace_id, span_id, parent_id=None, attributes=None, error=False, run_id=None):
    record = {"traceId": trace_id, "spanId": span_id, "name": name,
              "startTimeUnixNano": str(start), "endTimeUnixNano": str(end),
              "attributes": _attrs(attributes or {}), "status": {"code": 2 if error else 1}}
    if parent_id:
        record["parentSpanId"] = parent_id
    _send("/v1/traces", {"resourceSpans": [{"resource": _resource(run_id),
        "scopeSpans": [{"scope": {"name": "aiide-sdk", "version": "0.1.0"}, "spans": [record]}]}]})


@contextlib.contextmanager
def span(name, **attributes):
    parent = _parent.get()
    current = (parent[0] if parent else secrets.token_hex(16), secrets.token_hex(8))
    token = _parent.set(current)
    start = time.time_ns()
    failed = False
    # Find the caller outside contextlib and this SDK, so the IDE can navigate to source.
    for frame in inspect.stack()[1:8]:
        if "aiide_sdk" not in frame.filename and "contextlib.py" not in frame.filename:
            try:
                attributes.setdefault("code.filepath", str(pathlib.Path(frame.filename).resolve().relative_to(pathlib.Path.cwd())))
                attributes.setdefault("code.lineno", frame.lineno)
            except ValueError:
                pass
            break
    try:
        yield attributes
    except BaseException as error:
        failed = True
        attributes["error.type"] = type(error).__name__
        raise
    finally:
        emit_span(name, start, time.time_ns(), *current, parent[1] if parent else None, attributes, failed)
        _parent.reset(token)


def _event(kind, name, value, step=None):
    _send("/events", {"events": [{"runId": _run.get() or os.getenv("AIIDE_RUN_ID", ""),
        "kind": kind, "name": name, "value": value, "step": step, "timestamp": time.time() * 1000}]}, events=True)


def metric(name, value, step=None):
    if isinstance(value, (int, float)) and math.isfinite(value):
        _event("metric", name, value, step)


def artifact(name, path, **metadata):
    # References only: the exporter never uploads file contents.
    _event("artifact", name, {"path": str(path), **metadata})


def evaluation(name, actual, expected, score=None):
    _event("evaluation", name, {"actual": actual, "expected": expected,
                                "score": float(actual == expected) if score is None else score})
