# Training and inference usability validation

Validated locally on 7 November 2026. This change extends the existing IDE workflows rather than introducing a separate training application.

## User workflows

| Workflow | Available path | Evidence |
| --- | --- | --- |
| No-code classification | Train → Experiment lab: sample/workspace CSV → target/features → SVM and other candidates → sweep → final model → prediction | Real Iris SVM/logistic cross-validation, final SVM training, single-row and 150-row batch inference |
| Language-model fine-tuning | Train → Hugging Face & fine-tuning: locked environment → public Hub download → JSONL → LoRA → saved adapter → generation | Real Qwen3-0.6B on Apple MPS and CPU |
| External-agent setup | Build → External agents → explicit local workflow permission | Standard MCP client created a template, installed its unchanged lockfile, ran an SVM/logistic sweep, fitted SVM and predicted a CSV |
| Investigation | Runs/Traces/Training + MCP run/event/metric inspection | Failure states, trial event queries, metric comparisons and protected dataset access regressions |
| Keyboard/accessibility | Labeled controls, visible focus, navigation focus, reduced motion, readable help text, chart descriptions and empty/error states | Headless Chrome component tests and full browser keyboard flow at 760px |

The UI pass covered Home, Experiment lab, Hub/fine-tuning, Training, Models/playground, RAG, Assistant, External agents, Runs, Traces, Settings, SSH connections, W&B and shared charts/navigation. It fixes actual failure cases, including comparison-only charts, resetting a chat during inference, stale training results, invalid training parameters and inaccessible template choices.

## Real Qwen result

Model: `Qwen/Qwen3-0.6B`, revision `c1899de289a04d12100db370d81485cdf75e47ca`. The public weights downloaded successfully. One-step LoRA training passed on CPU and Apple MPS. The complete Workspace API test used MPS, reported loss **4.8985247612**, saved and reloaded the adapter, then generated **15 tokens in 0.667 seconds**:

> A classification model predicts the class or category of a given input instance.

The real browser then generated 16 tokens from the saved LoRA adapter on MPS, verified the newly persisted response, and restored it after navigating to Runs and back. Screenshots are available under `artifacts/usability/` (`lab-inference.png`, `model-hub.png`, and `qwen-inference.png`).

The runtime chose the existing Transformers/PEFT stack with Apple MPS; MLX was unnecessary for this hardware check. The local machine has 16 GB unified memory. One step on four short examples confirms execution and persistence only. It does not establish accuracy, generalization, instruction-following improvements, or production performance.

Raw local smoke evidence and downloaded weights live under ignored `artifacts/qwen-smoke/`. The summary is `artifacts/qwen-smoke/workspace/smoke-result.json`; rerunning the test updates it. Base weights remain intact and each adapter has a separate directory.

## Reproduce

Final checks passed: desktop build, formatting, 31 Node core tests, 19 Python tests, browser component/keyboard regressions, real tabular browser workflow, real MCP setup workflow, and real Qwen backend/browser inference.

```sh
npm run build
npm test
npm run check:format
npm run test:usability
npm run test:workflows:agents
npm run build:browser
npm run test:workflows:ui
# Install templates/finetune's pinned environment first; this may download ~1.2 GB:
npm run test:huggingface
npm run test:huggingface:ui       # uses the retained Qwen workspace, no repeat download
```

The browser tests require Chrome; MCP/telemetry tests require loopback networking. `test:workflows:agents` installs a fresh temporary template environment using `uv sync --locked` and deletes that test workspace afterward. The Qwen test retains its isolated workspace for inspection and reuses downloaded weights. It can select hardware with `AIIDE_HF_TEST_DEVICE` and Python with `AIIDE_HF_TEST_PYTHON`.

## Research and implementation choices

Sources checked during this work:

- [scikit-learn cross-validation](https://scikit-learn.org/stable/modules/cross_validation.html): classification uses stratified evaluation, preserves preprocessing within folds, and validates class counts before running.
- [SVC reference](https://scikit-learn.org/stable/modules/generated/sklearn.svm.SVC.html): model parameter and probability behavior informed the SVM workflow. The project's pinned scikit-learn 1.7.2 remains tested; newer 1.9.1 emits a probability-parameter deprecation warning.
- [Qwen3-0.6B model card](https://huggingface.co/Qwen/Qwen3-0.6B): selected as the requested small real model for the runtime smoke test.
- [Hugging Face download guide](https://huggingface.co/docs/huggingface_hub/guides/download): downloads resolve and record a concrete revision and keep model files local.
- [PEFT LoRA reference](https://huggingface.co/docs/peft/main/package_reference/lora): adapters are saved separately from base weights and reloaded for inference.
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp): tools advertise their capabilities while authorization is enforced on the server. The new workflow scope is explicit; the previous read/staged permissions do not acquire host execution.

## Boundaries

The Hub UI supports public Transformers causal language models with safetensors and JSONL text LoRA training. Private/gated authentication, image/audio training, HF checkpoint resume, and distributed training are outside this implementation. CUDA and Linux were not tested here. Optional XGBoost/LightGBM were not installed. Accessibility tests cover DOM semantics and keyboard behavior; a manual screen-reader audit is still needed.

Raw examples and generated responses require workflow scope through MCP. Read-only dataset/model inspection excludes samples and categorical values, and protected credential paths are blocked. Existing content-capture controls still govern telemetry; generated responses are separately persisted locally for the playground. Revocation stops active recorded jobs; synchronous inspection or prediction already running may finish. Package installation and model downloads use network access only when their workflow is invoked.
