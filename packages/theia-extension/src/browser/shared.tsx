import React from '@theia/core/shared/react';
import type { Run, Connection } from '../common/protocol.js';
export type Call = (
  operation: string,
  args?: Record<string, unknown>,
) => Promise<any>;
export const format = (value: unknown) => JSON.stringify(value, null, 2);
export const time = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString() : '—';
export function Card({ title, text }: { title: string; text: string }) {
  return (
    <section className="aiide-card">
      <h3>{title}</h3>
      <p>{text}</p>
    </section>
  );
}
export function Empty({ children }: React.PropsWithChildren) {
  return (
    <div className="aiide-empty">
      <i className="codicon codicon-beaker" />
      <p>{children}</p>
    </div>
  );
}
export function Json({ value }: { value: unknown }) {
  return <pre className="aiide-json">{format(value)}</pre>;
}
export const duration = (ms: number) =>
  ms < 1000
    ? `${Math.round(ms)} ms`
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)} s`
      : ms < 3600000
        ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
        : `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
export const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};
export function Heading({
  title,
  text,
  children,
}: React.PropsWithChildren<{ title: string; text: string }>) {
  return (
    <div className="aiide-section-title">
      <div>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      {children && <div className="aiide-section-actions">{children}</div>}
    </div>
  );
}
export type Perform = (fn: () => Promise<unknown>) => Promise<void>;
export function RunSelect({
  runs,
  selected,
  select,
}: {
  runs: Run[];
  selected: string;
  select: (id: string) => void;
}) {
  return (
    <label>
      Run
      <select value={selected} onChange={(e) => select(e.target.value)}>
        <option value="">Choose a run</option>
        {runs.map((r) => (
          <option value={r.id} key={r.id}>
            {r.name} · {time(r.started)} · {r.status}
          </option>
        ))}
      </select>
    </label>
  );
}
export function ConnectionSelect({
  label,
  connections,
  value,
  set,
  kind,
}: {
  label: string;
  connections: Connection[];
  value: string;
  set: (id: string) => void;
  kind: string;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose a connection</option>
        {connections
          .filter((c) => c.kind === kind)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
              {c.model ? ` / ${c.model}` : ''}
            </option>
          ))}
      </select>
    </label>
  );
}
