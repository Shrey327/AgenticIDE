import React from '@theia/core/shared/react';
import type { Span, TraceNode } from '../common/protocol.js';
import { duration, format } from './shared.js';

const kinds: Record<string, { label: string; icon: string }> = {
  chain: { label: 'Chain', icon: 'link' },
  llm: { label: 'LLM', icon: 'sparkle' },
  tool: { label: 'Tool', icon: 'tools' },
  retriever: { label: 'Retriever', icon: 'search' },
  evaluator: { label: 'Eval', icon: 'pass' },
};
const kindOf = (kind: string) => (kinds[kind] ? kind : 'other');

export function KindTag({ kind }: { kind: string }) {
  const k = kindOf(kind);
  return (
    <span className={`aiide-kind aiide-kind-${k}`}>
      <i className={`codicon codicon-${kinds[k]?.icon || 'symbol-method'}`} />
      {kinds[k]?.label || kind || 'Step'}
    </span>
  );
}

export function ScoreChip({
  name,
  score,
  pending,
}: {
  name?: string;
  score?: number;
  pending?: boolean;
}) {
  const level =
    pending || score === undefined
      ? 'pending'
      : score >= 0.75
        ? 'good'
        : score >= 0.4
          ? 'mid'
          : 'bad';
  return (
    <span className={`aiide-score aiide-score-${level}`}>
      {name && <small>{name}</small>}
      {pending ? 'pending' : score === undefined ? '—' : score.toFixed(2)}
    </span>
  );
}

/** Converts recorded spans into run-tree nodes; uses aiide.kind and gen_ai.* conventions when present. */
export function spansToNodes(spans: Span[]): TraceNode[] {
  return spans.map((span) => {
    const a = span.attributes;
    const name = span.name.toLowerCase();
    const kind =
      (a['aiide.kind'] as string) ||
      (a['gen_ai.request.model'] || /llm|chat|completion/.test(name)
        ? 'llm'
        : /tool/.test(name)
          ? 'tool'
          : /retriev|search/.test(name)
            ? 'retriever'
            : 'chain');
    const known = new Set([
      'aiide.kind',
      'input',
      'output',
      'gen_ai.request.model',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
      'aiide.score',
      'error.message',
    ]);
    const tokens = {
      input: a['gen_ai.usage.input_tokens'] as number | undefined,
      output: a['gen_ai.usage.output_tokens'] as number | undefined,
    };
    return {
      id: span.spanId,
      parent: span.parentSpanId,
      name: span.name,
      kind,
      start: span.start,
      end: span.end,
      status: span.status === 'error' ? 'error' : 'ok',
      input: a.input ?? a['gen_ai.prompt'],
      output: a.output ?? a['gen_ai.completion'],
      model: a['gen_ai.request.model'] as string | undefined,
      tokens: (tokens.input ?? tokens.output) ? tokens : undefined,
      score: a['aiide.score'] as number | undefined,
      error: (a['error.message'] || a['error.type']) as string | undefined,
      metadata: {
        ...Object.fromEntries(
          Object.entries(a).filter(([key]) => !known.has(key)),
        ),
        ...(span.events.length ? { events: span.events } : {}),
      },
    };
  });
}

const isMessage = (value: any) =>
  value && typeof value === 'object' && typeof value.role === 'string';

function ToolCallCard({ call }: { call: any }) {
  const fn = call.function ?? call;
  let args: unknown = fn.arguments ?? fn.args;
  if (typeof args === 'string')
    try {
      args = JSON.parse(args);
    } catch {
      /* keep raw text */
    }
  return (
    <div className="aiide-toolcall">
      <div className="aiide-toolcall-head">
        <i className="codicon codicon-tools" />
        <code>{fn.name || 'tool'}</code>
        {call.id && <small>{call.id}</small>}
      </div>
      {args && typeof args === 'object' && !Array.isArray(args) ? (
        <dl className="aiide-kv">
          {Object.entries(args).map(([key, value]) => (
            <React.Fragment key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === 'string' ? value : format(value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : (
        <pre>{typeof args === 'string' ? args : format(args)}</pre>
      )}
    </div>
  );
}

const roleLabel: Record<string, string> = {
  system: 'System',
  user: 'Human',
  assistant: 'AI',
  tool: 'Tool',
};
function Message({ message }: { message: any }) {
  const content =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part: any) => part.text ?? format(part))
            .join('\n')
        : '';
  return (
    <div className={`aiide-msg aiide-msg-${message.role}`}>
      <div className="aiide-msg-role">
        {roleLabel[message.role] || message.role}
        {message.tool_call_id && <small> · {message.tool_call_id}</small>}
      </div>
      {message.reasoning && (
        <details className="aiide-msg-think">
          <summary>Thinking</summary>
          <div className="aiide-msg-body">{message.reasoning}</div>
        </details>
      )}
      {content && <div className="aiide-msg-body">{content}</div>}
      {(message.tool_calls || []).map((call: any, i: number) => (
        <ToolCallCard key={call.id || i} call={call} />
      ))}
    </div>
  );
}

export function Payload({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === '')
    return <p className="aiide-note">Nothing recorded.</p>;
  if (value === '[CONTENT DISABLED]')
    return (
      <p className="aiide-note">
        Content capture is off. Enable it in Settings to record prompts and
        responses in traces.
      </p>
    );
  if (Array.isArray(value) && value.length && value.every(isMessage))
    return (
      <div className="aiide-msgs">
        {value.map((m, i) => (
          <Message key={i} message={m} />
        ))}
      </div>
    );
  if (isMessage(value))
    return (
      <div className="aiide-msgs">
        <Message message={value} />
      </div>
    );
  if (typeof value === 'string')
    return <div className="aiide-msg-body aiide-plain">{value}</div>;
  return <pre className="aiide-json">{format(value)}</pre>;
}

/** LangSmith-style run tree: typed steps on the left, rendered inputs/outputs on the right. */
export function TraceView({
  nodes,
  actions,
}: {
  nodes: TraceNode[];
  actions?: (node: TraceNode) => React.ReactNode;
}) {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, TraceNode[]>();
  for (const node of nodes)
    if (node.parent && ids.has(node.parent))
      children.set(node.parent, [...(children.get(node.parent) || []), node]);
  const roots = nodes.filter((n) => !n.parent || !ids.has(n.parent));
  const [selectedId, setSelected] = React.useState<string>();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [tab, setTab] = React.useState<'io' | 'meta'>('io');
  const selected =
    nodes.find((n) => n.id === selectedId) ?? roots[0] ?? undefined;
  const span = {
    start: Math.min(...nodes.map((n) => n.start)),
    end: Math.max(...nodes.map((n) => n.end)),
  };
  const total = Math.max(1, span.end - span.start);
  const rows: { node: TraceNode; depth: number }[] = [];
  const walk = (node: TraceNode, depth: number, seen: Set<string>) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({ node, depth });
    if (!collapsed.has(node.id))
      for (const child of (children.get(node.id) || []).sort(
        (a, b) => a.start - b.start,
      ))
        walk(child, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const root of roots) walk(root, 0, seen);
  const feedback = selected
    ? (children.get(selected.id) || []).filter((n) => n.kind === 'evaluator')
    : [];
  if (!nodes.length) return null;
  return (
    <div className="aiide-tt">
      <div className="aiide-tt-tree" role="tree" aria-label="Run tree">
        {rows.map(({ node, depth }) => {
          const kids = children.get(node.id)?.length;
          const open = !collapsed.has(node.id);
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-selected={selected?.id === node.id}
              aria-expanded={kids ? open : undefined}
              tabIndex={0}
              className={`aiide-tt-row ${selected?.id === node.id ? 'selected' : ''} ${node.status === 'error' ? 'error' : ''}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={() => setSelected(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setSelected(node.id);
              }}
            >
              <button
                className="aiide-tt-caret"
                aria-label={open ? 'Collapse' : 'Expand'}
                style={{ visibility: kids ? 'visible' : 'hidden' }}
                onClick={(e) => {
                  e.stopPropagation();
                  const next = new Set(collapsed);
                  if (open) next.add(node.id);
                  else next.delete(node.id);
                  setCollapsed(next);
                }}
              >
                <i
                  className={`codicon codicon-chevron-${open ? 'down' : 'right'}`}
                />
              </button>
              <KindTag kind={node.kind} />
              <span className="aiide-tt-name">{node.name}</span>
              {node.kind === 'evaluator' && <ScoreChip score={node.score} />}
              {node.status === 'error' && (
                <i className="codicon codicon-error aiide-tt-err" />
              )}
              <span className="aiide-tt-meta">
                {node.tokens && (node.tokens.input || node.tokens.output) ? (
                  <small>
                    {(node.tokens.input || 0) + (node.tokens.output || 0)} tok
                  </small>
                ) : null}
                <small>{duration(Math.max(0, node.end - node.start))}</small>
              </span>
              <span className="aiide-tt-bar" aria-hidden="true">
                <span
                  className={`aiide-kind-${kindOf(node.kind)}`}
                  style={{
                    marginLeft: `${((node.start - span.start) / total) * 100}%`,
                    width: `${Math.max(1, ((node.end - node.start) / total) * 100)}%`,
                  }}
                />
              </span>
            </div>
          );
        })}
      </div>
      {selected && (
        <section className="aiide-tt-detail" aria-label="Step details">
          <div className="aiide-tt-title">
            <KindTag kind={selected.kind} />
            <h3>{selected.name}</h3>
          </div>
          <div className="aiide-tt-stats">
            <span
              className={`aiide-badge ${selected.status === 'error' ? 'failed' : 'completed'}`}
            >
              {selected.status === 'error' ? 'Error' : 'Success'}
            </span>
            <span>
              <i className="codicon codicon-clock" />{' '}
              {duration(Math.max(0, selected.end - selected.start))}
            </span>
            {selected.tokens &&
              (selected.tokens.input || selected.tokens.output) && (
                <span>
                  <i className="codicon codicon-symbol-number" />{' '}
                  {selected.tokens.input ?? 0} → {selected.tokens.output ?? 0}{' '}
                  tokens
                </span>
              )}
            {selected.model && (
              <span>
                <i className="codicon codicon-server-process" />{' '}
                {selected.model}
              </span>
            )}
          </div>
          {feedback.length > 0 && (
            <div className="aiide-tt-feedback">
              {feedback.map((f) => (
                <ScoreChip key={f.id} name={f.name} score={f.score} />
              ))}
            </div>
          )}
          {selected.error && (
            <pre className="aiide-tt-error" role="alert">
              {selected.error}
            </pre>
          )}
          <div className="aiide-chips" role="tablist">
            <button
              role="tab"
              aria-pressed={tab === 'io'}
              aria-selected={tab === 'io'}
              onClick={() => setTab('io')}
            >
              Run
            </button>
            <button
              role="tab"
              aria-pressed={tab === 'meta'}
              aria-selected={tab === 'meta'}
              onClick={() => setTab('meta')}
            >
              Metadata
            </button>
          </div>
          {tab === 'io' ? (
            selected.kind === 'evaluator' ? (
              <div className="aiide-tt-eval">
                <ScoreChip score={selected.score} />
                <p>{(selected.output as any)?.reason || 'No reason given.'}</p>
              </div>
            ) : (
              <>
                <h4>Input</h4>
                <Payload value={selected.input} />
                <h4>Output</h4>
                <Payload value={selected.output} />
              </>
            )
          ) : (
            <pre className="aiide-json">
              {format({
                id: selected.id,
                start: new Date(selected.start).toISOString(),
                ...selected.metadata,
              })}
            </pre>
          )}
          {actions?.(selected)}
        </section>
      )}
    </div>
  );
}
