import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Run, Span, EventRecord } from './types';
import { redact } from './security';

export class Store {
  readonly db: DatabaseSync;
  dropped = 0;
  strict = false;
  constructor(
    readonly file: string,
    public captureContent = false,
    public budgetMb = 2048,
    public retentionDays = 7,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
            INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started REAL NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS spans(trace_id TEXT, span_id TEXT, run_id TEXT, start REAL, data TEXT, PRIMARY KEY(trace_id, span_id));
            CREATE INDEX IF NOT EXISTS spans_run ON spans(run_id, start);
            CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT, timestamp REAL, data TEXT);
            CREATE INDEX IF NOT EXISTS events_run ON events(run_id, kind, timestamp);`);
    const version = this.db
      .prepare('SELECT version FROM schema_version')
      .get() as { version: number };
    if (version.version !== 1)
      throw new Error('Unsupported workspace database version');
    for (const run of this.runs())
      if (run.status === 'running' && run.training?.target !== 'ssh')
        this.saveRun({ ...run, status: 'interrupted', ended: Date.now() });
    this.prune();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  saveRun(run: Run) {
    this.db
      .prepare('INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?)')
      .run(run.id, run.started, run.status, JSON.stringify(run));
  }
  run(id: string): Run | undefined {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  runs(): Run[] {
    return (
      this.db
        .prepare('SELECT data FROM runs ORDER BY started DESC LIMIT 500')
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  private allow(): boolean {
    if (this.bytes() >= this.budgetMb * 1024 * 1024) {
      this.dropped++;
      return false;
    }
    return true;
  }
  span(span: Span) {
    try {
      if (!this.allow()) return;
      const safe = {
        ...span,
        attributes: redact(span.attributes, this.captureContent),
        events: redact(span.events, this.captureContent),
      };
      this.db
        .prepare('INSERT OR REPLACE INTO spans VALUES (?, ?, ?, ?, ?)')
        .run(
          span.traceId,
          span.spanId,
          span.runId,
          span.start,
          JSON.stringify(safe),
        );
    } catch (error) {
      if (this.strict) throw error;
      this.dropped++;
    }
  }
  spans(
    runId: string,
    offset = 0,
    limit = 200,
  ): { total: number; items: Span[] } {
    const total = (
      this.db
        .prepare('SELECT count(*) AS n FROM spans WHERE run_id=?')
        .get(runId) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        'SELECT data FROM spans WHERE run_id=? ORDER BY start, span_id LIMIT ? OFFSET ?',
      )
      .all(runId, Math.min(500, Math.max(1, limit)), Math.max(0, offset)) as {
      data: string;
    }[];
    return { total, items: rows.map((r) => JSON.parse(r.data)) };
  }
  event(event: EventRecord) {
    try {
      if (!this.allow()) return;
      const safe = {
        ...event,
        value: redact(event.value, this.captureContent),
      };
      if (event.kind === 'log')
        safe.value = this.captureContent
          ? redact(event.value, true)
          : '[CONTENT DISABLED]';
      this.db
        .prepare(
          'INSERT INTO events(run_id, kind, timestamp, data) VALUES (?, ?, ?, ?)',
        )
        .run(event.runId, event.kind, event.timestamp, JSON.stringify(safe));
    } catch (error) {
      if (this.strict) throw error;
      this.dropped++;
    }
  }
  events(runId: string, kind?: string): EventRecord[] {
    const rows = kind
      ? this.db
          .prepare(
            'SELECT id,data FROM events WHERE run_id=? AND kind=? ORDER BY id DESC LIMIT 1000',
          )
          .all(runId, kind)
      : this.db
          .prepare(
            'SELECT id,data FROM events WHERE run_id=? ORDER BY id DESC LIMIT 1000',
          )
          .all(runId);
    return (rows as { id: number; data: string }[]).map((r) => ({
      ...JSON.parse(r.data),
      id: r.id,
    }));
  }
  metricSeries(runId: string): EventRecord[] {
    const rows = this.db
      .prepare(
        "SELECT data FROM events WHERE run_id=? AND kind='metric' ORDER BY id DESC LIMIT 20000",
      )
      .all(runId) as { data: string }[];
    const grouped = new Map<string, EventRecord[]>();
    for (const row of rows.reverse()) {
      const event = JSON.parse(row.data) as EventRecord;
      if (typeof event.value !== 'number' || !Number.isFinite(event.value))
        continue;
      if (!grouped.has(event.name)) grouped.set(event.name, []);
      grouped.get(event.name)!.push(event);
    }
    return [...grouped.values()].flatMap((series) =>
      series.length <= 500
        ? series
        : Array.from(
            { length: 500 },
            (_, i) => series[Math.round((i * (series.length - 1)) / 499)],
          ),
    );
  }
  summary(runId: string) {
    const spans = this.db
      .prepare(
        `SELECT count(*) AS spans,
      sum(CASE WHEN json_extract(data, '$.status') = 'error' THEN 1 ELSE 0 END) AS errors,
      max(json_extract(data, '$.end')) - min(start) AS latencyMs FROM spans WHERE run_id = ?`,
      )
      .get(runId);
    const metrics = this.db
      .prepare(
        `SELECT json_extract(data, '$.name') AS name,
      sum(json_extract(data, '$.value')) AS value FROM events WHERE run_id = ? AND kind = 'metric'
      AND json_type(data, '$.value') IN ('integer', 'real') GROUP BY json_extract(data, '$.name')`,
      )
      .all(runId);
    return { ...spans, metrics };
  }
  bytes() {
    return [this.file, this.file + '-wal'].reduce(
      (n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0),
      0,
    );
  }
  prune() {
    const before = Date.now() - this.retentionDays * 86400000;
    this.transaction(() => {
      this.db.prepare('DELETE FROM spans WHERE start < ?').run(before);
      this.db.prepare('DELETE FROM events WHERE timestamp < ?').run(before);
      this.db
        .prepare("DELETE FROM runs WHERE started < ? AND status != 'running'")
        .run(before);
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('PRAGMA incremental_vacuum');
  }
  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
