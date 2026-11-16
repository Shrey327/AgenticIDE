# Project memory

Open **Build → Knowledge & memory** to keep decisions, findings, source summaries, and voice-session notes alongside your AI project. It works without Qdrant, embeddings, a model, or an account. This is separate from the existing RAG workflow: memory pages are maintained knowledge, while RAG retrieves document chunks.

## Write and find a page

Choose **New page**, enter a title and Markdown body, then **Save page**. Dictation can insert text when the browser supports speech recognition; saving remains explicit. Search matches all entered terms against page titles and bodies. Select a result to inspect its full content and provenance.

Every page is a plain Markdown file under `.aiide-memory/` with YAML frontmatter containing its title, last update time, and source-file hashes. Add this directory to your project's version control if the contents should be shared. Review it for private content before committing. Memory content is saved independently of the telemetry content-capture setting.

The UI shows each page's stable ID. Link another page with `[[page-id]]` or `[[page-id|readable label]]`. The editor lists incoming links and missing link targets. **Attach to assistant** includes the saved page and provenance as reference context; it does not silently attach your entire memory.

## Compile selected sources

Enter a draft title, workspace text paths (one per line), and a chat-model connection. **Compile draft** sends only those selected files to that connection. The model returns an unsaved Markdown draft; review its factual claims and citations, edit it, then save it explicitly. Generated claims are not independently verified.

The compiler accepts Markdown, text, reStructuredText, Python, TypeScript, JavaScript, JSON, YAML, and TOML files. It allows at most 10 files, 128 KB per file, and 48,000 decoded characters per request. Secret/configuration paths covered by the existing workspace exclusion rules, symlinks, binary data, and invalid UTF-8 are rejected. Filename exclusions cannot discover every secret embedded in arbitrary text; inspect selected files before sending them to a remote connection.

Saved source hashes reflect the files used to produce the draft. A page displays **changed** when a source hash differs, or **unavailable** when it cannot be read. Those signals request human review; they do not prove that a claim is wrong. Changes during draft review retain their original hashes, so stale evidence remains visible. Use the freshness filter to triage pages that need attention.

**Import sources without a model** copies selected local source text into a saved, source-linked page. It needs no model or network. The page body must still fit the 64 KB limit; select smaller files if the import is too large. In **Maintain this page's sources**, update the tracked file list and choose **Rebuild as a review proposal** to regenerate an existing page with its original body as context. The compiler model chooser supplies the model for that rebuild. **Save source removals** detaches explicitly removed paths without changing the page's body; the old provenance remains in revision history. Removing a source never deletes its workspace file.

## Automatic maintenance and contradiction review

Automatic scanning is off initially. In **Automatic memory maintenance**, enable linked-source scanning and save the settings. The scanner periodically hashes only the sources already attached to saved pages. It does not crawl the workspace, capture conversations, or add new sources automatically. The interval is 30 seconds to one day and resumes when the same workspace is reopened.

Generating drafts is a separate opt-in requiring a selected model. When enabled, changed readable sources and the existing page body are sent to that connection. Generated revisions are saved as **pending proposals**, with a summary and model-flagged conflicts. No background job overwrites an accepted page. Open each proposal, inspect the draft and citations, check **I reviewed the draft, source citations, and flagged conflicts**, then apply it or discard it. Applying rechecks both the original page revision and every source hash. A source or note changed during generation or review requires rebuilding.

Conflict detection is a model suggestion, not a proof of completeness. Even a proposal with zero flagged conflicts needs review. Missing/unreadable sources produce a visible maintenance error and keep the old provenance; they are not silently dropped or used to invent a replacement fact.

Automatic model calls are bounded to 1–10 attempts per scan and 1–100 attempts per UTC day (defaults: 2 and 10). Attempts are charged before starting the request, including failures, and the count persists across restarts. At most 200 proposals can await review. Existing pending proposals prevent repeated regeneration of the same page. Manual rebuilds are explicit user requests and do not consume this automatic budget. **Scan now** follows the saved settings; it only generates drafts when automatic drafting is enabled. **Cancel current scan or rebuild** aborts the pending model request; disabling scanning stops its timer and aborts current work. Closing the workspace also stops the timer and cancels active generation.

Maintenance configuration, status and proposals live under `.aiide/memory-maintenance/`. This directory contains source-derived content and should receive the same privacy treatment as the saved pages. Notes and maintenance are separate from Codex's own memories and from telemetry retention.

## History and recovery

Before editing, applying a proposal, restoring or deleting a page, the current accepted version is archived under `.aiide/memory-history/<page-id>/`. **Recover a previous or deleted page** lets you select an archived page, load its versions, preview a body and restore it. Existing pages require their current revision to avoid overwriting a concurrent edit; deleted pages retain their stable ID when restored.

The archive retains the ten most recent prior versions per page plus the current version when present. It supports 200 archived page IDs, bounding archive storage to about 140 MB plus current notes. If that archive-ID limit is reached, the operation stops before replacing or deleting a page; remove obsolete archives explicitly in the file editor before proceeding. History files are hash checked when read, and symlinks, non-regular files and oversized snapshots are rejected. History is local recovery, not an external backup.

## Editing and agent access

Saves and deletion require the current file revision. If another editor or agent changes the file, the IDE rejects the stale operation instead of replacing that work. Save or discard your edits before selecting another page. Deletion requires a second confirmation and reports how many pages link to the target; deleting a page can leave broken links.

External agents can search and read memory through the read-scoped MCP tools. Host mutation remains outside these tools. Agents can propose changes to `.aiide-memory/` using the existing staged-file tools; users review and apply those changes through the IDE. YAML metadata and workspace boundaries are checked when the IDE next reads the page.

The current implementation supports 200 pages per workspace, 64 KB of UTF-8 body text per page, and at most 10 provenance sources per page. Default search is lexical; explicit semantic and hybrid search are described in [semantic retrieval](semantic-retrieval.md). Remote source crawling, cross-workspace search, automatic contradiction resolution and automatic claim verification remain outside this workflow.

## Research and audit context

Checked on 2026-11-15 against primary sources:

- [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) describes persistent, linked Markdown knowledge maintained from curated sources, with synthesis and contradictions accumulated between questions. This implementation adds opt-in stale-source scanning, reviewable refresh proposals and recoverable accepted versions.
- [LangChain OpenWiki](https://github.com/langchain-ai/openwiki) provides linked codebase wikis, source-evidence tracking, focused retrieval through agent tools, and drift-aware maintenance. Those capabilities motivated explicit provenance and selective agent retrieval here. Multi-repository wiki workspaces, claim-level evidence tracking, resumable generation, and cross-repository graph exploration remain gaps; a focused local note-link map is implemented.

Before this change, `Rag` already preserved source paths and chunk offsets in Qdrant, and the assistant accepted attached context. Neither supplied a maintained, model-independent project memory with backlinks and source freshness. This feature closes that specific gap; it does not establish feature parity with the referenced projects.

Validation uses actual temporary files and an HTTP model-protocol server for automatic stale-source scanning, restart budgets, durable proposals/history, stale apply rejection, missing sources, and request cancellation. The browser test exercises import → scan → proposal → conflict review → apply → restore through the real components and memory service. Tests use deterministic model responses; they do not establish real-model synthesis or contradiction-detection quality.

## Semantic search and upstream extraction freshness

Use the optional semantic memory index to find saved pages by meaning while preserving revisions and source warnings. Original PDF/text changes behind a reviewed Markdown extraction now mark its memory source stale even when the Markdown itself is unchanged. See [semantic memory and hybrid RAG](semantic-retrieval.md) for indexing, provider privacy, budgets and the explicit extraction-refresh workflow.

## Explore saved note links

Select a saved page to open its **Saved note links** map. The center is the selected page; arrows point to referenced pages, and backlinks appear on the other side. The map shows at most twelve neighboring pages with an explicit omitted-neighbor count, so a large wiki stays readable. Select another node to focus that page's neighborhood. Missing/unreadable targets and changed/unavailable sources carry text markers; these relationships and freshness checks do not verify claims.

Nodes are native keyboard buttons: use Tab, Enter or Space to navigate, and the scrollable diagram supports keyboard scrolling. Save or discard editor changes before following a link. Refreshing graph metadata never edits the current draft, and delayed note-loading responses cannot replace an unsaved blank or loaded-page draft. The graph reflects saved links, omits self-links, exposes metadata only, and invokes no model/embedding provider. It adds no graph dependency or separate index.

`node scripts/test-knowledge-graph-ui.mjs` exercises the actual memory API and React component in Chrome: directed links, missing/stale markers, Enter/Space navigation, blocked dirty navigation, refresh preservation, and delayed initial/current-page responses. Core graph tests cover metadata-only output, unreadable nodes, both link directions and the thirteen-node bound including the selected page.
