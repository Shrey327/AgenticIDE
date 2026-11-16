import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { z } from 'zod';
import { Runs } from './runs';
import { Connections } from './models';
import { loadProject } from './project';
import { within, hash } from './security';
import { subprocess } from './ssh';

const profileSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    url: z.string().max(500),
    apiKey: z.string().min(1).max(200),
    chatConnection: z.string().min(1).max(64),
    speechConnection: z.string().min(1).max(64),
    sttModel: z.string().min(1).max(200).default('whisper-1'),
    ttsModel: z.string().min(1).max(200).default('tts-1'),
    voice: z.string().min(1).max(100).default('alloy'),
    instructions: z.string().min(1).max(10000),
    agentName: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .default('aiide-voice'),
  })
  .strict();
type Profile = z.infer<typeof profileSchema> & { credentialRef: string };

function mediaUrl(url: string) {
  const endpoint = new URL(url);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    (endpoint.protocol === 'ws:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
  )
    throw new Error(
      'Use wss:// for a remote LiveKit server, or ws:// for loopback development',
    );
  return url.replace(/\/$/, '');
}

/** LiveKit credentials stay in the OS vault; workers inherit them only for their run. */
export class VoiceAgents {
  private launching = false;
  private localLaunching = false;
  private cleanupTimer: NodeJS.Timeout;
  constructor(
    readonly root: string,
    readonly runs: Runs,
    readonly connections: Connections,
    readonly assets: string,
  ) {
    this.cleanup();
    this.cleanupTimer = setInterval(() => {
      try {
        this.cleanup();
      } catch {
        /* Workspace shutdown can race a final cleanup tick. */
      }
    }, 1000);
    this.cleanupTimer.unref();
  }
  cleanup() {
    for (const run of this.runs.store.runs()) {
      const service = run.configuration?.localSpeech as
        | {
            connection: string;
            url: string;
            credentialRef?: string;
            removed?: boolean;
          }
        | undefined;
      if (!service || service.removed || run.status === 'running') continue;
      const connection = this.connections
        .list()
        .find((connection) => connection.id === service.connection);
      if (
        connection?.url === service.url &&
        connection.credentialRef === service.credentialRef
      )
        this.connections.remove(service.connection);
      this.runs.store.saveRun({
        ...run,
        configuration: {
          ...run.configuration,
          localSpeech: { ...service, removed: true },
        },
      });
    }
  }
  close() {
    clearInterval(this.cleanupTimer);
    this.cleanup();
  }
  private records(): Profile[] {
    const file = within(this.root, '.aiide/voice/profiles.json', true);
    if (!fs.existsSync(file)) return [];
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 256000)
      throw new Error(
        'Voice profiles must be a regular JSON file below 256 KB',
      );
    return z
      .array(profileSchema.extend({ credentialRef: z.string().min(1) }))
      .max(16)
      .parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  profiles() {
    return this.records().map(({ credentialRef, ...profile }) => profile);
  }
  private get(id: string) {
    const profile = this.records().find((profile) => profile.id === id);
    if (!profile) throw new Error('Voice profile not found');
    mediaUrl(profile.url);
    return profile;
  }
  async save(input: unknown) {
    const args = z
      .object({
        profile: profileSchema,
        secret: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .parse(input);
    args.profile.url = mediaUrl(args.profile.url);
    for (const id of [
      args.profile.chatConnection,
      args.profile.speechConnection,
    ])
      if (this.connections.get(id).kind !== 'model')
        throw new Error('Choose model connections for speech and chat');
    const profiles = this.records();
    const previous = profiles.find((profile) => profile.id === args.profile.id);
    const credentialRef = `voice-${hash(`${this.root}:${args.profile.id}:${args.profile.url}:${args.profile.apiKey}`)}`;
    if (args.secret)
      await this.connections.vault.set(credentialRef, args.secret);
    else if (
      previous?.credentialRef !== credentialRef ||
      !(await this.connections.vault.get(credentialRef))
    )
      throw new Error(
        'Provide the LiveKit API secret when creating or changing a server credential',
      );
    const next = [
      ...profiles.filter((profile) => profile.id !== args.profile.id),
      { ...args.profile, credentialRef },
    ];
    if (next.length > 16) throw new Error('Keep at most 16 voice profiles');
    const file = within(this.root, '.aiide/voice/profiles.json', true);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = within(
      this.root,
      `.aiide/voice/${crypto.randomUUID()}.tmp`,
      true,
    );
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return this.profiles().find((profile) => profile.id === args.profile.id);
  }
  status() {
    const python = loadProject(this.root).environment.python;
    return subprocess(
      python.includes('/') ? path.resolve(this.root, python) : python,
      [
        '-I',
        path.join(this.assets, 'python', 'aiide_runtime', 'launch.py'),
        'aiide_voice',
        'status',
      ],
      {},
      15000,
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONNOUSERSITE: '1',
      } as NodeJS.ProcessEnv,
    );
  }
  async start(input: unknown) {
    const args = z
      .object({
        id: z.string().min(1).max(64),
        mode: z.enum(['dev', 'start']).default('dev'),
      })
      .strict()
      .parse(input);
    if (
      this.launching ||
      this.runs.store
        .runs()
        .some(
          (run) =>
            run.status === 'running' &&
            run.training?.parameters.workflow === 'voice',
        )
    )
      throw new Error(
        'A voice worker is already running; stop it before starting another',
      );
    this.launching = true;
    try {
      const profile = this.get(args.id);
      const secret = await this.connections.vault.get(profile.credentialRef);
      if (!secret)
        throw new Error(
          'LiveKit credential is missing from the OS vault; save the profile secret again',
        );
      const chat = this.connections.get(profile.chatConnection),
        speech = this.connections.get(profile.speechConnection);
      if (chat.kind !== 'model' || speech.kind !== 'model' || !chat.model)
        throw new Error('Choose a configured chat and speech model connection');
      const chatKey = chat.credentialRef
        ? await this.connections.vault.get(chat.credentialRef)
        : undefined;
      const speechKey = speech.credentialRef
        ? await this.connections.vault.get(speech.credentialRef)
        : undefined;
      const { credentialRef, ...config } = profile;
      const healthPort = await new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const port = (probe.address() as net.AddressInfo).port;
          probe.close((error) => (error ? reject(error) : resolve(port)));
        });
      });
      const run = await this.runs.start(
        `Voice · ${profile.id}`,
        {
          target: 'local',
          framework: 'custom',
          parameters: {
            workflow: 'voice',
            profile: profile.id,
            mode: args.mode,
          },
          cursor: 0,
          connection: 'connected',
        },
        {
          AIIDE_VOICE_CONFIG: JSON.stringify({
            ...config,
            chatUrl: chat.url,
            chatModel: chat.model,
            speechUrl: speech.url,
          }),
          LIVEKIT_URL: profile.url,
          LIVEKIT_API_KEY: profile.apiKey,
          LIVEKIT_API_SECRET: secret,
          AIIDE_VOICE_CHAT_KEY: chatKey || 'local-no-key',
          AIIDE_VOICE_SPEECH_KEY: speechKey || 'local-no-key',
          AIIDE_VOICE_HEALTH_PORT: String(healthPort),
        },
        { command: ['python', '-m', 'aiide_voice', args.mode], lab: undefined },
      );
      try {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if (this.runs.store.run(run.id)?.status !== 'running')
            throw new Error(
              'Voice worker stopped before registering with LiveKit; inspect its run',
            );
          try {
            const response = await fetch(`http://127.0.0.1:${healthPort}/`, {
              signal: AbortSignal.timeout(500),
              redirect: 'error',
            });
            if (response.ok && (await response.text()) === 'OK')
              return { ...run, ready: true };
          } catch {
            /* Wait for the framework readiness probe to report registration. */
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          'Voice worker did not register with LiveKit within 30 seconds; inspect run diagnostics',
        );
      } catch (error) {
        if (this.runs.store.run(run.id)?.status === 'running')
          this.runs.cancel(run.id);
        throw error;
      }
    } finally {
      this.launching = false;
    }
  }
  async token(input: unknown) {
    const args = z
      .object({
        id: z.string().min(1).max(64),
        room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        identity: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      })
      .strict()
      .parse(input);
    const profile = this.get(args.id),
      secret = await this.connections.vault.get(profile.credentialRef);
    if (!secret)
      throw new Error('LiveKit credential is missing from the OS vault');
    const now = Math.floor(Date.now() / 1000),
      expires = now + 900;
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: profile.apiKey, sub: args.identity, nbf: now - 5, exp: expires, video: { roomJoin: true, room: args.room, canPublish: true, canSubscribe: true, canPublishData: true }, roomConfig: { agents: [{ agentName: profile.agentName }] } })}`;
    return {
      url: profile.url,
      room: args.room,
      identity: args.identity,
      expires,
      token: `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`,
    };
  }
  async localStart(input: unknown) {
    const args = z
      .object({
        engine: z.enum(['mlx', 'whisper.cpp']),
        model: z.string().min(1).max(500),
        executable: z.string().min(1).max(500).optional(),
      })
      .strict()
      .parse(input);
    const model = within(this.root, args.model);
    const executable = args.executable
      ? within(this.root, args.executable)
      : undefined;
    if (
      args.engine === 'mlx' &&
      (process.platform !== 'darwin' || !fs.statSync(model).isDirectory())
    )
      throw new Error(
        'MLX requires macOS and a workspace-local model directory',
      );
    if (
      args.engine === 'whisper.cpp' &&
      (!fs.statSync(model).isFile() ||
        !executable ||
        !fs.statSync(executable).isFile())
    )
      throw new Error(
        'Choose workspace-local whisper.cpp executable and model files',
      );
    if (
      this.localLaunching ||
      this.runs.store
        .runs()
        .some(
          (run) =>
            run.status === 'running' &&
            run.training?.parameters.workflow === 'local-speech',
        )
    )
      throw new Error('A local speech service is already running');
    this.localLaunching = true;
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const port = (probe.address() as net.AddressInfo).port;
          probe.close((error) => (error ? reject(error) : resolve(port)));
        });
      });
      const token = crypto.randomBytes(32).toString('hex');
      const run = await this.runs.start(
        'Local speech service',
        {
          target: 'local',
          framework: 'custom',
          parameters: {
            workflow: 'local-speech',
            engine: args.engine,
            model: args.model,
          },
          cursor: 0,
          connection: 'connected',
        },
        {
          AIIDE_LOCAL_SPEECH_TOKEN: token,
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
        {
          command: [
            'python',
            '-m',
            'aiide_voice',
            'local-speech',
            '--engine',
            args.engine,
            '--model',
            model,
            '--port',
            String(port),
            ...(executable ? ['--executable', executable] : []),
          ],
          lab: undefined,
        },
      );
      const url = `http://127.0.0.1:${port}`;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (this.runs.store.run(run.id)?.status !== 'running')
            throw new Error(
              'Local speech service failed; inspect its run diagnostics',
            );
          let ready = false;
          try {
            const response = await fetch(url + '/health', {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(300),
            });
            ready =
              response.ok && ((await response.json()) as any).ready === true;
          } catch {
            /* Wait for the managed process to bind its listener. */
          }
          if (ready) {
            if (this.runs.store.run(run.id)?.status !== 'running')
              throw new Error('Local speech service stopped during startup');
            const connection = await this.connections.save(
              {
                id: `local-speech-${run.id.slice(0, 12)}`,
                kind: 'model',
                url: url + '/v1',
                model: args.engine,
              },
              token,
            );
            const current = this.runs.store.run(run.id);
            if (!current || current.status !== 'running') {
              this.connections.remove(connection.id);
              throw new Error(
                'Local speech service stopped during connection registration',
              );
            }
            try {
              this.runs.store.saveRun({
                ...current,
                configuration: {
                  ...current.configuration,
                  localSpeech: {
                    connection: connection.id,
                    url: connection.url,
                    credentialRef: connection.credentialRef,
                  },
                },
              });
            } catch (error) {
              this.connections.remove(connection.id);
              throw error;
            }
            return { run, connection };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          'Local speech service did not become ready; inspect run diagnostics',
        );
      } catch (error) {
        if (this.runs.store.run(run.id)?.status === 'running')
          this.runs.cancel(run.id);
        throw error;
      }
    } finally {
      this.localLaunching = false;
    }
  }
}
