import React from '@theia/core/shared/react';
import { Call, Perform, Heading } from './shared.js';

export function DocumentsPanel({
  call,
  perform,
}: {
  call: Call;
  perform: Perform;
}) {
  const [status, setStatus] = React.useState<any>();
  const [file, setFile] = React.useState('');
  const [firstPage, setFirstPage] = React.useState(1);
  const [pages, setPages] = React.useState(20);
  const [ocr, setOcr] = React.useState(false);
  const [name, setName] = React.useState('source-notes');
  const [preview, setPreview] = React.useState<any>();
  const [saved, setSaved] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const request = () => ({ file: file.trim(), firstPage, pages, ocr });
  const run = (action: () => Promise<unknown>) =>
    void perform(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  const reset = () => {
    setPreview(undefined);
    setSaved('');
  };
  React.useEffect(() => {
    let active = true;
    void perform(async () => {
      const next = await call('documents.status');
      if (active) setStatus(next);
    });
    return () => {
      active = false;
    };
  }, [call]);
  return (
    <>
      <Heading
        title="Import documents"
        text="Extract local PDF or UTF-8 text with page provenance, review the result, and save a new Markdown source for RAG or project memory."
      />
      <div className="aiide-columns">
        <section className="aiide-card">
          <h3>Local extraction</h3>
          <p role="status">
            PDF parser:{' '}
            {status?.pdf ? `pypdf ${status.pypdf}` : 'not installed'} · OCR:{' '}
            {status?.ocr ? status.ocrEngine : 'unavailable'}
          </p>
          {!status?.pdf && <p>{status?.setup}</p>}
          <button
            disabled={busy}
            onClick={() =>
              run(async () => setStatus(await call('documents.status')))
            }
          >
            Recheck document tools
          </button>
          <label>
            Source document path
            <input
              value={file}
              disabled={busy}
              placeholder="data/research.pdf"
              onChange={(event) => {
                setFile(event.target.value);
                reset();
              }}
            />
          </label>
          <div className="aiide-form-grid">
            <label>
              First page
              <input
                type="number"
                min={1}
                max={200}
                value={firstPage}
                disabled={busy}
                onChange={(event) => {
                  setFirstPage(Number(event.target.value));
                  reset();
                }}
              />
            </label>
            <label>
              Pages to extract
              <input
                type="number"
                min={1}
                max={ocr ? 3 : 20}
                value={pages}
                disabled={busy}
                onChange={(event) => {
                  setPages(Number(event.target.value));
                  reset();
                }}
              />
            </label>
          </div>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={ocr}
              disabled={busy || !status?.ocr}
              onChange={(event) => {
                setOcr(event.target.checked);
                if (event.target.checked) setPages((old) => Math.min(3, old));
                reset();
              }}
            />
            Use local OCR for selected PDF pages
          </label>
          <p>
            Nothing is uploaded. Native English OCR uses installed tools only
            and may take longer. Extraction does not execute PDF actions. Scans
            need OCR; complex layouts and handwriting can produce errors. Review
            the text against its source.
          </p>
          <button
            className="aiide-primary"
            disabled={busy || !file.trim()}
            onClick={() =>
              run(async () => {
                setPreview(await call('documents.preview', request()));
                setSaved('');
              })
            }
          >
            {busy ? 'Processing document…' : 'Preview extracted text'}
          </button>
          {preview && (
            <>
              <p>
                {preview.pages.length} selected pages of {preview.totalPages}.
                Source SHA-256: <code>{preview.sourceHash}</code>
              </p>
              <label>
                New Markdown filename
                <input
                  disabled={busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                disabled={
                  busy ||
                  !name.trim() ||
                  !preview.pages.some((page: any) => page.text.trim())
                }
                onClick={() =>
                  run(async () => {
                    const result = await call('documents.save', {
                      ...request(),
                      name: name.trim(),
                      reviewHash: preview.reviewHash,
                    });
                    setSaved(result.file);
                  })
                }
              >
                Save reviewed Markdown
              </button>
            </>
          )}
          {saved && (
            <p role="status">
              Saved {saved}. Select it in RAG to embed it, or in Knowledge &
              memory to compile a source-backed draft. Existing source and
              output files are never overwritten.
            </p>
          )}
        </section>
        <section className="aiide-card">
          <h3>Page preview</h3>
          {!preview && (
            <p>Choose a local document and preview it before saving.</p>
          )}
          {preview?.warnings.map((warning: string) => (
            <p role="status" key={warning}>
              {warning}
            </p>
          ))}
          {preview?.pages.map((page: any) => (
            <article key={page.page}>
              <h4>
                Page {page.page} · {page.method}
              </h4>
              <pre tabIndex={0}>{page.text || 'No text extracted.'}</pre>
            </article>
          ))}
        </section>
      </div>
    </>
  );
}
