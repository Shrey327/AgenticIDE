import React from '@theia/core/shared/react';
import { Call } from './shared.js';

type Node = {
  id: string;
  title: string;
  selected: boolean;
  missing: boolean;
  unreadable: boolean;
  stale: boolean;
};
type Graph = {
  selected: string;
  revision: string;
  nodes: Node[];
  edges: { source: string; target: string }[];
  omitted: number;
};

export function NoteLinkMap({
  call,
  id,
  revision,
  disabled,
  open,
}: {
  call: Call;
  id: string;
  revision: string;
  disabled: boolean;
  open: (id: string) => void;
}) {
  const [graph, setGraph] = React.useState<Graph>(),
    [error, setError] = React.useState(''),
    [version, setVersion] = React.useState(0),
    [loading, setLoading] = React.useState(false);
  const marker = 'memory-arrow-' + React.useId();
  const viewport = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setGraph(undefined);
    void call('knowledge.graph', { id })
      .then((next) => {
        if (active) setGraph(next);
      })
      .catch((error) => {
        if (active) setError(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [call, id, revision, version]);
  const outgoing = new Set(
    graph?.edges
      .filter((edge) => edge.source === id)
      .map((edge) => edge.target),
  );
  const incoming = new Set(
    graph?.edges
      .filter((edge) => edge.target === id)
      .map((edge) => edge.source),
  );
  const left =
    graph?.nodes.filter((node) => !node.selected && !outgoing.has(node.id)) ||
    [];
  const right =
    graph?.nodes.filter((node) => !node.selected && outgoing.has(node.id)) ||
    [];
  const rows = Math.max(left.length, right.length, 1),
    height = Math.max(220, rows * 76 + 48),
    width = 820;
  React.useEffect(() => {
    const element = viewport.current;
    if (graph && element) {
      element.scrollLeft = Math.max(0, (width - element.clientWidth) / 2);
      element.scrollTop = Math.max(0, (height - element.clientHeight) / 2);
    }
  }, [graph?.selected, height]);
  const position = (node: Node) => {
    if (node.selected) return { x: 300, y: height / 2 - 30 };
    const group = outgoing.has(node.id) ? right : left;
    return {
      x: outgoing.has(node.id) ? 592 : 8,
      y:
        (height - (group.length * 76 - 16)) / 2 +
        group.findIndex((item) => item.id === node.id) * 76,
    };
  };
  const status = (node: Node) =>
    node.missing
      ? 'Missing page'
      : node.unreadable
        ? 'Unreadable page'
        : node.stale
          ? 'Source changed/unavailable'
          : node.selected
            ? 'Selected saved page'
            : 'Saved page';
  const relationship = (node: Node) =>
    node.selected
      ? 'Selected page'
      : outgoing.has(node.id) && incoming.has(node.id)
        ? 'Reference and backlink'
        : outgoing.has(node.id)
          ? 'Referenced page'
          : 'Links to selected page';
  return (
    <section aria-label="Saved memory link map">
      <div className="aiide-row">
        <h4>Saved note links</h4>
        <button
          type="button"
          disabled={loading}
          onClick={() => setVersion((value) => value + 1)}
        >
          Refresh link map
        </button>
      </div>
      <p className="aiide-note">
        Arrows point from a page to the pages it references. Select a node to
        focus its neighborhood. Missing and source-stale pages are marked in
        text; link relationships do not verify claims.
      </p>
      {disabled && (
        <p role="status">
          Save or discard edits before navigating the link map.
        </p>
      )}
      {loading && <p role="status">Loading saved links…</p>}
      {error && <p role="alert">{error}</p>}
      {graph && (
        <>
          {graph.revision !== revision && (
            <p role="status">
              The saved page changed. Select its center node to reload it before
              editing.
            </p>
          )}
          <div
            ref={viewport}
            tabIndex={0}
            aria-label="Scrollable note link diagram"
            style={{
              overflow: 'auto',
              maxHeight: 480,
              border: '1px solid var(--theia-panel-border)',
            }}
          >
            <div style={{ position: 'relative', width, height }}>
              <svg
                aria-hidden="true"
                focusable="false"
                width={width}
                height={height}
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                }}
              >
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                  </marker>
                </defs>
                {graph.edges.map((edge) => {
                  const source = graph.nodes.find(
                      (node) => node.id === edge.source,
                    )!,
                    target = graph.nodes.find(
                      (node) => node.id === edge.target,
                    )!;
                  const start = position(source),
                    end = position(target),
                    forward = start.x < end.x;
                  const x1 = start.x + (forward ? 220 : 0),
                    x2 = end.x + (forward ? 0 : 220),
                    y1 = start.y + 30,
                    y2 = end.y + 30;
                  return (
                    <path
                      key={edge.source + ':' + edge.target}
                      d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      markerEnd={`url(#${marker})`}
                    />
                  );
                })}
              </svg>
              {graph.nodes.map((node) => {
                const point = position(node),
                  blocked = disabled || node.missing || node.unreadable;
                return (
                  <button
                    type="button"
                    data-note-node={node.id}
                    key={node.id}
                    disabled={blocked}
                    aria-current={node.selected ? 'page' : undefined}
                    aria-label={`${node.missing ? 'Missing' : node.unreadable ? 'Unreadable' : 'Open'} memory page ${node.title}; ${relationship(node)}; ${status(node)}`}
                    title={node.title + ' · ' + status(node)}
                    onClick={() => {
                      if (!blocked) open(node.id);
                    }}
                    style={{
                      position: 'absolute',
                      left: point.x,
                      top: point.y,
                      width: 220,
                      height: 60,
                      textAlign: 'left',
                      borderStyle: node.missing ? 'dashed' : 'solid',
                      opacity: node.missing || node.unreadable ? 1 : undefined,
                      color:
                        node.missing || node.unreadable ? 'inherit' : undefined,
                    }}
                  >
                    <strong
                      style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {node.title}
                    </strong>
                    <small
                      style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {relationship(node)}
                      {node.missing
                        ? ' · missing'
                        : node.unreadable
                          ? ' · unreadable'
                          : node.stale
                            ? ' · stale source'
                            : ''}
                    </small>
                  </button>
                );
              })}
            </div>
          </div>
          {!!graph.omitted && (
            <p role="status">
              {graph.omitted} additional neighbors are omitted from this focused
              view. Search for another page to explore its links.
            </p>
          )}
          {!graph.edges.length && (
            <p role="status">
              No links to other pages in this view. Add [[page-id]] links to a
              page and save it.
            </p>
          )}
        </>
      )}
    </section>
  );
}
