import React from '@theia/core/shared/react';
import type { Run, EventRecord } from '../common/protocol.js';
import { Call, Perform, Heading, Empty, time } from './shared.js';
import { MetricChart } from './metric-chart.js';
import { CustomRLPanel } from './custom-rl-panel.js';

type AdvancedConfig = {
  algorithm: 'ppo' | 'sac';
  environment: string;
  timesteps: number;
  workers: number;
  seeds: number[];
  evalEpisodes: number;
  maxSteps: number;
  learningRate: number;
  resume: string | null;
};

type Config = {
  environment: 'gridworld' | 'FrozenLake-v1';
  size: number;
  episodes: number;
  maxSteps: number;
  learningRate: number;
  discount: number;
  epsilon: number;
  slip: number;
  seed: number;
  evalEpisodes: number;
};
type Policy = {
  path: string;
  format?: string;
  status?: string;
  checkpoints?: { seed: number; timesteps: number }[];
  created: number;
  config: Config | AdvancedConfig;
  baseline: { meanReward: number; successRate: number } | null;
  evaluation: {
    meanReward: number;
    successRate: number;
    meanSteps: number;
    stdReward?: number;
  } | null;
};
type Rollout = {
  size?: number;
  goal: number;
  states?: number[];
  observations?: number[][];
  observationNames?: string[];
  environment?: string;
  actions: (number | number[])[];
  actionNames: string[];
  rewards: number[];
  holes: number[];
  success: boolean;
  reward: number;
  steps: number;
};
const initial: Config = {
  environment: 'gridworld',
  size: 5,
  episodes: 1500,
  maxSteps: 100,
  learningRate: 0.2,
  discount: 0.95,
  epsilon: 0.3,
  slip: 0.1,
  seed: 42,
  evalEpisodes: 100,
};

export function RLPanel({
  runs,
  call,
  perform,
  refresh,
  openTrace,
}: {
  runs: Run[];
  call: Call;
  perform: Perform;
  refresh: () => Promise<void>;
  openTrace: (id: string) => void;
}) {
  const [config, setConfig] = React.useState(initial);
  const [algorithm, setAlgorithm] = React.useState('q-learning');
  const [advanced, setAdvanced] = React.useState<AdvancedConfig>({
    algorithm: 'ppo',
    environment: 'CartPole-v1',
    timesteps: 10000,
    workers: 1,
    seeds: [42],
    evalEpisodes: 10,
    maxSteps: 500,
    learningRate: 0.0003,
    resume: null,
  });
  const [seeds, setSeeds] = React.useState('42');
  const [readiness, setReadiness] = React.useState<any>();
  const [policies, setPolicies] = React.useState<Policy[]>([]);
  const [selected, setSelected] = React.useState('');
  const [events, setEvents] = React.useState<EventRecord[]>([]);
  const [policy, setPolicy] = React.useState('');
  const [seed, setSeed] = React.useState(12345);
  const [rollout, setRollout] = React.useState<Rollout>();
  const [step, setStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [environments, setEnvironments] = React.useState<any[]>([]);
  const loadEnvironments = async () => {
    const values = await call('rl.environments');
    setEnvironments(Array.isArray(values) ? values : []);
  };
  const jobs = runs.filter((r) => r.training?.parameters.workflow === 'rl');
  const active = jobs.find((r) => r.id === selected) || jobs[0];
  const request = React.useRef(0);
  const check = () =>
    perform(async () => setReadiness(await call('rl.status')));
  React.useEffect(() => {
    void check();
    void perform(loadEnvironments);
  }, [call]);
  React.useEffect(() => {
    const current = ++request.current;
    void perform(async () => {
      const [nextPolicies, nextEvents] = await Promise.all([
        call('rl.policies'),
        active
          ? call('training.metrics', { id: active.id })
          : Promise.resolve([]),
      ]);
      if (request.current !== current) return;
      setPolicies(nextPolicies);
      setEvents(nextEvents);
    });
    return () => {
      request.current++;
    };
  }, [call, runs, active?.id]);
  const update = (name: keyof Config, value: number) =>
    setConfig((old) => ({ ...old, [name]: value }));
  const field = (
    key: keyof Omit<Config, 'environment'>,
    label: string,
    min: number,
    max: number,
    increment = 1,
  ) => (
    <label key={key}>
      {label}
      <input
        type="number"
        value={config[key]}
        min={min}
        max={max}
        step={increment}
        disabled={
          busy ||
          (config.environment !== 'gridworld' && ['size', 'slip'].includes(key))
        }
        onChange={(e) => update(key, Number(e.target.value))}
      />
    </label>
  );
  const run = () =>
    perform(async () => {
      setBusy(true);
      try {
        const started = await call(
          'rl.train',
          algorithm === 'q-learning'
            ? config
            : {
                ...advanced,
                seeds: seeds.split(',').map((value) => Number(value.trim())),
              },
        );
        setSelected(started.id);
        setEvents([]);
        await refresh();
      } finally {
        setBusy(false);
      }
    });
  const rewards = events.filter(
    (e) => e.kind === 'metric' && e.name === 'rl.episode_reward',
  );
  const chosenPolicy = policies.find((p) => p.path === policy);
  return (
    <>
      <Heading
        title="RL environments"
        text="Train tabular or neural policies, compare held-out rewards with random actions, and inspect saved checkpoints and rollouts."
      />
      <section className="aiide-card">
        <h3>Environment & training</h3>
        <p>
          GridWorld runs with Python alone. Gymnasium FrozenLake uses its
          standard slippery 4×4 map; install gymnasium in this project's
          environment before choosing it.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <label>
            Algorithm
            <select
              value={algorithm}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setAlgorithm(value);
                if (value !== 'q-learning')
                  setAdvanced((old) => ({
                    ...old,
                    algorithm: value as 'ppo' | 'sac',
                    environment:
                      value === 'sac' ? 'Pendulum-v1' : 'CartPole-v1',
                    resume: null,
                  }));
              }}
            >
              <option value="q-learning">Tabular Q-learning</option>
              <option value="ppo">PPO · discrete or continuous control</option>
              <option value="sac">SAC · continuous control</option>
            </select>
          </label>
          {algorithm !== 'q-learning' && (
            <>
              <p role="status">
                {readiness?.available
                  ? 'Stable-Baselines3 ready · CPU training'
                  : 'Install advanced dependencies in this project environment first.'}
              </p>
              {!readiness?.available && (
                <p>
                  {readiness?.setup ||
                    'RL template: uv sync --extra advanced --locked'}
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void check()}
              >
                Recheck RL dependencies
              </button>
              <div className="aiide-form-grid">
                <label>
                  Neural environment
                  <select
                    value={advanced.environment}
                    disabled={busy}
                    onChange={(event) =>
                      setAdvanced((old) => ({
                        ...old,
                        environment: event.target
                          .value as AdvancedConfig['environment'],
                        resume: null,
                      }))
                    }
                  >
                    {algorithm === 'ppo' && (
                      <option value="CartPole-v1">
                        CartPole-v1 · discrete actions
                      </option>
                    )}
                    <option value="Pendulum-v1">
                      Pendulum-v1 · continuous actions
                    </option>
                    {environments.map((environment) => (
                      <option
                        key={environment.id}
                        value={'custom:' + environment.id}
                        disabled={!environment.ready}
                      >
                        {environment.title} ·{' '}
                        {environment.ready
                          ? 'reviewed custom factory'
                          : 'source review required'}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Training steps per seed
                  <input
                    type="number"
                    min={64}
                    max={2000000}
                    value={advanced.timesteps}
                    disabled={busy}
                    onChange={(event) =>
                      setAdvanced((old) => ({
                        ...old,
                        timesteps: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  Parallel environments
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={advanced.workers}
                    disabled={busy}
                    onChange={(event) =>
                      setAdvanced((old) => ({
                        ...old,
                        workers: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  Training seeds, comma separated
                  <input
                    value={seeds}
                    disabled={busy}
                    onChange={(event) => setSeeds(event.target.value)}
                  />
                </label>
                <label>
                  Held-out episodes per seed
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={advanced.evalEpisodes}
                    disabled={busy}
                    onChange={(event) =>
                      setAdvanced((old) => ({
                        ...old,
                        evalEpisodes: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  Neural episode step limit
                  <input
                    type="number"
                    min={10}
                    max={500}
                    value={advanced.maxSteps}
                    disabled={busy}
                    onChange={(event) =>
                      setAdvanced((old) => ({
                        ...old,
                        maxSteps: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  Neural learning rate
                  <input
                    type="number"
                    min={0.000001}
                    max={0.01}
                    step={0.000001}
                    value={advanced.learningRate}
                    disabled={busy}
                    onChange={(event) =>
                      setAdvanced((old) => ({
                        ...old,
                        learningRate: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  Resume neural checkpoint
                  <select
                    value={advanced.resume || ''}
                    disabled={busy}
                    onChange={(event) =>
                      setAdvanced((old) => ({
                        ...old,
                        resume: event.target.value || null,
                      }))
                    }
                  >
                    <option value="">Start a fresh policy</option>
                    {policies
                      .filter(
                        (policy) =>
                          policy.format === 'aiide-sb3-v1' &&
                          'algorithm' in policy.config &&
                          policy.config.algorithm === algorithm &&
                          policy.config.environment === advanced.environment &&
                          policy.checkpoints?.length,
                      )
                      .map((policy) => (
                        <option value={policy.path} key={policy.path}>
                          {policy.path} · {policy.status}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <p>
                Each training seed is evaluated in separate held-out
                environments against the same random-action baseline. Multiple
                workers use spawned processes. Checkpoints preserve weights,
                optimizer and SAC replay data; resumed runs require matching
                environment, workers, seeds and learning rate. Returns describe
                these environments, not general task competence.
              </p>
            </>
          )}
          {algorithm === 'q-learning' && (
            <>
              <div className="aiide-form-grid">
                <label>
                  Environment
                  <select
                    value={config.environment}
                    disabled={busy}
                    onChange={(e) =>
                      setConfig((old) => ({
                        ...old,
                        environment: e.target.value as Config['environment'],
                      }))
                    }
                  >
                    <option value="gridworld">Built-in GridWorld</option>
                    <option value="FrozenLake-v1">
                      Gymnasium FrozenLake-v1
                    </option>
                  </select>
                </label>
                {field('episodes', 'Training episodes', 1, 20000)}
                {field('seed', 'Training seed', 0, 2147483647)}
                {field('maxSteps', 'Steps per episode', 5, 500)}
              </div>
              <details>
                <summary>Learning parameters</summary>
                <div className="aiide-form-grid">
                  {field('size', 'GridWorld side length', 3, 12)}
                  {field(
                    'slip',
                    'GridWorld action slip probability',
                    0,
                    0.5,
                    0.01,
                  )}
                  {field('learningRate', 'Learning rate', 0.001, 1, 0.001)}
                  {field('discount', 'Discount factor', 0, 0.999, 0.001)}
                  {field(
                    'epsilon',
                    'Initial exploration probability',
                    0.01,
                    1,
                    0.01,
                  )}
                  {field('evalEpisodes', 'Evaluation episodes', 1, 500)}
                </div>
              </details>
              <p>
                Evaluation uses independent seeds and frozen weights. GridWorld
                rewards reaching the goal (+1) and charges −0.02 per other step.
                FrozenLake uses its own sparse rewards and terminal holes.
              </p>
            </>
          )}
          <button
            type="submit"
            disabled={
              busy ||
              (algorithm === 'q-learning'
                ? config.episodes * config.maxSteps > 2000000
                : !readiness?.available)
            }
          >
            Train policy
          </button>
          {algorithm === 'q-learning' &&
            config.episodes * config.maxSteps > 2000000 && (
              <p role="alert">Limit training to two million steps.</p>
            )}
        </form>
      </section>
      <CustomRLPanel
        call={call}
        perform={perform}
        busy={busy}
        setBusy={setBusy}
        registered={loadEnvironments}
      />
      {environments
        .filter((environment) => !environment.ready)
        .map((environment) => (
          <p role="alert" key={environment.id}>
            {environment.id}: {environment.error}
          </p>
        ))}
      <section className="aiide-card">
        <h3>Recorded experiments</h3>
        {!jobs.length ? (
          <Empty>
            Train a policy to see episode rewards, logs, and traces.
          </Empty>
        ) : (
          <>
            <label>
              Experiment
              <select
                value={active?.id || ''}
                onChange={(e) => setSelected(e.target.value)}
              >
                {jobs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {time(r.started)} · {r.status}
                  </option>
                ))}
              </select>
            </label>
            <p role="status">
              {active?.status} ·{' '}
              {rewards.length
                ? `latest recorded reward ${Number(rewards.at(-1)?.value).toFixed(3)}`
                : 'Waiting for recorded metrics'}
            </p>
            <div className="aiide-sweep-chart">
              <small>Sampled training episode rewards</small>
              <MetricChart values={rewards} />
            </div>
            <button onClick={() => active && openTrace(active.id)}>
              Trace & logs
            </button>
            {active?.status === 'running' && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await call('runs.cancel', { id: active.id });
                    await refresh();
                  })
                }
              >
                Cancel training
              </button>
            )}
          </>
        )}
      </section>
      <section className="aiide-card">
        <h3>Saved policies & held-out evaluation</h3>
        {!policies.length ? (
          <Empty>
            Completed training saves a portable JSON Q table under rl-policies/.
          </Empty>
        ) : (
          <>
            <div className="aiide-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Environment / seed</th>
                    <th>Policy success</th>
                    <th>Random success</th>
                    <th>Policy reward</th>
                    <th>Random reward</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr key={p.path}>
                      <td>
                        {p.config.environment} /{' '}
                        {'seeds' in p.config
                          ? p.config.seeds.join(', ')
                          : p.config.seed}
                        <br />
                        <small>
                          {p.path} {p.status || ''}
                        </small>
                      </td>
                      <td>
                        {p.evaluation &&
                        p.config.environment !== 'Pendulum-v1' &&
                        !p.config.environment.startsWith('custom:')
                          ? (100 * p.evaluation.successRate).toFixed(1) + '%'
                          : '—'}
                      </td>
                      <td>
                        {p.baseline &&
                        p.config.environment !== 'Pendulum-v1' &&
                        !p.config.environment.startsWith('custom:')
                          ? (100 * p.baseline.successRate).toFixed(1) + '%'
                          : '—'}
                      </td>
                      <td>
                        {p.evaluation?.meanReward.toFixed(3) || 'Pending'}
                        {p.evaluation?.stdReward !== undefined &&
                          'seeds' in p.config &&
                          p.config.seeds.length > 1 && (
                            <small>
                              <br />
                              SD across training-seed means:{' '}
                              {p.evaluation.stdReward.toFixed(3)}
                            </small>
                          )}
                      </td>
                      <td>{p.baseline?.meanReward.toFixed(3) || 'Pending'}</td>
                      <td>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setPolicy(p.path);
                            setRollout(undefined);
                          }}
                        >
                          Inspect policy
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label>
              Policy
              <select
                value={policy}
                disabled={busy}
                onChange={(e) => {
                  setPolicy(e.target.value);
                  setRollout(undefined);
                }}
              >
                <option value="">Choose a policy</option>
                {policies.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.config.environment} ·{' '}
                    {'seeds' in p.config
                      ? p.config.seeds.join(', ')
                      : p.config.seed}{' '}
                    · {p.path}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Rollout seed
              <input
                type="number"
                min={0}
                max={2147483647}
                step={1}
                value={seed}
                disabled={busy}
                onChange={(e) => setSeed(Number(e.target.value))}
              />
            </label>
            <button
              disabled={!chosenPolicy || busy}
              onClick={() =>
                void perform(async () => {
                  setBusy(true);
                  try {
                    setRollout(await call('rl.rollout', { policy, seed }));
                    setStep(0);
                  } finally {
                    setBusy(false);
                  }
                })
              }
            >
              Run policy
            </button>
            {rollout && (
              <>
                <p role="status">
                  {rollout.environment?.startsWith('custom:')
                    ? 'Custom environment rollout'
                    : rollout.environment === 'Pendulum-v1'
                      ? 'Continuous-control rollout'
                      : rollout.success
                        ? 'Goal reached'
                        : 'Episode ended without reaching the goal'}{' '}
                  · reward {rollout.reward.toFixed(3)} · {rollout.steps} steps
                </p>
                <label>
                  Inspect step {step} of {rollout.steps}
                  <input
                    type="range"
                    min={0}
                    max={rollout.steps}
                    value={step}
                    onChange={(e) => setStep(Number(e.target.value))}
                  />
                </label>
                {rollout.states && rollout.size && (
                  <div
                    role="img"
                    className="aiide-rl-grid"
                    style={{
                      gridTemplateColumns: `repeat(${rollout.size}, 1fr)`,
                    }}
                    aria-label={`Policy rollout at step ${step}; agent at row ${Math.floor(rollout.states[step] / rollout.size) + 1}, column ${(rollout.states[step] % rollout.size) + 1}`}
                  >
                    {Array.from({ length: rollout.size ** 2 }, (_, cell) => {
                      const state =
                        cell === rollout.states![step]
                          ? 'agent'
                          : cell === rollout.goal
                            ? 'goal'
                            : rollout.holes.includes(cell)
                              ? 'hole'
                              : 'empty';
                      return (
                        <span key={cell} data-state={state} aria-hidden="true">
                          {state === 'agent'
                            ? 'A'
                            : state === 'goal'
                              ? 'G'
                              : state === 'hole'
                                ? 'H'
                                : '·'}
                        </span>
                      );
                    })}
                  </div>
                )}
                {rollout.observations && (
                  <>
                    <ControlState rollout={rollout} step={step} />
                    <dl>
                      {rollout.observations[step].map((value, index) => (
                        <React.Fragment key={index}>
                          <dt>{rollout.observationNames?.[index]}</dt>
                          <dd>{value.toFixed(4)}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                    <p>
                      Previous action:{' '}
                      {step
                        ? JSON.stringify(rollout.actions[step - 1])
                        : 'initial observation'}
                      . Reward:{' '}
                      {step ? rollout.rewards[step - 1].toFixed(3) : '—'}.
                    </p>
                  </>
                )}
                {rollout.states && (
                  <p>
                    A = agent · G = goal · H = hole.{' '}
                    {step > 0
                      ? `Previous action: ${rollout.actionNames[Number(rollout.actions[step - 1])]}; reward: ${rollout.rewards[step - 1]}.`
                      : 'Initial observation.'}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}

function ControlState({ rollout, step }: { rollout: Rollout; step: number }) {
  if (rollout.environment?.startsWith('custom:')) return null;
  const observation = rollout.observations![step];
  const pendulum = rollout.environment === 'Pendulum-v1';
  const pivotX = pendulum
    ? 150
    : Math.max(35, Math.min(265, 150 + observation[0] * 30));
  const pivotY = pendulum ? 85 : 130;
  const angle = pendulum
    ? Math.atan2(observation[1], observation[0])
    : observation[2];
  return (
    <svg
      viewBox="0 0 300 180"
      style={{ maxWidth: 400 }}
      role="img"
      aria-label={`Policy rollout at step ${step}; ${rollout.environment}; angle ${angle.toFixed(3)} radians`}
    >
      {!pendulum && (
        <>
          <path d="M10 150H290" stroke="currentColor" />
          <rect
            x={pivotX - 20}
            y={130}
            width="40"
            height="18"
            fill="var(--aiide-accent)"
          />
        </>
      )}
      <line
        x1={pivotX}
        y1={pivotY}
        x2={pivotX + Math.sin(angle) * 70}
        y2={pivotY - Math.cos(angle) * 70}
        stroke="currentColor"
        strokeWidth={5}
      />
      <circle cx={pivotX} cy={pivotY} r={5} fill="var(--aiide-accent)" />
    </svg>
  );
}
