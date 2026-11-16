import React from '@theia/core/shared/react';
import type { Connection } from '../common/protocol.js';
import { Call, ConnectionSelect, Heading, duration } from './shared.js';
import { VoiceInput } from './voice-input.js';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useProjectDraft } from './use-project-draft.js';

type Turn = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  latencyMs?: number;
  model?: string;
  instructions?: string;
};

export function VoicePanel({
  connections,
  call,
}: {
  connections: Connection[];
  call: Call;
}) {
  const [{ model, system, draft, language }, setDraftFields, draftError] =
    useProjectDraft(call, 'voice', {
      model: '',
      system:
        'You are a helpful voice assistant. Reply briefly in plain spoken language. Ask one question at a time.',
      draft: '',
      language: 'en-US',
    });
  const setModel = (model: string) =>
    setDraftFields((value) => ({ ...value, model }));
  const setSystem = (system: string) =>
    setDraftFields((value) => ({ ...value, system }));
  const setLanguage = (language: string) =>
    setDraftFields((value) => ({ ...value, language }));
  const setDraft = (update: React.SetStateAction<string>) =>
    setDraftFields((value) => ({
      ...value,
      draft: typeof update === 'function' ? update(value.draft) : update,
    }));
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [speak, setSpeak] = React.useState(false);
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const mounted = React.useRef(true);
  const pending = React.useRef(false);
  const speechAvailable =
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';
  const memoryBody = turns
    .map(
      (turn) =>
        `## ${turn.role === 'user' ? 'You' : 'Agent'}\n\n${turn.content}`,
    )
    .join('\n\n');
  const memoryTooLarge = new TextEncoder().encode(memoryBody).length > 64000;
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.speechSynthesis?.cancel();
    };
  }, []);

  const send = async () => {
    if (pending.current || !model || !draft.trim() || turns.length >= 40)
      return;
    pending.current = true;
    setBusy(true);
    setError('');
    window.speechSynthesis?.cancel();
    const text = draft.trim();
    const started = performance.now();
    const user: Turn = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
      instructions: system,
    };
    try {
      const result = await call('models.complete', {
        id: model,
        messages: [
          { role: 'system', content: system },
          ...turns.map(({ role, content }) => ({ role, content })),
          { role: user.role, content: user.content },
        ],
        temperature: 0.4,
        maxTokens: 512,
      });
      if (!mounted.current) return;
      if (typeof result.text !== 'string' || !result.text.trim())
        throw new Error(
          'The model returned no spoken answer. Try another model or prompt.',
        );
      const answer: Turn = {
        role: 'assistant',
        content: result.text,
        timestamp: Date.now(),
        latencyMs: performance.now() - started,
        model,
      };
      setTurns([...turns, user, answer]);
      setDraft('');
      if (speak && speechAvailable) {
        const utterance = new SpeechSynthesisUtterance(answer.content);
        utterance.lang = language;
        utterance.onerror = (event) => {
          if (
            mounted.current &&
            event.error !== 'canceled' &&
            event.error !== 'interrupted'
          )
            setError(
              'Speech playback failed. The answer is available in the transcript.',
            );
        };
        window.speechSynthesis.speak(utterance);
      }
    } catch (failure) {
      if (mounted.current) setError(String(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const download = (body: string, name: string, type: string) => {
    const file = new Blob([body], { type });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const saveMemory = async () => {
    if (saving || !turns.length || memoryTooLarge) return;
    setSaving(true);
    setError('');
    try {
      const note = await call('knowledge.save', {
        title: 'Voice session ' + new Date().toISOString(),
        body: memoryBody,
        sources: [],
      });
      if (mounted.current) setSaved(note.file || note.id || 'Project memory');
    } catch (failure) {
      if (mounted.current) setError(String(failure));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const exportCases = () => {
    const cases = turns.flatMap((turn, index) =>
      turn.role === 'assistant'
        ? [
            {
              messages: [
                {
                  role: 'system',
                  content: turns[index - 1].instructions || '',
                },
                ...turns
                  .slice(0, index)
                  .map(({ role, content }) => ({ role, content })),
              ],
              expected: turn.content,
              match: 'exact',
            },
          ]
        : [],
    );
    download(
      cases.map((item) => JSON.stringify(item)).join('\n') + '\n',
      'voice-eval-draft.jsonl',
      'application/x-ndjson',
    );
  };

  return (
    <>
      <Heading
        title="Voice agent playground"
        text="Prototype a spoken conversation with any chat model. Dictate, review, send, and listen to the answer."
      />
      <div className="aiide-columns">
        <section className="aiide-card">
          <fieldset disabled={busy}>
            <ConnectionSelect
              label="Voice agent model"
              connections={connections}
              value={model}
              set={setModel}
              kind="model"
            />
            {!connections.some((connection) => connection.kind === 'model') && (
              <p className="aiide-note">
                Add a chat model in Models & playground first.
              </p>
            )}
            <label>
              Agent instructions
              <textarea
                rows={4}
                maxLength={10000}
                value={system}
                onChange={(event) => setSystem(event.target.value)}
              />
            </label>
            <label>
              Speech language
              <input
                aria-label="Speech language"
                value={language}
                maxLength={35}
                placeholder="en-US, hi-IN…"
                onChange={(event) => setLanguage(event.target.value)}
              />
            </label>
            <label className="aiide-checkbox">
              <input
                type="checkbox"
                checked={speak}
                disabled={!speechAvailable}
                onChange={(event) => {
                  setSpeak(event.target.checked);
                  if (!event.target.checked) window.speechSynthesis?.cancel();
                }}
              />{' '}
              Read answers aloud
            </label>
            <p className="aiide-note">
              Playback uses browser or device voices. Online voices may send
              answer text to their provider.
            </p>
          </fieldset>
          {!speechAvailable && (
            <p className="aiide-note">
              Speech playback is unavailable. Answers remain available as text.
            </p>
          )}
          <label>
            Your turn
            <textarea
              aria-label="Voice message"
              rows={4}
              value={draft}
              maxLength={10000}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </label>
          <VoiceInput
            disabled={busy || turns.length >= 40}
            language={language}
            append={(text) =>
              setDraft((value) =>
                [value, text].filter(Boolean).join(' ').slice(0, 10000),
              )
            }
          />
          <div className="aiide-toolbar">
            <button
              className="aiide-primary"
              disabled={busy || !model || !draft.trim() || turns.length >= 40}
              onClick={() => void send()}
            >
              Send turn →
            </button>
            <button
              disabled={!speechAvailable}
              onClick={() => window.speechSynthesis?.cancel()}
            >
              Stop speaking
            </button>
          </div>
          <p role="status">
            {busy
              ? 'Waiting for the model…'
              : `${turns.length / 2} completed turns · Ctrl/⌘+Enter to send`}
          </p>
          <p className="aiide-note">
            Leaving this page stops dictation and playback. Outstanding model
            requests are not cancelled; the connection’s request timeout still
            applies.
          </p>
          {turns.length >= 40 && (
            <p className="aiide-note">
              Session limit reached (20 turns). Export the transcript, then
              start a new session.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {draftError && (
            <p role="alert">Draft could not be saved: {draftError}</p>
          )}
        </section>
        <section className="aiide-card" aria-busy={busy}>
          <h3>Session transcript</h3>
          <p className="aiide-note">
            Kept only while this page is open. Save or export before leaving to
            keep it. Model time measures the full text response, excluding
            speech recognition and playback.
          </p>
          <div className="aiide-toolbar">
            <button
              disabled={busy || !turns.length}
              onClick={() =>
                download(
                  JSON.stringify({ version: 1, language, turns }, null, 2),
                  'voice-session.json',
                  'application/json',
                )
              }
            >
              Export transcript
            </button>
            <button
              disabled={busy || saving || !turns.length || memoryTooLarge}
              onClick={() => void saveMemory()}
            >
              {saving ? 'Saving…' : 'Save to project memory'}
            </button>
            <button disabled={busy || !turns.length} onClick={exportCases}>
              Export evaluation draft
            </button>
            <button
              disabled={busy || saving || !turns.length}
              onClick={() => {
                window.speechSynthesis?.cancel();
                setTurns([]);
                setError('');
                setSaved('');
                setDraft('');
              }}
            >
              New session
            </button>
          </div>
          {memoryTooLarge && (
            <p className="aiide-note">
              This transcript exceeds project memory’s 64 KB page limit. Export
              the full transcript instead; no content will be truncated.
            </p>
          )}
          {saved && (
            <p role="status">
              Saved a snapshot to {saved}. Open Project memory to review it.
            </p>
          )}
          {!!turns.length && (
            <p className="aiide-note">
              Evaluation drafts use generated answers as provisional references.
              Review and correct them before evaluating a model in Serve &
              evaluate.
            </p>
          )}
          {!turns.length && (
            <p>Dictate or type a first message to test your agent.</p>
          )}
          <div role="log" aria-label="Voice transcript">
            {turns.map((turn, index) => (
              <article key={index}>
                <strong>{turn.role === 'user' ? 'You' : 'Agent'}</strong>
                {turn.latencyMs !== undefined && (
                  <small> · Model time {duration(turn.latencyMs)}</small>
                )}
                <pre>{turn.content}</pre>
              </article>
            ))}
          </div>
        </section>
      </div>
      <RealtimeVoice call={call} connections={connections} />
    </>
  );
}

type VoiceProfile = {
  id: string;
  url: string;
  apiKey: string;
  chatConnection: string;
  speechConnection: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  instructions: string;
  agentName: string;
};
const initialProfile: VoiceProfile = {
  id: 'voice-agent',
  url: 'ws://127.0.0.1:7880',
  apiKey: 'devkey',
  chatConnection: '',
  speechConnection: '',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  voice: 'alloy',
  instructions: 'You are a helpful voice agent. Reply briefly and clearly.',
  agentName: 'aiide-voice',
};

function retainTranscript(previous: string[], line: string) {
  const lines = [...previous, line].slice(-200);
  let bytes = lines.reduce(
    (size, value) => size + new TextEncoder().encode(value).length,
    0,
  );
  while (bytes > 60000)
    bytes -= new TextEncoder().encode(lines.shift()!).length;
  return lines;
}

function RealtimeVoice({
  call,
  connections,
}: {
  call: Call;
  connections: Connection[];
}) {
  const [available, setAvailable] = React.useState(connections);
  React.useEffect(() => setAvailable(connections), [connections]);
  const [profiles, setProfiles] = React.useState<VoiceProfile[]>([]);
  const [profile, setProfile] = React.useState(initialProfile);
  const [secret, setSecret] = React.useState('');
  const [runtime, setRuntime] = React.useState<any>();
  const [worker, setWorker] = React.useState<any>();
  const [localRun, setLocalRun] = React.useState<any>();
  const [engine, setEngine] = React.useState('mlx');
  const [localModel, setLocalModel] = React.useState('');
  const [localExecutable, setLocalExecutable] = React.useState('');
  const [mode, setMode] = React.useState('dev');
  const [roomName, setRoomName] = React.useState('aiide-voice-room');
  const [identity, setIdentity] = React.useState('developer');
  const [connected, setConnected] = React.useState(false);
  const [joining, setJoining] = React.useState(false);
  const [reconnecting, setReconnecting] = React.useState(false);
  const [providerHealth, setProviderHealth] = React.useState({
    errors: 0,
    state: '',
    component: '',
  });
  const [muted, setMuted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [text, setText] = React.useState('');
  const [transcript, setTranscript] = React.useState<string[]>([]);
  const room = React.useRef<Room | undefined>(undefined);
  const roomAbort = React.useRef<AbortController | undefined>(undefined);
  const audio = React.useRef<HTMLDivElement>(null);
  const active = React.useRef(true);
  const pending = React.useRef(false);
  const action = async (fn: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (failure) {
      if (active.current) setError(String(failure));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  React.useEffect(() => {
    active.current = true;
    void Promise.all([
      call('voice.profiles'),
      call('voice.status'),
      call('runs.list'),
      call('connections.list'),
    ])
      .then(([found, status, jobs, models]) => {
        if (!active.current) return;
        setProfiles(Array.isArray(found) ? found : []);
        setRuntime(status);
        if (Array.isArray(models)) setAvailable(models);
        if (Array.isArray(jobs)) {
          const running = jobs.find(
            (job) =>
              job.status === 'running' &&
              job.training?.parameters.workflow === 'voice',
          );
          setWorker(running);
          const selected =
            Array.isArray(found) &&
            found.find(
              (profile) => profile.id === running?.training?.parameters.profile,
            );
          if (selected) setProfile(selected);
          setLocalRun(
            jobs.find(
              (job) =>
                job.status === 'running' &&
                job.training?.parameters.workflow === 'local-speech',
            ),
          );
        }
      })
      .catch((failure) => {
        if (active.current) setError(String(failure));
      });
    return () => {
      active.current = false;
      roomAbort.current?.abort();
      void room.current?.disconnect().catch(() => {});
      room.current = undefined;
    };
  }, [call]);
  React.useEffect(() => {
    if (worker?.status !== 'running' && localRun?.status !== 'running') return;
    let current = true;
    const timer = setInterval(
      () =>
        void call('runs.list')
          .then((runs: any[]) => {
            if (current) {
              if (worker) setWorker(runs.find((run) => run.id === worker.id));
              if (localRun)
                setLocalRun(runs.find((run) => run.id === localRun.id));
            }
          })
          .catch((failure) => {
            if (current) setError(String(failure));
          }),
      2000,
    );
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [call, worker?.id, worker?.status, localRun?.id, localRun?.status]);
  const update = (key: keyof VoiceProfile, value: string) =>
    setProfile((old) => ({ ...old, [key]: value }));
  const join = async () => {
    const controller = new AbortController();
    roomAbort.current?.abort();
    roomAbort.current = controller;
    setJoining(true);
    setProviderHealth({ errors: 0, state: '', component: '' });
    let abortGrant: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abortGrant = () =>
        reject(
          controller.signal.reason instanceof Error &&
            controller.signal.reason.name !== 'AbortError'
            ? controller.signal.reason
            : new Error('Voice connection cancelled'),
        );
      controller.signal.addEventListener('abort', abortGrant, { once: true });
    });
    const tokenTimeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            'Voice join token timed out after 20 seconds. Check the workspace and credential vault, then try again.',
          ),
        ),
      20000,
    );
    let grant;
    try {
      grant = await Promise.race([
        call('voice.token', { id: profile.id, room: roomName, identity }),
        cancelled,
      ]);
    } catch (failure) {
      if (active.current) setJoining(false);
      throw failure;
    } finally {
      clearTimeout(tokenTimeout);
      controller.signal.removeEventListener('abort', abortGrant);
    }
    if (!active.current || controller.signal.aborted) {
      if (active.current) setJoining(false);
      return;
    }
    const next = new Room({
      publishDefaults: { stopMicTrackOnMute: true },
      reconnectPolicy: {
        nextRetryDelayInMs: ({ retryCount, elapsedMs }) =>
          elapsedMs < 15000
            ? ([0, 1000, 2000, 5000][retryCount] ?? null)
            : null,
      },
    });
    room.current = next;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      active.current && room.current === next && !controller.signal.aborted;
    const pauseForReconnect = () => {
      if (!current()) return;
      setReconnecting(true);
      setMuted(true);
      void next.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      if (!reconnectTimer)
        reconnectTimer = setTimeout(() => {
          if (current()) {
            setError(
              'Voice reconnection exceeded 15 seconds. Connect again when the server is available.',
            );
            void next.disconnect().catch(() => {});
          }
        }, 15000);
    };
    next.on(RoomEvent.Reconnecting, pauseForReconnect);
    next.on(RoomEvent.SignalReconnecting, pauseForReconnect);
    next.on(RoomEvent.Reconnected, () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (current()) setReconnecting(false);
    });
    next.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (
        !current() ||
        topic !== 'aiide.voice.health' ||
        !participant?.isAgent ||
        payload.byteLength > 1024
      )
        return;
      try {
        const value = JSON.parse(new TextDecoder().decode(payload));
        if (!['retrying', 'failed', 'closed'].includes(value.state)) return;
        const component = [
          'stt_error',
          'llm_error',
          'tts_error',
          'realtime_model_error',
          'provider_error',
        ].includes(value.component)
          ? value.component
          : '';
        setProviderHealth((old) => ({
          state: value.state,
          component,
          errors: old.errors + Number(value.state !== 'closed'),
        }));
        if (value.state !== 'retrying') {
          setMuted(true);
          setError(
            'The voice session stopped. Inspect provider diagnostics in Runs and connect with a new room name.',
          );
          void next.disconnect().catch(() => {});
        }
      } catch {
        /* Ignore malformed room data, never display provider payloads. */
      }
    });
    const append = (identity: string, text: string) => {
      if (!active.current || room.current !== next || controller.signal.aborted)
        return;
      if (text.length > 8000 || new TextEncoder().encode(text).length > 8000) {
        setError('A remote transcript segment exceeded 8 KB and was ignored.');
        return;
      }
      const line = `${identity.slice(0, 64)}: ${text}`;
      setTranscript((old) => retainTranscript(old, line));
    };
    let streams = 0;
    next.registerTextStreamHandler(
      'lk.transcription',
      async (reader, participant) => {
        if (streams >= 4) {
          await reader[Symbol.asyncIterator]().return?.();
          return;
        }
        streams++;
        try {
          let text = '',
            bytes = 0;
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]);
          for await (const chunk of reader.withAbortSignal(signal)) {
            if (
              !active.current ||
              room.current !== next ||
              controller.signal.aborted
            )
              return;
            if (
              chunk.length > 8000 ||
              (bytes += new TextEncoder().encode(chunk).length) > 8000
            ) {
              setError(
                'A remote transcript stream exceeded 8 KB and was ignored.',
              );
              return;
            }
            text += chunk;
          }
          if (text.trim()) append(participant.identity, text);
        } catch (failure) {
          if (
            !controller.signal.aborted &&
            active.current &&
            room.current === next
          )
            setError('Transcript stream closed before completion.');
        } finally {
          streams--;
        }
      },
    );
    next.on(RoomEvent.TrackSubscribed, (track) => {
      if (
        track.kind === Track.Kind.Audio &&
        active.current &&
        room.current === next
      )
        audio.current?.appendChild(track.attach());
    });
    next.on(RoomEvent.TrackUnsubscribed, (track) =>
      track.detach().forEach((node) => node.remove()),
    );
    next.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      for (const segment of segments.slice(0, 200))
        if (segment.final)
          append(participant?.identity || 'Agent', segment.text);
    });
    next.on(RoomEvent.Disconnected, () => {
      clearTimeout(reconnectTimer);
      controller.abort();
      if (active.current && room.current === next) {
        setConnected(false);
        setReconnecting(false);
        audio.current?.replaceChildren();
      }
    });
    next.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.isAgent && active.current && room.current === next) {
        setError(
          'The voice agent left the room. Inspect its worker run and connect with a new room name.',
        );
        setMuted(true);
        void next.disconnect().catch(() => {});
      }
    });
    try {
      await next.connect(grant.url, grant.token);
      if (!current()) {
        await next.disconnect();
        return;
      }
      await next.localParticipant.setMicrophoneEnabled(true);
      if (!current()) {
        await next.disconnect();
        return;
      }
      await next.startAudio();
      if (!current()) {
        await next.disconnect();
        return;
      }
      setConnected(true);
      setReconnecting(false);
      setMuted(false);
      setTranscript([]);
    } catch (failure) {
      controller.abort();
      await next.disconnect();
      room.current = undefined;
      throw failure;
    } finally {
      if (active.current) setJoining(false);
    }
  };
  const stored = profiles.find((item) => item.id === profile.id);
  const savedProfile = Boolean(
    stored &&
      Object.entries(profile).every(
        ([key, value]) => stored[key as keyof VoiceProfile] === value,
      ),
  );
  const memoryBody = transcript.join('\n\n');
  const memoryTooLarge = new TextEncoder().encode(memoryBody).length > 64000;
  return (
    <section className="aiide-card">
      <h3>Realtime LiveKit agent</h3>
      <p>
        Run a WebRTC speech → model → speech worker with Silero voice activity
        detection and interruption handling. Audio goes to your selected speech
        service and LiveKit server. This mode uses WebRTC and does not depend on
        browser speech recognition.
      </p>
      <p role="status">
        {runtime?.ready
          ? 'LiveKit runtime ready'
          : runtime?.setup || 'Checking the project voice runtime…'}
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void action(async () => setRuntime(await call('voice.status')))
        }
      >
        Check voice runtime
      </button>
      <details>
        <summary>Run speech entirely on this computer</summary>
        <p>
          Use a predownloaded local Whisper model with ffmpeg and device TTS.
          MLX requires Apple Silicon and mlx-whisper in the project environment;
          whisper.cpp uses a compiled local executable. Models are never
          downloaded automatically. Device TTS uses the OS default voice.
        </p>
        <label>
          Local speech engine
          <select
            value={engine}
            disabled={busy}
            onChange={(event) => setEngine(event.target.value)}
          >
            <option value="mlx">MLX Whisper (Apple Silicon)</option>
            <option value="whisper.cpp">whisper.cpp</option>
          </select>
        </label>
        <label>
          Local Whisper model path
          <input
            value={localModel}
            disabled={busy}
            placeholder="models/whisper-tiny (workspace-relative)"
            onChange={(event) => setLocalModel(event.target.value)}
          />
        </label>
        {engine === 'whisper.cpp' && (
          <label>
            Local whisper.cpp executable
            <input
              value={localExecutable}
              disabled={busy}
              placeholder="tools/whisper-cli (workspace-relative)"
              onChange={(event) => setLocalExecutable(event.target.value)}
            />
          </label>
        )}
        <div className="aiide-toolbar">
          <button
            disabled={
              busy ||
              !localModel ||
              (engine === 'whisper.cpp' && !localExecutable) ||
              localRun?.status === 'running'
            }
            onClick={() =>
              void action(async () => {
                const result = await call('voice.localStart', {
                  engine,
                  model: localModel,
                  ...(engine === 'whisper.cpp'
                    ? { executable: localExecutable }
                    : {}),
                });
                setLocalRun(result.run);
                setAvailable((old) => [
                  ...old.filter(
                    (connection) => connection.id !== result.connection.id,
                  ),
                  result.connection,
                ]);
                update('speechConnection', result.connection.id);
              })
            }
          >
            Start local speech service
          </button>
          <button
            disabled={busy || localRun?.status !== 'running'}
            onClick={() =>
              void action(async () => {
                await call('runs.cancel', { id: localRun.id });
                setLocalRun({ ...localRun, status: 'cancelled' });
              })
            }
          >
            Stop local speech service
          </button>
        </div>
        {localRun && (
          <p role="status">
            Local speech {localRun.id} · {localRun.status}. The registered
            local-speech connection requires this service to remain running.
          </p>
        )}
      </details>
      <fieldset disabled={busy || connected || worker?.status === 'running'}>
        <label>
          Saved voice profile
          <select
            value={savedProfile ? profile.id : ''}
            onChange={(event) => {
              const found = profiles.find(
                (item) => item.id === event.target.value,
              );
              setProfile(found || initialProfile);
              setSecret('');
            }}
          >
            <option value="">New profile</option>
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
        <div className="aiide-form-grid">
          <label>
            Profile ID
            <input
              value={profile.id}
              maxLength={64}
              onChange={(event) => update('id', event.target.value)}
            />
          </label>
          <label>
            LiveKit server URL
            <input
              value={profile.url}
              maxLength={500}
              onChange={(event) => update('url', event.target.value)}
            />
          </label>
          <label>
            LiveKit API key ID
            <input
              value={profile.apiKey}
              maxLength={200}
              onChange={(event) => update('apiKey', event.target.value)}
            />
          </label>
          <label>
            LiveKit API secret
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              placeholder="Stored in the OS vault; leave blank to keep"
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
        </div>
        <ConnectionSelect
          label="Realtime chat connection"
          connections={available}
          value={profile.chatConnection}
          set={(value) => update('chatConnection', value)}
          kind="model"
        />
        <ConnectionSelect
          label="Speech API connection"
          connections={available}
          value={profile.speechConnection}
          set={(value) => update('speechConnection', value)}
          kind="model"
        />
        <p className="aiide-note">
          The speech connection must implement OpenAI-compatible audio
          transcription and speech endpoints. A successful chat capability probe
          does not verify these audio endpoints.
        </p>
        <div className="aiide-form-grid">
          <label>
            Transcription model
            <input
              value={profile.sttModel}
              onChange={(event) => update('sttModel', event.target.value)}
            />
          </label>
          <label>
            Speech model
            <input
              value={profile.ttsModel}
              onChange={(event) => update('ttsModel', event.target.value)}
            />
          </label>
          <label>
            Speech voice
            <input
              value={profile.voice}
              onChange={(event) => update('voice', event.target.value)}
            />
          </label>
          <label>
            Agent dispatch name
            <input
              value={profile.agentName}
              onChange={(event) => update('agentName', event.target.value)}
            />
          </label>
        </div>
        <label>
          Realtime agent instructions
          <textarea
            rows={3}
            maxLength={10000}
            value={profile.instructions}
            onChange={(event) => update('instructions', event.target.value)}
          />
        </label>
        <button
          onClick={() =>
            void action(async () => {
              await call('voice.save', {
                profile,
                ...(secret ? { secret } : {}),
              });
              setSecret('');
              setProfiles(await call('voice.profiles'));
            })
          }
        >
          Save voice profile
        </button>
      </fieldset>
      <div className="aiide-toolbar">
        <label>
          Worker mode
          <select
            value={mode}
            disabled={busy}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="dev">Development</option>
            <option value="start">Production worker</option>
          </select>
        </label>
        <button
          disabled={
            busy ||
            !savedProfile ||
            !runtime?.ready ||
            worker?.status === 'running'
          }
          onClick={() =>
            void action(async () =>
              setWorker(await call('voice.start', { id: profile.id, mode })),
            )
          }
        >
          Start voice worker
        </button>
        <button
          disabled={busy || worker?.status !== 'running'}
          onClick={() =>
            void action(async () => {
              await call('runs.cancel', { id: worker.id });
              setWorker({ ...worker, status: 'cancelled' });
            })
          }
        >
          Stop voice worker
        </button>
      </div>
      {worker && (
        <p role="status">
          Worker {worker.id} · {worker.status}. Inspect its run in Runs for
          speech metrics, transcripts and failures. Starting a process does not
          establish provider readiness.
        </p>
      )}
      <div className="aiide-form-grid">
        <label>
          Room name
          <input
            value={roomName}
            disabled={busy || connected}
            onChange={(event) => setRoomName(event.target.value)}
          />
        </label>
        <label>
          Participant identity
          <input
            value={identity}
            disabled={busy || connected}
            onChange={(event) => setIdentity(event.target.value)}
          />
        </label>
      </div>
      <div className="aiide-toolbar">
        <button
          disabled={busy || connected || !savedProfile}
          onClick={() => void action(join)}
        >
          Connect microphone
        </button>
        <button
          disabled={busy || !connected || reconnecting}
          onClick={() =>
            void action(async () => {
              await room.current?.localParticipant.setMicrophoneEnabled(muted);
              setMuted(!muted);
            })
          }
        >
          {muted ? 'Unmute microphone' : 'Mute microphone'}
        </button>
        <button
          disabled={!connected && !joining}
          onClick={() =>
            void (async () => {
              roomAbort.current?.abort();
              await room.current?.disconnect().catch(() => {});
              if (active.current) {
                room.current = undefined;
                setConnected(false);
                setReconnecting(false);
                audio.current?.replaceChildren();
              }
            })()
          }
        >
          {joining ? 'Cancel connection' : 'Disconnect room'}
        </button>
      </div>
      <p role="status">
        {reconnecting
          ? 'Reconnecting · microphone paused; unmute after recovery'
          : joining
            ? 'Connecting voice room…'
            : connected
              ? muted
                ? 'Connected · microphone muted'
                : 'Connected · microphone live'
              : 'Room disconnected'}
      </p>
      {!!providerHealth.errors && (
        <p role="status">
          Provider errors observed: {providerHealth.errors} ·{' '}
          {providerHealth.component || 'session'} ·{' '}
          {providerHealth.state === 'retrying'
            ? 'retry attempted; inspect Runs for timing'
            : 'session stopped'}
        </p>
      )}
      <p className="aiide-note">
        Transcription and chat allow up to two retries with a 15-second API
        timeout. Partial replies and speech synthesis are never automatically
        replayed. Connection recovery pauses microphone capture; unmute
        explicitly after recovery.
      </p>
      <label>
        Realtime text message
        <input
          value={text}
          maxLength={4000}
          disabled={!connected || busy || reconnecting}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button
        disabled={!connected || busy || reconnecting || !text.trim()}
        onClick={() =>
          void action(async () => {
            await room.current?.localParticipant.sendText(text.trim(), {
              topic: 'lk.chat',
            });
            setTranscript((old) =>
              retainTranscript(old, `${identity}: ${text.trim()}`),
            );
            setText('');
          })
        }
      >
        Send realtime message
      </button>
      <div ref={audio} />
      <div role="log" aria-label="Realtime voice transcript">
        {transcript.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
      <button
        disabled={busy || !transcript.length || memoryTooLarge}
        onClick={() =>
          void action(async () => {
            await call('knowledge.save', {
              title: `Realtime voice ${new Date().toISOString()}`,
              body: memoryBody,
              sources: [],
            });
          })
        }
      >
        Save realtime transcript to memory
      </button>
      {memoryTooLarge && (
        <p role="status">
          Recent transcript exceeds memory's 64 KB limit. Save selected portions
          manually; no content will be truncated.
        </p>
      )}
      <p className="aiide-note">
        Leaving disconnects your microphone and audio. The worker continues
        until stopped or the IDE closes. Transcript display retains the most
        recent 200 segments or 60 KB; run telemetry follows content-capture
        settings. No raw audio recording is saved.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
