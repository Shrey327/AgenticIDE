import React from '@theia/core/shared/react';
import { Call, Perform, Json } from './shared.js';

export function TrainingConnections({
  call,
  perform,
  reload,
}: {
  call: Call;
  perform: Perform;
  reload: () => Promise<void>;
}) {
  const [id, setId] = React.useState('gpu-host'),
    [host, setHost] = React.useState(''),
    [user, setUser] = React.useState(''),
    [port, setPort] = React.useState(22),
    [root, setRoot] = React.useState(''),
    [python, setPython] = React.useState('python3'),
    [identity, setIdentity] = React.useState(''),
    [knownHosts, setKnownHosts] = React.useState(''),
    [result, setResult] = React.useState<any>();
  return (
    <details className="aiide-card">
      <summary>SSH execution profiles</summary>
      <p>
        Connect to an existing Linux project with Python and training
        dependencies installed. Code and datasets stay on that machine. Verify
        the host fingerprint with OpenSSH before connecting.
      </p>
      <div className="aiide-form-grid">
        <label>
          Profile name
          <input value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label>
          SSH host or alias
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="gpu-workstation"
          />
        </label>
        <label>
          SSH user (optional)
          <input value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
        <label>
          SSH port
          <input
            type="number"
            min="1"
            max="65535"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
          />
        </label>
        <label>
          Remote project directory
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="/home/you/project"
          />
        </label>
        <label>
          Remote Python executable
          <input
            value={python}
            onChange={(e) => setPython(e.target.value)}
            placeholder="/home/you/project/.venv/bin/python"
          />
        </label>
        <label>
          Identity file (optional absolute path)
          <input
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
          />
        </label>
        <label>
          Known-hosts file (optional absolute path)
          <input
            value={knownHosts}
            onChange={(e) => setKnownHosts(e.target.value)}
          />
        </label>
      </div>
      <button
        disabled={!id || !host || !root}
        onClick={() =>
          void perform(async () => {
            await call('ssh.save', {
              profile: {
                id,
                host,
                user: user || undefined,
                port,
                root,
                python,
                identityFile: identity || undefined,
                knownHostsFile: knownHosts || undefined,
              },
            });
            await reload();
            setResult(await call('ssh.probe', { id }));
          })
        }
      >
        Save & test SSH
      </button>
      {result && (
        <>
          <p>
            {result.directoryExists && result.writable
              ? 'Project directory is writable'
              : 'Project directory is missing or not writable'}{' '}
            · GPU: {result.gpuStatus}
          </p>
          <Json value={result} />
        </>
      )}
    </details>
  );
}
