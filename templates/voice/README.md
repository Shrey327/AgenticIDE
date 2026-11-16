# LiveKit voice agent

Run `setup` in the IDE, then open **Build → Voice agents**. Save a profile with your LiveKit server, API key ID and secret, and chat/speech model connections. Start the worker and connect your microphone to a room. The speech connection must implement OpenAI-compatible `/audio/transcriptions` and `/audio/speech`; the chat connection must support chat completions. Model capability probes do not establish audio compatibility.

The worker uses the actual LiveKit Agents framework, Silero VAD, streaming model output/speech, and interruption handling. Credentials stay in the IDE OS vault and are injected into the worker environment only when launched. Transcript/latency telemetry uses `aiide_sdk`; saved text follows the project content-capture setting. Raw audio is not recorded.

For self-hosted local development, run the official server on loopback:

```sh
docker run --rm -p 127.0.0.1:7880:7880 -p 127.0.0.1:7881:7881 -p 127.0.0.1:7882:7882/udp livekit/livekit-server:v1.9.11 --dev --bind 0.0.0.0 --node-ip 127.0.0.1
```

The development-only key is `devkey` and secret is `secret`. Use WSS, your own rotated credentials and the [LiveKit deployment guidance](https://docs.livekit.io/transport/self-hosting/deployment/) for a remote server.

Outside the IDE, the copied `aiide_voice` and `aiide_sdk` packages keep this project portable. Provide deployment environment variables through your secret manager:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- `OPENAI_API_KEY` for the default speech/chat provider, or `AIIDE_VOICE_CHAT_KEY` and `AIIDE_VOICE_SPEECH_KEY` separately.
- Optional `AIIDE_MODEL_URL`, `AIIDE_MODEL_NAME`, `AIIDE_SPEECH_URL`, `AIIDE_STT_MODEL`, `AIIDE_TTS_MODEL`, `AIIDE_TTS_VOICE`, `AIIDE_VOICE_INSTRUCTIONS`, `AIIDE_VOICE_AGENT_NAME`.

```sh
uv sync --locked
uv run main.py dev
uv run main.py start  # production worker registration and job draining
docker build -t my-voice-agent .
```

The Dockerfile uses a non-root worker and excludes local credentials. Inject secrets at runtime; never bake them into the image. Server TLS/network policy, operational scaling, provider billing and PSTN/SIP provisioning remain deployment responsibilities. Production mode does not certify voice quality or availability.

Container deployments need speech/chat URLs reachable from that container (for example a Docker network service name). `127.0.0.1` inside a container refers to that container. The local speech adapter uses temporary audio files removed after each request; abrupt termination can leave files in the OS temporary directory. It does not create persistent recordings.
