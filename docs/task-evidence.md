# Task evidence and reviewed handoffs

Open **Task evidence** to keep a plan, completion criteria, review findings and references to actual local verification together. This is a local project record, not a workflow executor. It never executes a plan, shell command, uploaded JSON or model-generated instruction. Paste/edit a generated plan as a proposal; mark it reviewed only after checking it.

## Record the checkpoint before verification

Enter the plan, human completion criteria and relevant workspace source paths. **Preview task checkpoint** shows the selected source bodies and SHA-256 fingerprints. Review the source selection and record, then **Save task checkpoint**. Sources are bounded to twenty UTF-8 files, 256 KB each and 1 MB combined. Credential paths, escapes, symbolic links, directories and named pipes are rejected. Plans are limited to 16,000 characters; criteria to twenty entries. The editor keeps a bounded local form draft across navigation, including an unsaved new task, without changing the saved record.

The checkpoint also records the existing bounded project fingerprint used by host Runs. Run the actual verification through **Runs**, then return and link its recorded ID. Linking evidence or editing notes preserves the checkpoint when the selected files still match. If you intentionally change the source context, choose **Capture a new launch checkpoint before the next verification run**, save it, then rerun verification. A checkpoint created after a command generated new project artifacts can differ from that command's launch fingerprint; the service reports that mismatch rather than certifying the older run against a new context.

**Freshness covers the selected source files only.** Unselected dependencies, external data and provider state need human review. Host-run source matching binds the recorded launch fingerprint to the checkpoint; it does not continuously freeze the whole workspace or prove that arbitrary completion criteria were met. Choose a focused project and review source coverage. A project exceeding the existing fingerprint bounds cannot certify source-matching host evidence.

## Link actual results and review findings

Choose recorded runs and evaluations from their selectors. Runs must still exist, retain their captured identity, have completed successfully, and match the launch checkpoint. Starting a run does not satisfy completion. Evaluation gates recompute the existing scores with your explicit scorer thresholds, require immutable dataset/configuration versions, check any baseline and detect changed or missing result artifacts. Use recorded scorer names such as `exact_match`, not their configuration type name `exact`. A failed, pending or wholly missing scorer cannot be approved by a manual checkbox.

Review findings are a JSON array of `{id, level, text, resolved, resolution}`. Levels are `blocking`, `warning` or `info`; at most fifty findings are stored. A resolved finding needs a written resolution. Unresolved blocking findings prevent reviewed completion. Record the failed run/evaluation IDs and the corrective evidence in the resolution rather than deleting the history of a failure from your explanation.

Optional sandbox IDs refer to actual recorded session status and its latest command-start/end audit records. **Sandbox evidence proves audited command exit only; it does not bind staged source to the task checkpoint.** Inspect/apply the sandbox diff separately. A zero command exit code alone is not a test-quality or criterion-coverage guarantee. Changing a linked session or removing its audit evidence makes the link stale.

Save the updated task record, then **Refresh recorded evidence**. The report distinguishes missing, changed, running, unsuccessful and passing evidence. Review the plan, selected-source coverage, findings and every completion criterion before **Record reviewed completion**. The resulting status is *user-reviewed completion with current evidence*. It is not automatic certification of the prose criteria. Later selected-source, run identity/status, evaluation artifact or sandbox evidence changes invalidate that completion and show *stale completion*.

## Share a reviewed JSON artifact

**Preview evidence export** shows the exact JSON before download. It contains the plan, criteria, findings, selected source hashes and derived result facts. It omits source bodies, raw model conversations, sandbox output and connection credentials. Known credential patterns are redacted; inspect any private text you entered before sharing. The export includes explicit limits on source and sandbox assurance. Confirm the preview, then **Download reviewed evidence JSON**. Changes between preview and download invalidate the review hash.

Downloads write no arbitrary backend path and execute nothing. Recipients can inspect the artifact as data. Hashes provide integrity references, not a signature or third-party attestation. The local OS account can edit its own project and database; this feature does not claim protection against that account forging records.

Task records live under `.aiide/task-evidence/` independently of telemetry capture/retention, with at most 100 records and 256 KB per record/export. Revision checks prevent concurrent form saves, completion or deletion from overwriting a newer record. **Delete task record** requires explicit confirmation and removes only that metadata; source files, run/evaluation/sandbox evidence and downloaded exports remain. Evidence retention still follows the underlying services: a pruned run or audit record can make an old task stale. These operations are native desktop actions; task plans and mutations are not exposed through MCP.

## Validation

`node --test packages/core/test/task-evidence.test.cjs` runs actual unittest processes, an HTTP evaluation protocol fixture and SQLite/filesystem checks. It covers gate failure/success, unresolved findings, selected-source drift, artifact mutation, run failure, stale revisions/export approval, special-file rejection and record-only deletion. `node scripts/test-task-evidence-ui.mjs` exercises the actual Chrome components and Workspace dispatcher through checkpoint creation → real verification → failed/passing evaluation review → human completion → JSON download → stale-source rejection/deletion. The browser flow also verifies that cancelling navigation preserves an unsaved new plan.

This implements the evidence-preserving plan/review/verify handoff motivated by [gstack's public development workflow](https://github.com/garrytan/gstack). It adds no release automation, hosted collaboration service or browser-driving agent engine.
