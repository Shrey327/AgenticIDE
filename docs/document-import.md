# Local document import

**Import documents** extracts local PDFs, Markdown and UTF-8 text into reviewable, page-linked Markdown. Enter a workspace-relative source path, select the first page and page count, then **Preview extracted text**. Nothing is uploaded, no PDF actions/scripts are executed, and no model or package is downloaded automatically.

The runtime uses the IDE host's `python3` (`python` on Windows), not the selected project's training interpreter. **Recheck document tools** reports the actual executable and installed parser. If missing, install `pypdf>=6.10,<8` into that host interpreter explicitly, for example `python3 -m pip install 'pypdf>=6.10,<8'`. Installing it only in an unrelated project environment will not make it available to this importer. Text/Markdown import needs only Python's standard library.

The preview shows extracted text, source SHA-256, original page numbers and extraction method. Review it against the source, choose a new filename, then **Save reviewed Markdown**. The file is created under `documents/` with original-source links such as `../data/research.pdf#page=2`. Existing files and the source are never overwritten. A changed source, changed extraction parameters or expired preview requires another review; previews last thirty minutes and only four are retained in memory. Saving uses the reviewed extraction, without silently running OCR/model inference again.

Select the saved Markdown in RAG for chunk preview/ingestion, or in Knowledge & memory as a source for a reviewed synthesis. Those tools retain their own size/context limits; choose fewer pages when preparing a small memory source. Document text remains untrusted reference content and can contain mistakes or embedded prompt-injection instructions.

## Optional local OCR

Scans have no embedded text. If local OCR is available, explicitly enable **Use local OCR for selected PDF pages**. The importer renders each selected page using installed `pdftoppm`, then uses installed Tesseract with English language data, or native Apple Vision through the installed Swift compiler on macOS. The checkbox is disabled when the required engine/rasterizer is missing; runtime failures explain which local tool failed. English OCR is supported; no claim of handwriting, all-language, table or layout reconstruction is made.

OCR is opt-in and processes at most three selected pages, scaled to at most 2,000 pixels on the longest side. Native Vision and Tesseract run locally; the IDE does not call a cloud OCR API or fetch language models. The temporary page images and compiled native helper are removed after extraction. Complex layouts, unusual fonts and images may produce imperfect text; inspect the original before using the output as evidence.

## Bounds and validation

Input is a regular workspace file up to 25 MB. Credential paths, path escapes and symlinks are rejected. PDFs may contain at most 200 pages; a text preview selects at most twenty, OCR at most three. Per-stream decompression is capped at 4 MB, aggregate decoded PDF content at 16 MB, extracted text at 64 KB per page/512 KB total. Encrypted PDFs are rejected with instructions to export an unencrypted copy deliberately. Oversized streams/text and malformed documents fail instead of being silently truncated.

Extraction runs in a child process with a two-minute wall timeout and, where supported, a forty-second CPU limit. Linux also applies a 1 GB address-space limit inherited by native children. Native renderer/OCR commands have separate timeouts and, on POSIX, a 20 MB per-file output cap (128 MB for the trusted Swift compilation). Tool output is captured to temporary files and read with a 512 KB bound. Final raster size does not bound every allocation made while decoding an embedded image. macOS has no hard RSS/address-space guarantee here; these controls do not certify third-party parsers or the OS against every hostile-file exploit.

Actual validation on 16 November 2026 used host Python 3.14, pypdf 6.10.0, installed Poppler and Swift 6.3.3/Apple Vision. Tests generated a PDF content stream, verified page-specific text/provenance, rejected encryption and a compressed oversized stream, checked review conflicts and no-overwrite behavior, and converted a PDF into a genuine scanned-image PDF before recognizing its visible text through local OCR. No mocked OCR or paid API response is used in that acceptance test.

The extraction behavior follows [pypdf's text-extraction documentation](https://pypdf.readthedocs.io/en/stable/user/extract-text.html), which distinguishes embedded text from scans and discusses stream-memory risks. Optional engines follow [Tesseract's CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html) and [Apple Vision's text-recognition API](https://developer.apple.com/documentation/vision/recognizing-text-in-images).

Operations: `documents.status`, `documents.preview({file,firstPage,pages,ocr})` and `documents.save({file,firstPage,pages,ocr,name,reviewHash})`. Saving requires a matching live preview and never auto-executes the resulting document.

## Freshness after the original changes

Saved Markdown carries a source path/hash hint alongside its visible page citations. Knowledge and RAG recheck the bounded original PDF/text file, so an unchanged export does not hide a changed original. Outdated extractions are refused for new ingestion or memory drafting. Preview the current original, review it, save a new filename, then explicitly update memory sources/reindex and replace the old RAG source. Accepted notes and earlier exports are never overwritten automatically. See [semantic retrieval](semantic-retrieval.md) for bounds and tests.
