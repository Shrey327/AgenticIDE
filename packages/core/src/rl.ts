import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Runs } from './runs';
import { loadProject } from './project';
import { within } from './security';
import { subprocess } from './ssh';
import { RLEnvironments, customEnvironmentSchema } from './rl-environments';

const schema = z
  .object({
    environment: z.enum(['gridworld', 'FrozenLake-v1']).default('gridworld'),
    size: z.number().int().min(3).max(12).default(5),
    episodes: z.number().int().min(1).max(20000).default(1500),
    maxSteps: z.number().int().min(5).max(500).default(100),
    learningRate: z.number().min(0.001).max(1).default(0.2),
    discount: z.number().min(0).max(0.999).default(0.95),
    epsilon: z.number().min(0.01).max(1).default(0.3),
    slip: z.number().min(0).max(0.5).default(0.1),
    seed: z.number().int().min(0).max(2147483647).default(42),
    evalEpisodes: z.number().int().min(1).max(500).default(100),
  })
  .strict()
  .refine((c) => c.episodes * c.maxSteps <= 2000000, {
    message: 'Limit training to two million steps',
  });
const policyPath = z.string().regex(/^rl-policies\/[A-Za-z0-9_-]{1,100}$/);
const advancedSchema = z
  .object({
    algorithm: z.enum(['ppo', 'sac']),
    environment: z.union([
      z.enum(['CartPole-v1', 'Pendulum-v1']),
      z.string().regex(/^custom:[a-z][a-z0-9_-]{0,39}$/),
    ]),
    customEnvironment: customEnvironmentSchema.nullish(),
    timesteps: z.number().int().min(64).max(2000000).default(10000),
    workers: z.number().int().min(1).max(4).default(1),
    seeds: z
      .array(z.number().int().min(0).max(2147480000))
      .min(1)
      .max(4)
      .default([42]),
    evalEpisodes: z.number().int().min(1).max(100).default(10),
    maxSteps: z.number().int().min(10).max(500).default(500),
    learningRate: z.number().min(0.000001).max(0.01).default(0.0003),
    resume: policyPath.nullable().default(null),
  })
  .strict()
  .superRefine((c, context) => {
    if (c.algorithm === 'sac' && c.environment === 'CartPole-v1')
      context.addIssue({
        code: 'custom',
        message: 'SAC requires continuous actions: choose Pendulum-v1',
      });
    if (new Set(c.seeds).size !== c.seeds.length)
      context.addIssue({
        code: 'custom',
        message: 'Choose distinct training seeds',
      });
    const batch = c.algorithm === 'ppo' ? 64 * c.workers : c.workers;
    if (Math.ceil(c.timesteps / batch) * batch * c.seeds.length > 2000000)
      context.addIssue({
        code: 'custom',
        message: 'Limit all seeds together to two million training steps',
      });
  });

/** Small local RL experiments, recorded using the existing run lifecycle. */
export class ReinforcementLearning {
  readonly custom: RLEnvironments;
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly requests = new Set<Promise<unknown>>();
  constructor(
    readonly root: string,
    readonly runs: Runs,
    readonly assets: string,
  ) {
    this.custom = new RLEnvironments(root);
  }
  environments() {
    return this.custom.list();
  }
  previewEnvironment(input: unknown) {
    return this.custom.preview(input);
  }
  registerEnvironment(input: unknown) {
    if (this.closed) throw new Error('RL service is closed');
    return this.custom.register(input);
  }
  checkEnvironment(input: unknown) {
    const { id } = z.object({ id: z.string() }).strict().parse(input);
    return this.call('check-environment', {
      customEnvironment: this.custom.get(id),
    });
  }
  catalog() {
    return {
      environments: [
        {
          id: 'gridworld',
          name: 'Built-in GridWorld',
          dependency: 'Python standard library',
        },
        {
          id: 'FrozenLake-v1',
          name: 'Gymnasium FrozenLake (4×4, slippery)',
          description:
            'Fixed start at 0, goal at 15, terminal holes; actions left/down/right/up, rewards +1 at goal and 0 otherwise.',
          dependency: 'gymnasium in the project environment',
        },
      ],
      algorithm: 'q-learning',
      advanced: {
        algorithms: ['ppo', 'sac'],
        environments: ['CartPole-v1', 'Pendulum-v1'],
        defaults: advancedSchema.parse({
          algorithm: 'ppo',
          environment: 'CartPole-v1',
        }),
        setup:
          'RL template: uv sync --extra advanced --locked; existing projects install stable-baselines3==2.7.1 gymnasium==1.2.2 torch==2.10.0 using their existing package manager.',
        checkpoints:
          'Tensor-only loading of built-in architectures; cloudpickle checkpoint metadata is never executed.',
        customEnvironments:
          'The desktop can review/register workspace Python factories, check their Gymnasium contract and train PPO/SAC. Custom factories execute trusted local code and cannot be launched through external MCP workflows.',
      },
      description:
        'GridWorld: reach the bottom-right goal from randomized starts. Actions: up, right, down, left. Goal reward +1; other steps -0.02. Slip replaces an action at random.',
      defaults: schema.parse({}),
      limits: {
        size: [3, 12],
        episodes: [1, 20000],
        maxSteps: [5, 500],
        maxTotalSteps: 2000000,
      },
    };
  }
  train(input: unknown, allowCustom = true) {
    if (this.closed) throw new Error('RL service is closed');
    const config =
      input &&
      typeof input === 'object' &&
      'algorithm' in input &&
      ['ppo', 'sac'].includes(String(input.algorithm))
        ? advancedSchema.parse(input)
        : schema.parse(input);
    if (input && typeof input === 'object' && 'customEnvironment' in input)
      throw new Error(
        'Custom environment descriptors come only from reviewed registrations',
      );
    if (!allowCustom && config.environment.startsWith('custom:'))
      throw new Error(
        'Custom environments must be launched explicitly from the IDE RL page',
      );
    if ('algorithm' in config && config.environment.startsWith('custom:'))
      config.customEnvironment = this.custom.get(config.environment.slice(7));
    if ('resume' in config && config.resume) {
      const file = within(this.root, `${config.resume}/policy.json`);
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1000000)
        throw new Error('Choose regular neural policy metadata below 1 MB');
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        JSON.stringify(previous.config?.customEnvironment ?? null) !==
        JSON.stringify(
          ('customEnvironment' in config
            ? config.customEnvironment
            : undefined) ?? null,
        )
      )
        throw new Error(
          'Resume requires the same reviewed custom environment sources and parameters',
        );
    }
    const output = `rl-policies/${crypto.randomUUID()}`;
    within(this.root, `${output}/policy.json`, true);
    return this.runs.start(
      `RL · ${config.environment}`,
      {
        target: 'local',
        framework: 'custom',
        parameters: { workflow: 'rl', ...config, output },
        cursor: 0,
        connection: 'connected',
      },
      { AIIDE_RL_CONFIG: JSON.stringify(config), AIIDE_RL_OUTPUT: output },
      {
        command: ['python', '-m', 'aiide_rl', 'train'],
        lab: undefined,
      },
    );
  }
  policies() {
    const directory = within(this.root, 'rl-policies', true);
    if (!fs.existsSync(directory)) return [];
    const policies: Record<string, any>[] = [];
    // shortcut: show at most 300 local policies; add pagination for larger archives.
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (policies.length >= 300) break;
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.name))
        continue;
      try {
        const relative = `rl-policies/${entry.name}`;
        const file = within(this.root, `${relative}/policy.json`);
        const info = fs.statSync(file);
        if (!info.isFile() || info.size > 1000000) continue;
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        const summary = z.object({
          meanReward: z.number().finite(),
          successRate: z.number().min(0).max(1),
          meanSteps: z.number().min(1).max(500),
          episodes: z.number().int().min(1).max(500),
          stdReward: z.number().finite().optional(),
        });
        if (value.format === 'aiide-sb3-v1') {
          const config = advancedSchema.parse(value.config);
          if (
            value.environment !== config.environment ||
            value.algorithm !== config.algorithm ||
            !Number.isFinite(value.created)
          )
            continue;
          policies.push({
            path: relative,
            format: value.format,
            created: value.created,
            config,
            status: value.status,
            baseline: value.baseline ? summary.parse(value.baseline) : null,
            evaluation: value.evaluation
              ? summary.parse(value.evaluation)
              : null,
            results: z
              .array(
                z.object({
                  seed: z.number().int(),
                  baseline: summary,
                  evaluation: summary,
                }),
              )
              .max(4)
              .parse(value.results),
            checkpoints: z
              .array(
                z.object({
                  seed: z.number().int(),
                  timesteps: z.number().int().min(0).max(100000000),
                }),
              )
              .max(4)
              .parse(value.models),
          });
          continue;
        }
        if (
          value.format !== 'aiide-rl-v1' ||
          !['gridworld', 'FrozenLake-v1'].includes(value.environment) ||
          !Number.isFinite(value.created)
        )
          continue;
        const config = schema.parse(value.config);
        if (value.environment !== config.environment) continue;
        policies.push({
          path: relative,
          created: value.created,
          config,
          baseline: summary.parse(value.baseline),
          evaluation: summary.parse(value.evaluation),
        });
      } catch {
        // In-progress or user-edited files cannot prevent listing intact policies.
      }
    }
    return policies.sort((a, b) => b.created - a.created);
  }
  status() {
    return this.call('status', {});
  }
  private call(mode: string, request: Record<string, unknown>) {
    if (this.closed) return Promise.reject(new Error('RL service is closed'));
    const python = loadProject(this.root).environment.python;
    const controller = new AbortController();
    this.controllers.add(controller);
    const operation = subprocess(
      python.includes('/') ? path.resolve(this.root, python) : python,
      [
        '-I',
        path.join(this.assets, 'python', 'aiide_runtime', 'launch.py'),
        'aiide_rl',
        mode,
      ],
      { ...request, root: this.root },
      30000,
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONPATH: path.join(this.assets, 'python'),
        PYTHONNOUSERSITE: '1',
      } as NodeJS.ProcessEnv,
      controller.signal,
    );
    this.requests.add(operation);
    void operation
      .finally(() => {
        this.controllers.delete(controller);
        this.requests.delete(operation);
      })
      .catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.requests]);
  }
  rollout(input: unknown, allowCustom = true) {
    const args = z
      .object({
        policy: policyPath,
        seed: z.number().int().min(0).max(2147483647).default(12345),
      })
      .strict()
      .parse(input);
    const file = within(this.root, `${args.policy}/policy.json`);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1000000)
      throw new Error('Choose a regular policy JSON file under 1 MB');
    const customEnvironment = this.reviewedPolicyEnvironment(file, allowCustom);
    return this.call('rollout', {
      file,
      seed: args.seed,
      allowCustom,
      ...(customEnvironment ? { customEnvironment } : {}),
    });
  }
  private reviewedPolicyEnvironment(file: string, allowCustom: boolean) {
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !allowCustom &&
      (String(policy.config?.environment).startsWith('custom:') ||
        policy.config?.customEnvironment != null)
    )
      throw new Error(
        'Custom environments must be launched explicitly from the IDE RL page',
      );
    if (!String(policy.config?.environment).startsWith('custom:'))
      return undefined;
    const definition = this.custom.get(
      String(policy.config.environment).slice(7),
    );
    if (
      JSON.stringify(policy.config.customEnvironment) !==
      JSON.stringify(definition)
    )
      throw new Error(
        'Policy custom environment differs from the current reviewed registration',
      );
    return definition;
  }
  isCustomPolicy(relative: string) {
    const file = within(this.root, `${policyPath.parse(relative)}/policy.json`);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1000000)
      throw new Error('Choose regular policy metadata below 1 MB');
    return String(
      JSON.parse(fs.readFileSync(file, 'utf8')).config?.environment,
    ).startsWith('custom:');
  }
}
