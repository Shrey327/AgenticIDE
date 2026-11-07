import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { stringify } from 'yaml';
import { gunzipSync } from 'node:zlib';
import { Store } from './store';
import { redact } from './security';

const decode = (v: any): any =>
  v?.stringValue ??
  v?.boolValue ??
  (v?.intValue !== undefined ? Number(v.intValue) : v?.doubleValue) ??
  (v?.arrayValue ? v.arrayValue.values?.map(decode) : undefined) ??
  (v?.kvlistValue ? attributes(v.kvlistValue.values) : undefined);
const attributes = (list: any[] = []): Record<string, any> =>
  Object.fromEntries(list.map((a) => [a.key, decode(a.value)]));
const milliseconds = (n: any) => Number(BigInt(n || '0') / 1000000n);

export class Telemetry {
  readonly token = crypto.randomBytes(32).toString('hex');
  private server?: http.Server;
  private collector?: ChildProcess;
  private maintenance?: NodeJS.Timeout;
  private restart?: NodeJS.Timeout;
  private stopping = false;
  private restarts = 0;
  private collectorPort?: number;
  url = '';
  collectorStatus = 'not started';
  private pending = 0;
  private exporting = 0;
  export?: (route: string, body: unknown) => Promise<unknown>;
  constructor(
    readonly store: Store,
    readonly directory: string,
  ) {}
  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (
        req.headers.authorization !== `Bearer ${this.token}` ||
        req.headers.origin
      ) {
        res.writeHead(403).end();
        return;
      }
      if (
        req.method !== 'POST' ||
        !['/v1/traces', '/v1/logs', '/v1/metrics', '/events'].includes(
          req.url || '',
        )
      ) {
        res.writeHead(404).end();
        return;
      }
      if (this.pending >= 16) {
        this.store.dropped++;
        res.writeHead(429).end();
        return;
      }
      this.pending++;
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks);
        const decoded =
          req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(raw, { maxOutputLength: 4 * 1024 * 1024 })
            : raw;
        const body = JSON.parse(decoded.toString());
        this.ingest(req.url!, body);
        if (this.export && req.url !== '/events') {
          if (this.exporting >= 16) this.store.dropped++;
          else {
            this.exporting++;
            void this.export(
              req.url!,
              scrubOtlp(body, this.store.captureContent),
            )
              .catch(() => {
                this.store.dropped++;
              })
              .finally(() => {
                this.exporting--;
              });
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } catch {
        res.writeHead(400).end('Invalid telemetry payload');
      } finally {
        this.pending--;
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}`;
    this.maintenance = setInterval(() => {
      try {
        this.store.prune();
      } catch {
        this.store.dropped++;
      }
    }, 60000);
    this.maintenance.unref();
  }
  ingest(route: string, body: any) {
    if (route === '/events') {
      if (!Array.isArray(body.events) || body.events.length > 1000)
        throw new Error('Invalid events');
      for (const e of body.events) {
        if (
          !this.store.run(e.runId) ||
          ![
            'metric',
            'artifact',
            'evaluation',
            'log',
            'checkpoint',
            'hardware',
            'diagnostic',
            'trial',
          ].includes(e.kind) ||
          !Number.isFinite(e.timestamp)
        )
          throw new Error('Invalid event');
        this.store.event(e);
      }
      return;
    }
    const resources =
      body.resourceSpans ?? body.resourceLogs ?? body.resourceMetrics;
    if (!Array.isArray(resources) || resources.length > 1000)
      throw new Error('Invalid OTLP resource list');
    for (const resource of resources) {
      const attrs = attributes(resource.resource?.attributes);
      for (const scope of resource.scopeSpans ??
        resource.scopeLogs ??
        resource.scopeMetrics ??
        []) {
        for (const span of scope.spans ?? []) {
          const values = { ...attrs, ...attributes(span.attributes) };
          const runId = values['aiide.run.id'];
          if (
            !this.store.run(runId) ||
            !/^[a-f0-9]{32}$/i.test(span.traceId) ||
            !/^[a-f0-9]{16}$/i.test(span.spanId)
          ) {
            this.store.dropped++;
            continue;
          }
          this.store.span({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            runId,
            name: String(span.name).slice(0, 500),
            start: milliseconds(span.startTimeUnixNano),
            end: milliseconds(span.endTimeUnixNano),
            status:
              span.status?.code === 2 ||
              span.status?.code === 'STATUS_CODE_ERROR'
                ? 'error'
                : 'ok',
            attributes: values,
            events: (span.events || []).map((e: any) => ({
              name: e.name,
              timestamp: milliseconds(e.timeUnixNano),
              attributes: attributes(e.attributes),
            })),
          });
        }
        for (const log of scope.logRecords ?? []) {
          const values = { ...attrs, ...attributes(log.attributes) },
            runId = values['aiide.run.id'];
          if (this.store.run(runId))
            this.store.event({
              runId,
              kind: 'log',
              timestamp: milliseconds(log.timeUnixNano),
              name: log.severityText || 'INFO',
              value: decode(log.body),
            });
        }
        for (const metric of scope.metrics ?? []) {
          for (const point of metric.gauge?.dataPoints ??
            metric.sum?.dataPoints ??
            []) {
            const values = { ...attrs, ...attributes(point.attributes) },
              runId = values['aiide.run.id'];
            if (this.store.run(runId))
              this.store.event({
                runId,
                kind: 'metric',
                timestamp: milliseconds(point.timeUnixNano),
                name: metric.name,
                value: Number(point.asDouble ?? point.asInt),
                step: values.step,
              });
          }
        }
      }
    }
  }
  async startCollector(binary: string): Promise<void> {
    if (this.stopping) return;
    if (!fs.existsSync(binary)) {
      this.collectorStatus =
        'Collector unavailable; SDK uses direct local OTLP receiver';
      return;
    }
    const port =
      this.collectorPort ??
      (await new Promise<number>((resolve, reject) => {
        const probe = http.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const port = (probe.address() as { port: number }).port;
          probe.close(() => resolve(port));
        });
      }));
    this.collectorPort = port;
    if (this.stopping) return;
    const config = path.join(this.directory, 'collector.yaml');
    fs.writeFileSync(
      config,
      stringify({
        extensions: { bearertokenauth: { token: this.token } },
        receivers: {
          otlp: {
            protocols: {
              http: {
                endpoint: `127.0.0.1:${port}`,
                auth: { authenticator: 'bearertokenauth' },
              },
            },
          },
        },
        processors: {
          memory_limiter: { check_interval: '1s', limit_mib: 64 },
          batch: { timeout: '200ms', send_batch_size: 256 },
        },
        exporters: {
          otlphttp: {
            endpoint: this.url,
            encoding: 'json',
            headers: { Authorization: `Bearer ${this.token}` },
            retry_on_failure: {
              initial_interval: '1s',
              max_interval: '2s',
              max_elapsed_time: '5s',
            },
            sending_queue: { queue_size: 100 },
          },
        },
        service: {
          telemetry: { metrics: { level: 'none' } },
          extensions: ['bearertokenauth'],
          pipelines: Object.fromEntries(
            ['traces', 'logs', 'metrics'].map((type) => [
              type,
              {
                receivers: ['otlp'],
                processors: ['memory_limiter', 'batch'],
                exporters: ['otlphttp'],
              },
            ]),
          ),
        },
      }),
      { mode: 0o600 },
    );
    this.collector = spawn(binary, ['--config', config], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    this.collector.stderr?.on('data', (data) => {
      diagnostics = (diagnostics + String(data))
        .slice(-2000)
        .replaceAll(this.token, '[REDACTED]');
    });
    this.collector.on('error', () => {
      this.collectorStatus =
        'Collector failed; direct local receiver remains available';
    });
    this.collector.on('exit', () => {
      this.collectorStatus =
        'Collector stopped; direct local receiver remains available';
      if (!this.stopping && this.restarts < 3) {
        this.restarts++;
        this.restart = setTimeout(() => {
          void this.startCollector(binary).catch(() => {
            this.collectorStatus =
              'Collector restart failed; direct local receiver remains available';
            this.store.dropped++;
          });
        }, 1000 * this.restarts);
        this.restart.unref();
      }
    });
    this.collectorStatus = `Collector starting at http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) {
      if (
        this.collector.exitCode !== null ||
        this.collector.signalCode !== null
      )
        break;
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: '{"resourceSpans":[]}',
          signal: AbortSignal.timeout(300),
        });
        if (!ready.ok) throw new Error(`Readiness returned ${ready.status}`);
        this.collectorStatus = `Collector running at http://127.0.0.1:${port}`;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    this.collectorStatus =
      'Collector failed readiness; direct local receiver remains available. ' +
      diagnostics;
    this.collector.kill();
  }
  get exporterUrl() {
    return this.collectorStatus.startsWith('Collector running at ')
      ? this.collectorStatus.slice('Collector running at '.length)
      : this.url;
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.restart);
    clearInterval(this.maintenance);
    if (
      this.collector &&
      this.collector.exitCode === null &&
      this.collector.signalCode === null
    ) {
      const child = this.collector;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    }
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    try {
      fs.unlinkSync(path.join(this.directory, 'collector.yaml'));
    } catch {
      /* Not created when collector unavailable. */
    }
  }
}

/** Sanitize OTLP attribute key/value pairs before optional external export. */
export function scrubOtlp(body: any, capture: boolean): any {
  const copy = structuredClone(body);
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (Array.isArray(value.attributes))
      value.attributes = value.attributes.map((a: any) => {
        const original = decode(a.value),
          safe = redact({ [a.key]: original }, capture)[a.key];
        return safe === original
          ? a
          : {
              key: a.key,
              value: {
                stringValue:
                  typeof safe === 'string' ? safe : JSON.stringify(safe),
              },
            };
      });
    if (value.body)
      value.body = {
        stringValue: capture
          ? String(redact(decode(value.body), true))
          : '[CONTENT DISABLED]',
      };
    for (const [key, child] of Object.entries(value))
      if (key !== 'attributes' && key !== 'body') visit(child);
  };
  visit(copy);
  return copy;
}
