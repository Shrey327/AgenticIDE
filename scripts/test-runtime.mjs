// Optional integration gate: real containers/vector DB, deterministic model fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import core from '../packages/core/lib/index.js';
const { Workspace, hash } = core;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-runtime-'));
let workspace;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}');
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/embeddings')) {
    res.end(
      JSON.stringify({
        data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      }),
    );
  } else if (body.tools && !body.messages.some((m) => m.role === 'tool')) {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'edit',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      file: 'main.py',
                      text: 'print("agent edit")\n',
                    }),
                  },
                },
                {
                  id: 'test',
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({ command: 'python main.py' }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  } else {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Telemetry is stored locally. [knowledge.md]',
            },
          },
        ],
        usage: { total_tokens: 10, prompt_tokens: 6, completion_tokens: 4 },
      }),
    );
  }
});
try {
  fs.writeFileSync(
    path.join(root, 'knowledge.md'),
    'Telemetry is stored locally. Cloud accounts are optional.',
  );
  fs.writeFileSync(path.join(root, 'main.py'), 'print("host original")\n');
  fs.writeFileSync(path.join(root, '.env'), 'DO_NOT_STAGE=this-is-a-fixture\n');
  fs.writeFileSync(
    path.join(root, 'evaluation.jsonl'),
    JSON.stringify({ input: 'Where is telemetry?', expected: 'locally' }) +
      '\n',
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  workspace = await Workspace.open(root);
  const connection = await workspace.connections.save({
    id: 'fixture',
    kind: 'model',
    url: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'fixture',
    inputPrice: 1,
    outputPrice: 2,
  });
  // The fixture intentionally supplies known tool support; model probing has independent core tests.
  workspace.connections.write({
    ...connection,
    capabilities: {
      chat: true,
      tools: true,
      embeddings: true,
      streaming: false,
    },
  });
  const vector = await workspace.operation('qdrant.start');
  const args = {
    vector: vector.id,
    embedding: 'fixture',
    model: 'fixture',
    collection: 'test_documents',
  };
  const ingested = await workspace.operation('rag.ingest', {
    ...args,
    file: 'knowledge.md',
    size: 100,
    overlap: 10,
  });
  assert.equal(ingested.chunks, 1);
  const result = await workspace.operation('rag.query', {
    ...args,
    query: 'Where is telemetry?',
  });
  assert.equal(result.points[0].payload.source, 'knowledge.md');
  assert.match(result.answer, /locally/);
  assert.equal(workspace.store.spans(result.runId).total, 3);
  assert.ok(
    workspace.store
      .summary(result.runId)
      .metrics.some((m) => m.name === 'estimated_cost_usd'),
  );
  const evaluated = await workspace.operation('evaluations.rag', {
    ...args,
    dataset: 'evaluation.jsonl',
  });
  assert.equal(evaluated.passed, 1);
  const chat = await workspace.operation('assistant.start', {
    model: 'fixture',
    prompt: 'Edit main.py and run it',
    autonomous: true,
  });
  const deadline = Date.now() + 30000;
  while (
    workspace.assistant.status(chat.id).status === 'running' &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(workspace.assistant.status(chat.id).status, 'completed');
  assert.equal(workspace.assistant.status(chat.id).actions.length, 2);
  assert.equal(
    fs.readFileSync(path.join(root, 'main.py'), 'utf8'),
    'print("host original")\n',
  );
  const isolation = await workspace.sandbox.run(
    chat.session,
    `python - <<'PY'
import os, socket
assert os.getuid() != 0
assert not os.path.exists('/var/run/docker.sock')
assert not os.path.exists('/workspace/.env')
assert not os.path.exists(${JSON.stringify(root)})
assert 'DO_NOT_STAGE' not in os.environ
try:
    open('/root-filesystem-must-be-read-only', 'w')
except OSError:
    pass
else:
    raise AssertionError('Root filesystem must be read-only')
try:
    socket.create_connection(('1.1.1.1', 443), timeout=1)
except OSError:
    pass
else:
    raise AssertionError('Network must be disabled')
print('isolation passed')
PY`,
  );
  assert.equal(isolation.exitCode, 0, isolation.output);
  const pendingCommand = workspace.sandbox.run(
    chat.session,
    'python -c "import time; time.sleep(120)"',
  );
  const startedDeadline = Date.now() + 10000;
  let running = false;
  while (!running && Date.now() < startedDeadline) {
    try {
      running =
        execFileSync(
          'docker',
          [
            'inspect',
            '--format',
            '{{.State.Running}}',
            'aiide-' + chat.session,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim() === 'true';
    } catch {}
    if (!running) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(running, true);
  await workspace.sandbox.cancel(chat.session);
  assert.notEqual((await pendingCommand).exitCode, 0);
  const diff = workspace.sandbox.diff(chat.session);
  workspace.sandbox.apply(chat.session, hash(JSON.stringify(diff)));
  assert.equal(
    fs.readFileSync(path.join(root, 'main.py'), 'utf8'),
    'print("agent edit")\n',
  );
  console.log(
    'PASS: real Qdrant ingestion/retrieval/evaluation and isolated coding-agent edit/execute/cancel/review/apply',
  );
} finally {
  if (workspace) {
    await workspace.operation('qdrant.stop').catch(() => {});
    await workspace.close();
    const name = 'aiide-qdrant-' + hash(fs.realpathSync(root)).slice(0, 12);
    try {
      execFileSync('docker', ['rm', name], { stdio: 'ignore' });
    } catch {}
  }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
