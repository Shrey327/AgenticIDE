import React from '@theia/core/shared/react';
import { Call, Perform, Heading } from './shared.js';

type Entry = { file: string; size: number; sha256: string };
type Preview = {
  files: Entry[];
  totalBytes: number;
  reviewHash: string;
  manifest?: string;
  project?: string;
};

export function ProjectBundlesPanel({
  call,
  perform,
  openProject,
}: {
  call: Call;
  perform: Perform;
  openProject?: (root: string) => Promise<void>;
}) {
  const [files, setFiles] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [additional, setAdditional] = React.useState('');
  const [preview, setPreview] = React.useState<Preview>();
  const [exported, setExported] = React.useState('');
  const [archive, setArchive] = React.useState('');
  const [name, setName] = React.useState('shared-project');
  const [incoming, setIncoming] = React.useState<Preview>();
  const [imported, setImported] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const choices = () => [
    ...new Set([
      ...selected,
      ...additional
        .split('\n')
        .map((file) => file.trim())
        .filter(Boolean),
    ]),
  ];
  const run = (action: () => Promise<unknown>) =>
    void perform(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  React.useEffect(() => {
    let active = true;
    void perform(async () => {
      const list = await call('bundles.files');
      if (active) setFiles(list);
    });
    return () => {
      active = false;
    };
  }, [call]);
  return (
    <>
      <Heading
        title="Share project artifacts"
        text="Review selected files, create a portable ZIP, or import a reviewed bundle into a new project folder."
      />
      <div className="aiide-columns">
        <section className="aiide-card">
          <h3>Export selected files</h3>
          <p>
            No files are selected automatically. Credential paths and symbolic
            links are rejected. Filename filtering cannot find every secret
            inside source code or notes; review each selected file before
            sharing.
          </p>
          <details>
            <summary>Choose project source files</summary>
            {files.map((file) => (
              <label className="aiide-checkbox" key={file}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.includes(file)}
                  onChange={(event) => {
                    setSelected((old) =>
                      event.target.checked
                        ? [...old, file]
                        : old.filter((value) => value !== file),
                    );
                    setPreview(undefined);
                  }}
                />
                {file}
              </label>
            ))}
          </details>
          <label>
            Additional files or model artifacts, one workspace path per line
            <textarea
              rows={4}
              disabled={busy}
              value={additional}
              onChange={(event) => {
                setAdditional(event.target.value);
                setPreview(undefined);
              }}
              placeholder={'data/eval.jsonl\nrl-policies/policy-id/policy.json'}
            />
          </label>
          <p>
            Large weights and generated runtime state are absent from the
            default file chooser. Explicit artifact selections support up to 64
            MB per file and 200 MB expanded per bundle. Connections, host
            commands and credentials are removed from the generated project
            configuration.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                setPreview(await call('bundles.preview', { files: choices() }));
                setExported('');
              })
            }
          >
            Preview export
          </button>
          {preview && (
            <>
              <BundleFiles preview={preview} />
              <details>
                <summary>Sanitized project configuration</summary>
                <pre>{preview.manifest}</pre>
              </details>
              <button
                className="aiide-primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await call('bundles.export', {
                      files: choices(),
                      reviewHash: preview.reviewHash,
                    });
                    setExported(result.file);
                  })
                }
              >
                Export reviewed ZIP
              </button>
            </>
          )}
          {exported && (
            <p role="status">
              Created {exported}. Share this file using your file manager.
              Source files remain in this project.
            </p>
          )}
        </section>
        <section className="aiide-card">
          <h3>Import a project bundle</h3>
          <p>
            Copy a bundle into this workspace, enter its relative path, then
            inspect its contents. Import creates a new folder without executing
            code, installing packages or changing your active project.
          </p>
          <label>
            Bundle ZIP path
            <input
              disabled={busy}
              value={archive}
              onChange={(event) => {
                setArchive(event.target.value);
                setIncoming(undefined);
                setImported('');
              }}
              placeholder="shared-project.zip"
            />
          </label>
          <label>
            New project folder
            <input
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            disabled={busy || !archive.trim()}
            onClick={() =>
              run(async () =>
                setIncoming(
                  await call('bundles.inspect', { file: archive.trim() }),
                ),
              )
            }
          >
            Inspect bundle
          </button>
          {incoming && (
            <>
              <p>
                Project: {incoming.project}. Archive SHA-256:{' '}
                <code>{incoming.reviewHash}</code>
              </p>
              <BundleFiles preview={incoming} />
              <button
                className="aiide-primary"
                disabled={busy || !name.trim()}
                onClick={() =>
                  run(async () => {
                    const result = await call('bundles.import', {
                      file: archive.trim(),
                      name: name.trim(),
                      reviewHash: incoming.reviewHash,
                    });
                    setImported(result.root);
                  })
                }
              >
                Import as new project
              </button>
            </>
          )}
          {imported && (
            <>
              <p role="status">
                Imported to {imported}. Review its source before trusting or
                running it. Configure commands and model connections explicitly.
              </p>
              {openProject && (
                <button
                  disabled={busy}
                  onClick={() => run(() => openProject(imported))}
                >
                  Open imported project
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function BundleFiles({ preview }: { preview: Preview }) {
  return (
    <div>
      <p>
        {preview.files.length} files · {(preview.totalBytes / 1024).toFixed(1)}{' '}
        KB expanded
      </p>
      <div className="aiide-table-wrap">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Bytes</th>
              <th>SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {preview.files.map((file) => (
              <tr key={file.file}>
                <td>{file.file}</td>
                <td>{file.size.toLocaleString()}</td>
                <td>
                  <code title={file.sha256}>{file.sha256.slice(0, 16)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
