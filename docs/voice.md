# Voice agents: realtime workers, local speech, and dictation

## Realtime LiveKit workflow

The **Realtime LiveKit agent** section runs an actual LiveKit Agents worker. Create a **LiveKit voice agent** project from Home and run its locked setup, or install `livekit-agents[openai,silero]==1.8.12` with the existing project's package manager. The project Python executable must point to that environment. Check runtime installation from the panel.

Save a named profile with the LiveKit WSS server (loopback WS is accepted for development), API key ID, API secret, chat connection, speech API connection, models, voice and instructions. The speech API must implement OpenAI-compatible audio transcription and PCM speech generation. A successful chat probe does not validate audio endpoints. The API secret and provider keys use the existing OS vault; profile files contain credential references, and recorded run metadata contains only the profile ID/mode.

Start the worker in development or production mode, choose a room and participant identity, then **Connect microphone**. The browser uses the LiveKit client SDK and WebRTC, independently of browser SpeechRecognition availability. The join token is signed on the backend, scoped to one room/participant, expires after 15 minutes, and requests the named agent dispatch. It grants no room administration. Microphone permission is requested only after the explicit action. Mute/disconnect controls and navigation release local capture; leaving the page does not stop the worker. Stop the worker explicitly or cancel it through Runs.

The worker uses Silero VAD for endpointing, OpenAI-compatible utterance transcription, streamed chat/TTS output and LiveKit interruption handling. It records transcript spans, agent-state events and numeric pipeline metrics through the SDK. Content-capture settings control transcript persistence; no raw audio recording is saved. The room transcript retains the latest 200 segments or 60 KB and can be explicitly saved to project memory within its byte limit. Remote segments/streams over 8 KB are rejected; stream concurrency/timeouts and disconnect cancellation bound consumption. Saving retains the displayed window without silently truncating it.

The copied runtime packages keep generated projects portable. The template includes a non-root Dockerfile, credential exclusions, exact dependency lock, and deployment instructions. `start` registers a production worker using LiveKit's worker lifecycle; it does not certify provider quality, infrastructure availability or production load capacity. See the [template guide](../templates/voice/README.md).

## Recovery and provider failures

**Cancel connection** stops an in-progress join, including while the vault-backed join token is pending. Token acquisition has a 20-second client deadline; a late response cannot reopen a cancelled room. The LiveKit client retries a broken signal/media connection at most four times within a 15-second recovery window, then disconnects. Any reconnect attempt stops microphone capture. Successful recovery keeps the microphone muted until **Unmute microphone** is explicitly selected. Ordinary mute also stops the capture track instead of leaving it running silently.

Transcription and chat permit at most two retries after the initial request, with a 15-second SDK API timeout and a configured 0.5-second retry interval. This bounds stalled requests; it is not an end-to-end acoustic latency SLA or a deadline on an entire conversation. Chat retries stop as soon as output text or a tool call has been delivered, preventing partial replies from being replayed. Speech synthesis is not automatically retried because a partial sound may already have been heard. After retries are exhausted, the session closes, the room disconnects and microphone capture stops. Inspect the worker in Runs and connect with a fresh room name after resolving the provider problem; the worker itself can remain registered for a later session.

Failure category, recoverability and session-close reason are recorded as `voice.provider_error`, `voice.provider_errors` and `voice.session_closed`. These records contain no raw exception, provider body or credential. The UI accepts bounded health packets only from an agent participant and displays observed errors separately from connection state. These packets are advisory; persisted run evidence is the retrospective record. Other participants cannot inject provider status into the panel.

The no-replay guard is deliberately tied to the pinned LiveKit 1.8.12 stream contract, covered by real partial-response tests. If that contract disappears, the runtime fails closed with an instruction to use the locked environment. Upgrading the SDK requires rerunning the provider-failure and RTC suites. The public fallback adapter is not used: its background recovery probes would exceed the per-turn retry budget and require separate lifecycle management. IDE-managed workers use the trusted bundled runtime. Standalone generated projects retain their copied runtime; create a fresh voice project or review and explicitly update that copy to receive these changes outside the IDE. User-authored project commands remain the explicit path for custom worker code.

The recovery policy follows the pinned SDK and its [connection policy](https://docs.livekit.io/reference/client-sdk-js/interfaces/ReconnectPolicy.html), [room options](https://docs.livekit.io/reference/client-sdk-js/interfaces/RoomOptions.html), and [provider error/close events](https://docs.livekit.io/reference/agents/events/).

## Run speech locally

For local infrastructure, use a loopback LiveKit server, a local chat model connection, and **Run speech entirely on this computer**. The speech service supports either an existing MLX Whisper model directory on Apple Silicon or an existing whisper.cpp model/executable. All paths entered in the IDE are workspace-relative and reject symlinks. Models and binaries are never downloaded or installed automatically. MLX requires `mlx-whisper==0.4.3` in the selected Python environment. Both paths require `ffmpeg`/`ffprobe`; TTS uses macOS `say` or Linux `espeak-ng`, with the OS default voice.

Starting local speech creates a recorded, cancellable service on a dynamically selected loopback port and registers a unique `local-speech-<run>` model connection with a random vault-backed bearer token. Use that connection in the voice profile and keep the service running. The speech service rejects browser origins, invalid Host headers, unauthenticated requests, inputs over 16 MB, non-PCM16 WAV and utterances over 60 seconds. Model loading is offline-only. Inference uses bounded temporary audio files, removed after each request; an abrupt process/OS failure can leave files in the OS temporary directory. It creates no persistent call recording. Local engine execution is an explicit IDE action and is not exposed through MCP.

The local API admits at most two concurrent requests and one transcription at a time, so recognition cannot block speech playback. Slow or excess clients receive bounded timeouts or busy responses. The desktop worker reserves capacity by active sessions rather than refusing its first call because another experiment is using CPU. Turn handling explicitly uses local VAD instead of LiveKit's cloud adaptive interruption service.

## Turn-based playground and dictation

Open **Build → Voice agents**, select an existing chat model connection, and edit the agent's instructions. You can type a message in every supported IDE environment. In browsers exposing Web Speech recognition, **Dictate** starts the microphone only after a click and the browser's permission prompt. **Stop dictation** ends capture. Only final recognition text is inserted; interim words appear in the listening status. Review the transcript and choose **Send turn** (or Ctrl/⌘+Enter).

**Read answers aloud** opts into browser/device speech synthesis. **Stop speaking** interrupts playback. Starting dictation also stops speech so the microphone does not deliberately listen to a continuing answer. This is a turn-based prototype: sending a message stops recognition; the agent does not automatically send recognized text or resume listening. Leaving the page releases recognition and stops speech. Text fallback remains available when speech APIs are absent or the microphone is denied.

Speech recognition and synthesis depend on the browser, OS, available voices, and language support. Electron builds may expose no usable recognition service. Browser recognition may send audio to a remote service; an online voice may send answer text to its provider. This feature does not promise offline speech. The chosen chat model receives the instructions and conversation through the existing model connection. No raw microphone recording is stored by the IDE.

Sessions retain at most 20 completed turns, with a 10,000-character input limit. **Model time** measures the complete text model call; it excludes transcription, endpointing, and playback, so it is not a voice end-to-end latency benchmark. Failed model calls keep the draft for retry. A pending model request continues on its provider if you navigate away, but its response will not start speech on another page.

The model choice, instructions, language and unsent text draft persist locally across navigation/restart. Credentials and join tokens never enter this draft store. The completed turn-based transcript exists only while the page is mounted. Use one of these explicit actions to retain it:

- **Export transcript** downloads JSON containing the turns, timestamps, per-answer model IDs and response times, and the instructions used for each request.
- **Save to project memory** writes a Markdown snapshot through the project knowledge service. The saved file appears in Project memory. Saving is disabled when the UTF-8 transcript body exceeds the memory service's 64 KB page limit; the full transcript can still be exported. No content is truncated.
- **Export evaluation draft** downloads JSONL compatible with Serve & evaluate. Each case includes its complete preceding text conversation. The generated answer is a provisional expected value, not a verified ground truth. Correct these references before using the dataset for quality comparisons.

The reusable `VoiceInput` component also supplies dictation to other IDE text entry points. It receives an `append(text)` callback and optional `disabled` and `language` props; it never invokes model or command tools.

**New session** clears both the completed transcript and the unsent draft. Export first to keep them. Leaving the page stops dictation and playback but does not cancel an outstanding model request; the connection's existing request timeout still applies.

## Market comparison and remaining work

Research date: 2026-11-15. These are direct product/project sources, not claims of benchmark parity.

| Product/project | Documented workflow | This implementation | Remaining gap |
| --- | --- | --- | --- |
| [LiveKit Agents: debugging and testing](https://docs.livekit.io/testing/overview/) and [agent simulations](https://docs.livekit.io/testing/simulations/) | Interactive console, unit assertions on messages/tools/handoffs, text and audio simulations | Native SDK WebRTC client, actual LiveKit worker, VAD, interruptions, model/speech profiles and deployable template | Specialized tool handoffs, managed simulations and operational infrastructure acceptance |
| [LiveKit session traces](https://docs.livekit.io/reference/agents/session-traces/) | Per-session spans and separate end-to-end, STT, endpointing, LLM, TTS and tool timing | SDK transcript/state spans and available numeric provider metrics | Full caller-perceived acoustic latency, recording/egress and sustained-load measurements |
| [Pipecat](https://docs.pipecat.ai/overview/introduction) | Python real-time voice/multimodal pipelines, client SDKs, self-hosting or managed hosting | One framework integration through LiveKit | Separate Pipecat adapter and its deployment acceptance |
| [Vapi assistants](https://docs.vapi.ai/assistants/quickstart) | Configure transcriber/model/voice, web test, connect a phone number, review logs/recordings | Configurable speech/chat services, WebRTC session, scoped credentials, transcripts/metrics | PSTN/SIP provisioning, call routing/recordings, billing and call operations |

The local workflow uses the [LiveKit Agents API](https://docs.livekit.io/agents/start/voice-ai/), [Silero/turn handling](https://docs.livekit.io/agents/logic/turns/), and [events/metrics contract](https://docs.livekit.io/reference/agents/events/). Self-hosted deployment still requires TLS, network policy, operational monitoring and user-specific acoustic acceptance.

## Validation

Full local production-mode acceptance passed on 16 November 2026 with LiveKit Server 1.9.11, LiveKit Agents 1.8.12, actual whisper.cpp tiny.en recognition and macOS device TTS. A generated spoken WAV travels through Chrome's real WebRTC microphone transport and Silero VAD; the recognized user turn reaches the chat endpoint, and actual returned audio is observed after recognition. User transcript spans persist through the Collector. Chat responses use a deterministic HTTP fixture; no claim about a real language model's answer quality or a physical microphone is implied. The nine Python speech/security checks also pass, including actual recognition/synthesis and overlapping HTTP transcription/playback.

After building core/assets, reproduce the full flow with Docker, Chrome and installed local speech tools:

```sh
AIIDE_VOICE_TEST_PYTHON=/absolute/voice-environment/bin/python \
AIIDE_VOICE_TEST_MODEL=/absolute/ggml-tiny.en.bin \
AIIDE_VOICE_TEST_EXECUTABLE=/absolute/whisper-cli \
npm run test:production:voice
```

Use `AIIDE_VOICE_TEST_ENGINE=mlx` and an existing local MLX model directory for the alternative engine; that engine is supported but this full acceptance used whisper.cpp. `AIIDE_VOICE_TEST_CHAT_URL` and `AIIDE_VOICE_TEST_CHAT_MODEL` can select an already-running local chat endpoint instead of the fixture. The script creates only disposable projects/containers and does not download models.

Add `AIIDE_VOICE_TEST_FAULTS=1` to the same command to run the local reliability scenarios. This mode requires the disposable chat fixture: it injects a 503 on the recognized spoken turn, closes the real signaling WebSocket, checks that recovery leaves all microphone tracks stopped, then injects a permanent outage and verifies exactly three requests, room teardown and persisted failure evidence. This complete production-mode scenario passed on 16 November 2026. Six additional Python checks exercise the actual pinned SDK against transient, permanent, hanging, truncated and cancelled HTTP streams; partial output is never replayed and exception payloads are excluded from the new telemetry.

Run `npm run test:voice:realtime:ui` for RTC client cancellation, bounded remote streams and transcript cleanup checks.

Run `node scripts/test-voice-ui.mjs` with Chrome available (or `CHROME_PATH` set). It renders the real React components with deterministic browser speech and model fixtures and checks unsupported recognition fallback, manual sending, pending-request controls, opt-in speech, memory persistence requests, evaluation exports, final-only dictation, permission errors, failed-call draft retention, and microphone teardown.

These fixtures verify UI behavior, not physical microphone quality, browser speech service availability, speech accuracy, acoustic interruption handling, or paid provider integrations. The recognition compatibility/privacy behavior is documented by [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
