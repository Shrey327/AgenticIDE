import React from '@theia/core/shared/react';
import { Call } from './shared.js';

export function WorkspaceSearch({
  call,
  panels,
  open,
}: {
  call: Call;
  panels: { id: string; label: string }[];
  open: (result: { kind: string; id: string }) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<any[]>([]);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (!query.trim()) {
        setResults([]);
        setError('');
        return;
      }
      void call('workspace.search', { query })
        .then((found) => {
          if (active) {
            setResults(found);
            setError('');
          }
        })
        .catch((failure) => {
          if (active) setError(String(failure));
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, call]);
  const matches = [
    ...panels
      .filter(
        (panel) =>
          query.trim() &&
          panel.label.toLowerCase().includes(query.toLowerCase()),
      )
      .map((panel) => ({ kind: 'panel', id: panel.id, title: panel.label })),
    ...results,
  ];
  return (
    <section className="aiide-workspace-search" aria-label="Workspace search">
      <label>
        Search workspace
        <input
          type="search"
          maxLength={200}
          value={query}
          placeholder="Panels, runs, models, memory…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query.trim() && (
        <div className="aiide-card" aria-label="Search results">
          {error && <p role="alert">{error}</p>}
          {!matches.length && <p role="status">No matching items</p>}
          {matches.map((result) => (
            <button
              key={`${result.kind}:${result.id}`}
              onClick={() => {
                open(result);
                setQuery('');
              }}
            >
              <small>{result.kind}</small> {result.title}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
