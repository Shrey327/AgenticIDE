# Dataset versions and regression gates

Use **Train → Serve & evaluate → Version datasets and prevent regressions** to turn failures into reviewed tests and compare model or prompt changes on the same data. The existing scorers and evaluation run lifecycle remain the execution path.

## Keep an immutable dataset

Every new evaluation validates its JSONL cases, normalizes object-key ordering and whitespace, and saves a SHA-256-addressed snapshot under `.aiide/eval-datasets/`. Equivalent JSON formatting produces the same version. Editing a source dataset produces a different version; it does not replace an earlier snapshot. The result and run configuration record the dataset hash, complete evaluation configuration and its hash. Python reward-file hashes are recorded too; a reward file changed after launch is rejected before execution.

**Snapshot selected dataset** records a version without calling a model. **Browse dataset versions** lists the archive; select one and choose **Use this dataset version** to evaluate exactly those cases again. Snapshots are checked for tampering when browsed, reused or exported. The archive supports 300 versions or 100 MB; each dataset remains limited to 1,000 cases and 10 MB. Remove obsolete archives explicitly when that bound is reached.

These records preserve data and parameters. They do not freeze remote model weights, provider behavior, Python dependencies or the IDE's own evaluator implementation. Retain those versions separately for reproducibility.

## Turn an observed failure into a test

Select an evaluation case, open **Turn selected case into a regression test**, correct its reference, confirm that you checked the input/tools/reference, and export to a new workspace JSONL path. The input includes the effective model messages, including the evaluation's system prompt. Original tool definitions are retained when the dataset snapshot is available. Choose **Tool name or JSON name/arguments** for a tool-use reference, or **Text or JSON answer** for an answer reference.

For a general recorded trace, select a node in **Observe → Traces**, choose **Create regression case**, inspect the captured input, provide a verified reference, and export. Select the LLM node when you need its effective conversation instead of a surrounding chain's input. The source run/case or run/span identifiers are included as dataset metadata.

Exports require explicit reviewed references. They never promote the model's output to ground truth automatically, never replace an existing file, and never bypass content-capture settings. Missing or redacted trace inputs cannot be recovered. An exported case can be selected in Serve & evaluate and tested against another model immediately; combine reviewed cases in the source editor when building a larger suite.

## Define a release gate

Open **Check a release gate** on a selected experiment. Enter minimum means as JSON, using the scorer names displayed in the results, for example:

```json
{"contains": 0.95, "tool_call": 1}
```

The gate recomputes summaries from cases. Incomplete, failed, cancelled, pending, invalid, missing or wholly skipped scorer results fail closed. Case errors are not permitted by default. An optional completed baseline must share the immutable dataset hash and scorer configuration. The allowed regression is an absolute mean-score drop from 0 to 1; zero means no decrease is accepted. It is a deterministic policy threshold, not a statistical significance test.

For CI, build the core once and check a saved evaluation result:

```sh
npm run build:core
node scripts/eval-gate.mjs \
  --result .aiide/evals/<candidate-run-id>.json \
  --threshold contains=0.95 \
  --threshold tool_call=1 \
  --baseline .aiide/evals/<baseline-run-id>.json \
  --max-regression 0 \
  --max-errors 0
```

The CLI prints a JSON report. Exit **0** passes, **1** fails the gate, and **2** indicates invalid arguments or artifacts. It reads regular JSON files below 50 MB and starts no model, workspace server or network connection. Arrange the actual model evaluation earlier in your CI job, retain the result artifacts, then use this command as the deployment gate.

## Validation and limits

Core tests use an actual local HTTP model-protocol server, real SQLite runs and filesystem snapshots, plus spawned CLI processes. They check normalization/version changes, checksum rejection, reviewed text/tool exports, redacted trace rejection, pending/unknown scorer failures, baseline regressions, and changed reward-code protection. Browser acceptance exercises snapshot selection, reviewed case export, a passing release gate and general trace export through the real UI components and service.

These tests establish the workflow, not real-model accuracy. Human annotation queues, automatic production sampling, pairwise statistical analysis, hosted collaboration and provider-model version pinning remain separate capabilities. The design follows the offline regression and production-to-dataset feedback loop described in [LangSmith's evaluation documentation](https://docs.langchain.com/langsmith/evaluation-types).
