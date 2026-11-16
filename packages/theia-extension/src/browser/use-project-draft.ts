import React from '@theia/core/shared/react';
import { Call } from './shared.js';

/** Only explicitly selected text fields belong here; credentials never do. */
export function useProjectDraft<T extends Record<string, string>>(
  call: Call,
  key: string,
  initial: T,
): [T, (update: (value: T) => T) => void, string] {
  const [value, setValue] = React.useState(initial);
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState('');
  const changed = React.useRef(false);
  const mounted = React.useRef(false);
  const latest = React.useRef(value);
  latest.current = value;
  React.useEffect(() => {
    mounted.current = true;
    let active = true;
    void call('drafts.get', { key })
      .then((saved) => {
        if (!active) return;
        if (
          !changed.current &&
          saved &&
          Object.keys(initial).every(
            (field) => typeof saved[field] === 'string',
          )
        )
          setValue(saved);
        setReady(true);
      })
      .catch((failure) => {
        if (active) {
          setError(String(failure));
          setReady(true);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [call, key]);
  React.useEffect(() => {
    if (!ready || !changed.current) return;
    const save = () => {
      void call('drafts.save', { key, data: latest.current }).catch(
        (failure) => (mounted.current ? setError(String(failure)) : undefined),
      );
    };
    const timer = setTimeout(save, 500);
    return () => clearTimeout(timer);
  }, [call, key, value, ready]);
  React.useEffect(
    () => () => {
      if (changed.current)
        void call('drafts.save', { key, data: latest.current }).catch(() => {});
    },
    [call, key],
  );
  return [
    value,
    (update) => {
      changed.current = true;
      setValue(update);
    },
    error,
  ];
}
