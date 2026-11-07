import http from 'node:http';
export async function wandbFixture() {
  const operations = [];
  let rejectAuth = false;
  const secret = 'fixture-key-'.padEnd(40, 'x');
  const run = (id = 'run0') => ({ id: 'internal-' + id, name: id, displayName: 'Fixture training ' + id, state: 'finished', config: JSON.stringify({ learning_rate: { value: 0.01 }, api_key: { value: 'do-not-display' } }), summaryMetrics: JSON.stringify({ loss: 0.1 }), systemMetrics: '{}', createdAt: '2026-11-07T00:00:00Z', heartbeatAt: '2026-11-07T00:01:00Z', historyLineCount: 750, historyKeys: { lastStep: 749 }, tags: [], group: '', jobType: 'train', commit: '', readOnly: true, description: '', notes: '', user: null, sweepName: null });
  const artifact = { id: Buffer.from('Artifact:fixture').toString('base64'), artifactSequence: { name: 'checkpoint', project: { name: 'training', entity: { name: 'fixture' } } }, versionIndex: 0, artifactType: { name: 'model' }, description: 'Fixture checkpoint', metadata: '{"epoch":2}', state: 'COMMITTED', size: 16, digest: 'fixture-digest', commitHash: null, fileCount: 1, createdAt: '2026-11-07T00:00:00Z', updatedAt: null };
  const pageInfo = { endCursor: null, hasNextPage: false };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const { query = '', variables = {} } = JSON.parse(raw || '{}');
    const operation = query.match(/query\s+(\w+)/)?.[1] || 'anonymous';
    operations.push(operation);
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/graphql' || req.method !== 'POST' || /\bmutation\b/i.test(query)) return res.writeHead(403).end(JSON.stringify({ errors: [{ message: 'Read-only fixture' }] }));
    if (rejectAuth || req.headers.authorization !== 'Basic ' + Buffer.from('api:' + secret).toString('base64')) return res.writeHead(401).end(JSON.stringify({ errors: [{ message: 'Unauthorized' }] }));
    let data;
    if (operation === 'Viewer' || /viewer\s*\{/.test(query)) data = { viewer: { id: 'fixture-viewer', entity: 'fixture', username: 'fixture', email: 'fixture@example.invalid', teams: { edges: [] } } };
    else if (operation === 'ProbeProjectInput') data = { ProjectType: { fields: [{ name: 'name' }] } };
    else if (operation === 'ProbeRunInput') data = { RunType: { fields: [{ name: 'name' }] } };
    else if (operation === 'Runs') {
      const start = variables.cursor ? Number(variables.cursor) + 1 : 0, end = Math.min(30, start + (variables.perPage || 25));
      data = { project: { runCount: 30, readOnly: true, runs: { edges: Array.from({ length: end - start }, (_, i) => ({ cursor: String(start + i), node: run('run' + (start + i)) })), pageInfo: { endCursor: String(end - 1), hasNextPage: end < 30 } } } };
    } else if (operation === 'Run') data = { project: { run: run(variables.name) } };
    else if (operation === 'RunHistoryKeys') data = { project: { run: { historyKeys: { lastStep: 749 } } } };
    else if (operation === 'HistoryPage') data = { project: { run: { history: Array.from({ length: Math.max(0, Math.min(750, variables.maxStep) - variables.minStep) }, (_, i) => JSON.stringify({ _step: variables.minStep + i, _timestamp: 1700000000 + variables.minStep + i, loss: 1 / (variables.minStep + i + 1), learning_rate: 0.01 })) } } };
    else if (operation === 'TypeInfo') data = { __type: { name: variables.name, fields: [], inputFields: [] } };
    else if (operation === 'ServerFeaturesQuery') data = { serverInfo: { features: [] } };
    else if (operation === 'ServerInfo') data = { serverInfo: { cliVersionInfo: { max_cli_version: '0.23.0' } } };
    else if (operation === 'RunOutputArtifacts') data = { project: { run: { artifacts: { totalCount: 1, pageInfo, edges: [{ node: artifact }] } } } };
    else if (operation === 'ArtifactVersionFiles') data = { project: { artifactType: { artifact: { files: { pageInfo, edges: [{ node: { id: 'fixture-file', name: 'checkpoint.json', url: null, sizeBytes: 16, mimetype: 'application/json', updatedAt: null, digest: 'fixture-digest', md5: null, directUrl: 'https://unused.example.invalid/file' } }] } } } } };
    else {
      console.error('Unhandled W&B query', operation);
      return res.end(JSON.stringify({ errors: [{ message: 'Unsupported fixture query ' + operation }] }));
    }
    res.end(JSON.stringify({ data }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, secret, operations, rejectAuth: () => { rejectAuth = true; }, close: () => new Promise(r => server.close(r)) };
}
