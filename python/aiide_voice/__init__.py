"""LiveKit voice workers sharing AIIDE's model connections and run telemetry."""
from __future__ import annotations

import importlib.metadata
import asyncio
import json
import os
from urllib.parse import urlparse

RETRY_POLICY = {"maxRetries": 2, "retryIntervalSeconds": 0.5, "requestTimeoutSeconds": 15, "ttsMaxRetries": 0}


def report_provider_error(event, health=None):
    from aiide_sdk import metric, span
    error = event if hasattr(event, "recoverable") else event.error
    component = str(getattr(error, "type", "provider_error"))
    if component not in ("llm_error", "stt_error", "tts_error", "realtime_model_error"):
        component = "provider_error"
    recoverable = getattr(error, "recoverable", False) is True
    metric("voice.provider_errors", 1)
    with span("voice.provider_error", component=component, recoverable=recoverable):
        pass
    if health:
        health({"state": "retrying" if recoverable else "failed", "component": component})


def chat_provider(config):
    from livekit.plugins import openai
    class NoReplayLLM(openai.LLM):
        def chat(self, **kwargs):
            stream = super().chat(**kwargs)
            # Pinned SDK safety hook: do not replay a partially spoken answer or tool call.
            if not hasattr(stream, '_retry_on_chunk_sent'):
                asyncio.create_task(stream.aclose())
                raise RuntimeError('The installed LiveKit stream lacks partial-output retry protection; use the locked voice environment')
            stream._retry_on_chunk_sent = False
            return stream
    return NoReplayLLM(model=config["chatModel"], base_url=config["chatUrl"],
                       api_key=os.environ.get("AIIDE_VOICE_CHAT_KEY") or os.environ.get("OPENAI_API_KEY"))


def status():
    packages = {}
    for name in ("livekit-agents", "livekit-plugins-openai", "livekit-plugins-silero"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    return {"ready": all(packages.values()), "packages": packages, "retryPolicy": RETRY_POLICY,
            "setup": "Create a LiveKit voice project and run its locked setup, or install livekit-agents[openai,silero]==1.8.12 with your project's package manager."}


def configuration():
    raw = os.environ.get("AIIDE_VOICE_CONFIG")
    value = json.loads(raw) if raw else {
        "instructions": os.environ.get("AIIDE_VOICE_INSTRUCTIONS", "You are a helpful voice agent. Reply briefly and clearly."),
        "agentName": os.environ.get("AIIDE_VOICE_AGENT_NAME", "aiide-voice"),
        "chatUrl": os.environ.get("AIIDE_MODEL_URL", "https://api.openai.com/v1"),
        "chatModel": os.environ.get("AIIDE_MODEL_NAME", "gpt-4.1-mini"),
        "speechUrl": os.environ.get("AIIDE_SPEECH_URL", "https://api.openai.com/v1"),
        "sttModel": os.environ.get("AIIDE_STT_MODEL", "whisper-1"),
        "ttsModel": os.environ.get("AIIDE_TTS_MODEL", "tts-1"),
        "voice": os.environ.get("AIIDE_TTS_VOICE", "alloy"),
    }
    if not isinstance(value, dict):
        raise ValueError("Voice configuration must be an object")
    for key in ("instructions", "agentName", "chatUrl", "chatModel", "speechUrl", "sttModel", "ttsModel", "voice"):
        if not isinstance(value.get(key), str) or not value[key].strip() or len(value[key]) > (10000 if key == "instructions" else 500):
            raise ValueError("Invalid voice configuration field: " + key)
    for key in ("chatUrl", "speechUrl"):
        endpoint = urlparse(value[key])
        if endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or not endpoint.hostname or \
                (endpoint.scheme != "https" and not (endpoint.scheme == "http" and endpoint.hostname in ("localhost", "127.0.0.1", "::1"))):
            raise ValueError("Use HTTPS for remote speech and chat endpoints")
    media = urlparse(os.environ.get("LIVEKIT_URL", ""))
    if not media.hostname or media.username or media.password or media.query or media.fragment or \
            (media.scheme != "wss" and not (media.scheme == "ws" and media.hostname in ("localhost", "127.0.0.1", "::1"))):
        raise ValueError("Set LIVEKIT_URL to a WSS server or loopback WS development server")
    if not os.environ.get("LIVEKIT_API_KEY") or not os.environ.get("LIVEKIT_API_SECRET"):
        raise ValueError("Set LiveKit credentials through the IDE vault or deployment secrets")
    return value


def wire_events(session, health=None):
    from aiide_sdk import metric, span

    @session.on("metrics_collected")
    def metrics_collected(event):
        values = event.metrics.model_dump() if hasattr(event.metrics, "model_dump") else vars(event.metrics)
        kind = str(values.get("type", "pipeline")).replace("_metrics", "")
        for name in ("ttft", "ttfb", "duration", "end_of_utterance_delay", "transcription_delay", "tokens_per_second", "input_tokens", "output_tokens", "audio_duration"):
            value = values.get(name)
            if type(value) in (int, float):
                metric(f"voice.{kind}.{name}", value)

    @session.on("conversation_item_added")
    def transcript(event):
        item = event.item
        if getattr(item, 'type', None) != 'message':
            return
        with span("voice.transcript", role=item.role, text=item.text_content):
            pass

    @session.on("agent_state_changed")
    def agent_state(event):
        with span("voice.agent_state", state=event.new_state):
            pass

    @session.on("error")
    def provider_error(event):
        report_provider_error(event, health)

    @session.on("close")
    def session_closed(event):
        reason = str(getattr(event.reason, "value", event.reason))
        if reason not in ("error", "job_shutdown", "participant_disconnected", "user_initiated", "task_completed"):
            reason = "closed"
        with span("voice.session_closed", reason=reason):
            pass
        if health:
            health({"state": "closed", "reason": reason})


def prewarm(process):
    from livekit.plugins import silero
    process.userdata["vad"] = silero.VAD.load()


def local_load(server):
    # Desktop experiments share CPU; reserve voice capacity by active sessions instead.
    return min(1.0, float(len(server.active_jobs)))


async def entrypoint(context):
    config = configuration()
    from livekit.agents import Agent, AgentSession, APIConnectOptions, SessionConnectOptions
    from livekit.plugins import openai
    from aiide_sdk import flush

    pending_health = set()

    def health(value):
        if len(pending_health) >= 4:
            return
        async def publish():
            try:
                await asyncio.wait_for(context.room.local_participant.publish_data(
                    json.dumps(value), topic="aiide.voice.health", reliable=True), timeout=2)
            except Exception:
                pass
        task = asyncio.create_task(publish())
        pending_health.add(task)
        task.add_done_callback(pending_health.discard)

    connection = APIConnectOptions(max_retry=RETRY_POLICY["maxRetries"],
                                   retry_interval=RETRY_POLICY["retryIntervalSeconds"],
                                   timeout=RETRY_POLICY["requestTimeoutSeconds"])
    no_replay = APIConnectOptions(max_retry=RETRY_POLICY["ttsMaxRetries"], timeout=RETRY_POLICY["requestTimeoutSeconds"])
    session = AgentSession(
            conn_options=SessionConnectOptions(stt_conn_options=connection, llm_conn_options=connection,
                                               tts_conn_options=no_replay, max_unrecoverable_errors=0),
            vad=context.proc.userdata["vad"],
            stt=openai.STT(model=config["sttModel"], base_url=config["speechUrl"], api_key=os.environ.get("AIIDE_VOICE_SPEECH_KEY") or os.environ.get("OPENAI_API_KEY")),
            llm=chat_provider(config),
            tts=openai.TTS(model=config["ttsModel"], voice=config["voice"], response_format='pcm', base_url=config["speechUrl"], api_key=os.environ.get("AIIDE_VOICE_SPEECH_KEY") or os.environ.get("OPENAI_API_KEY")),
            turn_handling={
                'turn_detection': 'vad',
                'endpointing': {'min_delay': 0.5, 'max_delay': 3.0},
                'interruption': {'enabled': True, 'mode': 'vad', 'min_duration': 0.5},
            },
        )
    wire_events(session, health)

    @session.on("close")
    def session_closed(event):
        if str(getattr(event.reason, "value", event.reason)) == "error":
            context.shutdown(reason="Voice provider retry budget exhausted")

    async def shutdown():
        await session.aclose()
        await asyncio.gather(*list(pending_health), return_exceptions=True)
        flush()

    context.add_shutdown_callback(shutdown)
    await context.connect()
    await session.start(room=context.room, agent=Agent(instructions=config["instructions"]))
    session.generate_reply(instructions="Greet the user briefly and ask how you can help.")


def run():
    if not status()["ready"]:
        raise ValueError(status()["setup"])
    config = configuration()
    # Use the configured Silero plugin; do not preload unrelated turn-detector models.
    os.environ.setdefault('LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE', '0')
    from livekit import agents
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm, agent_name=config["agentName"], num_idle_processes=1, load_fnc=local_load, load_threshold=0.9, host='127.0.0.1', port=int(os.environ.get('AIIDE_VOICE_HEALTH_PORT', '8081'))))
