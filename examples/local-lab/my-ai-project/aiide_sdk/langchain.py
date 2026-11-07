"""Callback integration for LangChain and LangGraph; preserves parent run IDs."""
import os
import threading
import time

from langchain_core.callbacks import BaseCallbackHandler
from . import emit_span, metric


class AIIDECallbackHandler(BaseCallbackHandler):
    raise_error = False
    run_inline = True

    def __init__(self):
        self._active = {}
        self._trace = {}
        self._lock = threading.RLock()

    def _start(self, kind, serialized=None, *, run_id, parent_run_id=None, **kwargs):
        with self._lock:
            parent = self._active.get(str(parent_run_id))
            trace = parent[1] if parent else run_id.hex
            name = kwargs.get("name") or (serialized or {}).get("name") or kind
            attrs = {"aiide.kind": kind}
            metadata = kwargs.get("metadata") or {}
            if "langgraph_node" in metadata:
                attrs["langgraph.node"] = metadata["langgraph_node"]
            self._active[str(run_id)] = (time.time_ns(), trace, str(name), attrs, parent_run_id)

    def _end(self, result=None, *, run_id, error=None, **kwargs):
        with self._lock:
            entry = self._active.pop(str(run_id), None)
        if not entry:
            return
        start, trace, name, attrs, parent = entry
        if error:
            attrs["error.type"] = type(error).__name__
        if os.getenv("AIIDE_CAPTURE_CONTENT") == "true":
            attrs["output"] = str(result)[:8000]
        emit_span(name, start, time.time_ns(), trace, run_id.hex[:16], parent.hex[:16] if parent else None, attrs, bool(error))

    def on_chain_start(self, serialized, inputs, **kwargs): self._start("chain", serialized, **kwargs)
    def on_chain_end(self, outputs, **kwargs): self._end(outputs, **kwargs)
    def on_chain_error(self, error, **kwargs): self._end(error=error, **kwargs)
    def on_llm_start(self, serialized, prompts, **kwargs): self._start("llm", serialized, **kwargs)
    def on_chat_model_start(self, serialized, messages, **kwargs): self._start("llm", serialized, **kwargs)
    def on_llm_end(self, response, **kwargs):
        usage = (response.llm_output or {}).get("token_usage", {})
        for key, value in usage.items():
            if isinstance(value, (float, int)): metric("tokens." + key, value)
        self._end(response, **kwargs)
    def on_llm_error(self, error, **kwargs): self._end(error=error, **kwargs)
    def on_tool_start(self, serialized, input_str, **kwargs): self._start("tool", serialized, **kwargs)
    def on_tool_end(self, output, **kwargs): self._end(output, **kwargs)
    def on_tool_error(self, error, **kwargs): self._end(error=error, **kwargs)
    def on_retriever_start(self, serialized, query, **kwargs): self._start("retriever", serialized, **kwargs)
    def on_retriever_end(self, documents, **kwargs): self._end(documents, **kwargs)
    def on_retriever_error(self, error, **kwargs): self._end(error=error, **kwargs)
