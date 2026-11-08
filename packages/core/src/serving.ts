import net from 'node:net';
import { z } from 'zod';
import { Runs } from './runs';
import { Connections } from './models';
import { HuggingFace, modelPath, device } from './huggingface';
import { Run } from './types';

export const engineIds = ['transformers', 'vllm', 'sglang', 'mlx'] as const;
const startSchema = z.object({
  model: modelPath,
  engine: z.enum(engineIds).default('transformers'),
  device,
});
type Serving = {
  engine: string;
  model: string;
  repo?: string;
  port: number;
  connection?: string;
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

/** Serves Hub/fine-tuned models through an OpenAI-compatible engine and registers each as a model connection. */
export class Servers {
  constructor(
    readonly runs: Runs,
    readonly connections: Connections,
    readonly huggingface: HuggingFace,
  ) {}
  async start(input: unknown) {
    const config = startSchema.parse(input);
    this.huggingface.model(config.model);
    const meta = this.huggingface
      .models()
      .find((model) => model.path === config.model);
    const port = await freePort();
    const name = `ft-${config.model.slice(10, 18)}`;
    const run = await this.runs.start(
      `serve ${config.engine} · ${meta?.repo || config.model}${meta?.kind === 'adapter' ? ' (LoRA)' : ''}`,
      undefined,
      {
        AIIDE_HF_CONFIG: JSON.stringify({ ...config, port, name }),
        HF_HUB_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
      },
      { command: ['python', '-m', 'aiide_hf', 'serve'], lab: undefined },
    );
    const serving: Serving = {
      engine: config.engine,
      model: config.model,
      repo: meta?.repo,
      port,
    };
    const recorded = {
      ...run,
      configuration: { ...run.configuration, serving },
    };
    this.runs.store.saveRun(recorded);
    return recorded;
  }
  /** Lists servers; a running server becomes a connection the first time its /v1/models answers. */
  async list() {
    const servers = this.runs.store
      .runs()
      .filter((run) => run.configuration?.serving)
      .slice(0, 20);
    return Promise.all(
      servers.map(async (run) => {
        const serving = run.configuration.serving as Serving;
        if (run.status === 'running' && !serving.connection)
          await this.register(run, serving).catch(() => undefined);
        // A stopped server's port is dead; drop its connection so it is not offered as a target.
        if (
          run.status !== 'running' &&
          serving.connection?.startsWith('serve-')
        ) {
          this.connections.remove(serving.connection);
          delete serving.connection;
          this.runs.store.saveRun(run);
        }
        return {
          runId: run.id,
          name: run.name,
          ...serving,
          url: `http://127.0.0.1:${serving.port}/v1`,
          state:
            run.status !== 'running'
              ? run.status
              : serving.connection
                ? 'ready'
                : 'starting',
          started: run.started,
        };
      }),
    );
  }
  private async register(run: Run, serving: Serving) {
    const url = `http://127.0.0.1:${serving.port}/v1`;
    const response = await fetch(`${url}/models`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    if (!response.ok) return;
    const body: any = await response.json();
    // mlx_lm.server loads whatever path "model" names; "default_model" is the one it started with.
    const model =
      serving.engine === 'mlx' ? 'default_model' : body.data?.[0]?.id;
    if (typeof model !== 'string') return;
    const id = `serve-${serving.engine}-${run.id.slice(0, 6)}`;
    await this.connections.save({ id, kind: 'model', url, model });
    serving.connection = id;
    const latest = this.runs.store.run(run.id);
    if (latest)
      this.runs.store.saveRun({
        ...latest,
        configuration: { ...latest.configuration, serving },
      });
  }
}
