# Product, UI, developer, and agent experience audit

Research date: 15 November 2026. Scope: repository-owned core services, native engineering panels, Python runtime/SDK, templates, tests, packaging, and workflow documentation. This is a source and workflow audit, not a penetration test of Theia/Electron, a study with paying customers, or a guarantee that every defect has been found. Competitor capabilities below come from their public primary sources; no paid accounts or private code were accessed. Priorities and willingness-to-pay hypotheses are our assessment, not measured demand.

This is the original audit baseline. Its “remaining” entries record the original findings, not the current backlog. Follow-up implementation and executed checks are mapped in [audit follow-through](audit-followthrough.md) and [implementation status](implementation.md) and the linked feature guides. The confirmed deployment target is a local desktop IDE with shareable project artifacts; hosted multi-user accounts are not the selected target.

## Product decision

The strongest position is a local AI engineering workbench: code → experiment → evidence → reusable knowledge. Existing training, inference, traces, evaluations, and scoped external agents already support that position. Making every current AI product a built-in service would obscure it. The immediate additions connect three previously missing loops: knowledge that survives sessions, voice conversations that can become reusable knowledge, and environment-based policy learning that shares the existing run lifecycle.

Garry Tan's **gstack** is the clarified reference. It is a development-process toolkit, with planning, review, browser QA and release workflows; it is not simply a second-brain product. Its useful lesson here is to preserve evidence between build, review and verification steps. No gstack code or global installation is added. [Official repository](https://github.com/garrytan/gstack).

## Market and workflow map

| User job | Market reference and documented capability | Repository evidence before this change | Gap and disposition |
| --- | --- | --- | --- |
| Navigate an AI project | Cursor exposes agents, rules, tools and project context. [Agent overview](https://cursor.com/docs/agent/overview), [persistent projects](https://cursor.com/help/ai-features/projects) | `workbench.tsx`, `overview.tsx`: workflow cards and panels; editor/terminal shared through Theia | Add direct Home paths for knowledge, voice and RL. Persistent assistant sessions, unified search and user research remain. |
| Build/review/verify software with agents | gstack connects planning, review and reproducible QA. [Repository](https://github.com/garrytan/gstack) | `assistant.ts`, `sandbox.ts`, `mcp.ts`, `agent-access.ts`: staged edits, bounded execution, explicit scopes, diff review | Add memory discovery and RL recipes to MCP; preserve existing review boundary. Browser-driving agents, specialist orchestration and automated release gates remain. |
| Accumulate source-backed project knowledge | Karpathy's LLM Wiki describes persistent linked knowledge compiled from sources. OpenWiki provides maintained repository/personal wikis. [Idea file](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [OpenWiki](https://github.com/langchain-ai/openwiki) | `rag.ts` and `rag-panel.tsx`: vector retrieval with provenance; assistant context was transient | Implement portable Markdown notes, search, backlinks, missing links, source fingerprints/freshness, revision checks, and model drafts requiring explicit save. Connect selected notes to the assistant. Multi-repo indexing, graph visualization, automatic contradiction reconciliation and connectors remain. |
| Give agents durable memory | Mem0 stores interactions/facts for subsequent retrieval with scoped identifiers. [Memory operations](https://docs.mem0.ai/core-concepts/memory-operations/add) | Agent guidance exists, but no project-memory discovery tool | Add read-only `search_knowledge` and `read_knowledge`; staged edits remain reviewable. Automatic personal-memory extraction, expiry policies, and cross-project identity remain. |
| Dictate and capture ideas | Wispr Flow offers cross-application dictation, dictionary/snippets and paid team features. [Product/pricing](https://wisprflow.ai/pricing) | No microphone or dictation UI | Add explicit dictation to assistant and knowledge editor, browser capability detection, permission errors, editable text and teardown. Systemwide shortcuts, local ASR, dictionary learning and meeting capture remain. |
| Prototype spoken agents | LiveKit and Pipecat provide voice-agent frameworks; Vapi offers managed voice/telephony infrastructure. [LiveKit](https://docs.livekit.io/agents/), [Pipecat](https://docs.pipecat.ai/), [Vapi](https://vapi.ai/pricing) | Model playground accepts text; no speech interaction | Add model-connected turn-based voice playground, optional spoken replies, transcript export and explicit memory save. Realtime streaming audio, VAD, barge-in, SIP/PSTN, call routing, recording and speech regression tests remain. Browser speech does not establish production voice-agent parity. |
| Train policies in environments | Gymnasium defines environment reset/step and termination APIs; Stable-Baselines3 emphasizes independent evaluation environments. [Gymnasium](https://gymnasium.farama.org/api/env/), [SB3 guidance](https://stable-baselines3.readthedocs.io/en/master/guide/rl_tips.html) | Training jobs and LoRA fine-tuning exist, but no interaction/reward environment workflow | Implement seeded tabular Q-learning, no-dependency GridWorld, optional Gymnasium FrozenLake, held-out/random-policy comparison, saved policies and rollout. PPO/SAC, continuous control, custom environment plugins, vectorized workers and distributed training remain. |
| Align/fine-tune language models | Hugging Face TRL implements post-training methods. [TRL](https://huggingface.co/docs/trl/index) | `huggingface.ts`, `aiide_hf`, fine-tune UI: supervised LoRA | No claim that Q-learning is RLHF. DPO/GRPO/PPO, preference datasets, reward-model training and GPU acceptance remain separate projects. |
| Evaluate and diagnose regressions | LangSmith supports dataset-based and production evaluations. Weave combines datasets/scorers and experiment comparison. [LangSmith](https://docs.langchain.com/langsmith/evaluation-types), [Weave](https://wandb.ai/site/evaluations/) | `evals.ts`, `evals-panel.tsx`, trace panels: multiple scorers, case inspection, agent review, experiment summaries | Reuse these rather than duplicate. Dataset/version lineage, annotation queues, production feedback loops, CI regression thresholds and statistical comparisons remain. |
| Build maintainable RAG applications | Dify supports processing pipelines, retrieval tests, metadata and document lifecycle. [Knowledge docs](https://docs.dify.ai/en/cloud/use-dify/knowledge/readme) | Chunk preview, Qdrant, embedding dimensions and provenance implemented | Knowledge notes complement RAG. PDF/OCR, URL ingestion, reranking/hybrid search, deletion/replacement, transactional reindexing and source sync remain. |
| Automate business work | n8n combines model providers, tools, memory and MCP in workflows. [AI workflow docs](https://docs.n8n.io/build/integrate-ai.md) | Named commands and LangGraph templates; no visual workflow/schedule/webhook runtime | Keep code-based project runs. Durable schedules, webhook ingestion, retry/idempotency semantics, connector auth and deployment remain. |
| Compare/train classical models | Existing experiment lab provides CSV preparation, sweeps, leaderboard, final fit and prediction | `lab.ts`, `aiide_lab`, lab panel and tests | Strong existing loop. Dataset leakage controls, grouped/time splits, feature importance, model registry/versioning and larger datasets require follow-up. |
| Train remotely and track artifacts | W&B publishes tracking, artifacts, tables, governance and paid plans. [Pricing/features](https://wandb.ai/site/pricing/) | Training/SSH/W&B panels, remote journal replay, checkpoint resume, read-only W&B | Native training remains valuable. Remote code/dependency sync, immutable artifact storage, distributed jobs, live W&B/GPU tests and quota management remain. |
| Serve models | Existing built-in/vLLM/SGLang/MLX integration registers compatible connections | `serving.ts`, `aiide_hf/server.py`, models/evals UI | Keep the shared model connection boundary. Load balancing, autoscaling, deployment health, batching benchmarks and production traffic management remain. |
| Operate and distribute the IDE | Local-first preview with signing and platform gates documented | `apps`, CI, install scripts, implementation status | Signing/notarization, Linux/Windows acceptance, upgrades/rollback, offline extension audit and long-duration load tests remain release gates. |

## UI and user experience findings

1. **Discoverability:** Home previously led only to ML, code agents, RAG and inference. New workflows now have named navigation entries and Home actions. They reuse the existing visual components, model chooser, error handling and trace navigation.
2. **Truthful progress:** starting a run is not completing it. RL uses persisted run state, cancellation and observed held-out metrics. RAG Home indicators now require a completed run; failed or running operations no longer mark those steps complete.
3. **Data-loss prevention:** wiki updates/deletes use revision checks and atomic replacement. Editor actions must not silently discard dirty notes. Voice insertion never automatically submits text. Cross-panel draft restoration for the wider app is still missing.
4. **Privacy at the point of action:** the former welcome text broadly said data stays on device; it now distinguishes local history from selected model/speech providers. Dictation discloses browser-provider audio processing. Wiki compilation explicitly sends selected source text to the chosen model. Saved notes are ordinary project files, outside telemetry capture/retention.
5. **Accessibility:** new controls use labels, keyboard-operable buttons, status/error announcements and explicit microphone state. Existing focus/contrast/responsive CSS is reused. Screen-reader testing with a human, speech accuracy across languages and small-screen touch testing are not established by automated checks.
6. **Unsupported capabilities:** text remains available when speech recognition is absent or denied. Missing optional Gymnasium must produce an actionable dependency error. Neither feature silently installs packages or downloads models.
7. **Evidence clarity:** source freshness is a hash comparison, not verification that claims are true. Model drafts need review. RL scores describe these local environments, not general intelligence or real-world return.
8. **Blocking file imports:** several readers checked size but could read a named pipe or device indefinitely. RAG/evaluation imports, result/metadata reads, project detection, and sandbox read/diff now reject non-regular files. Bounded child-process tests cover real named pipes. Fixed configuration readers are not uniformly hardened, and these checks do not eliminate concurrent filesystem replacement races.

## Developer and agent experience findings

| Surface | Existing strength | Next gap / acceptance criterion |
| --- | --- | --- |
| Core operation boundary | One Workspace dispatcher reused by UI and constrained MCP recipes | Generic string/argument dispatch needs a typed operation registry if more domains are added; unknown arguments must continue failing at service boundaries. |
| MCP | Explicit allowlists, separate workflow scope, credential-owned runs and cancellation | New knowledge tools are read-only; RL train/rollout require workflow permission. A read grant must not acquire host mutations or arbitrary Python execution. Tests cover the new discovery/denial paths. |
| Agent instructions | Portable AGENTS/CLAUDE guidance and launch commands | Include memory freshness, provenance and RL evidence instructions. Existing user instruction files must never be overwritten. |
| Runs / telemetry | Shared recorded lifecycle, cancellation, authenticated SDK and trace viewer | Broader async operations still need durable resumption; telemetry budgets are not quotas for model weights, wiki files or policy artifacts. |
| Templates / installation | Locked environments and explicit setup | New RL template must run without a model/account and include its runtime module. Optional packages stay opt-in; no global environment mutation. |
| Tests / CI | Core, Python, component and opt-in runtime suites | New integration tests should exercise actual dispatcher + persistence + MCP, not just UI mocks. UI checks need a browser; loopback tests need a less restricted test runner. |
| Errors | Existing Zod validation and operation failures | A future structured error vocabulary should expose next actions and retryability to both people and agents, while preserving diagnostic evidence and redacting credentials. |

## Prioritized remaining work

These are **unimplemented**, not hidden behind completion language.

| Priority | Work | Done means |
| --- | --- | --- |
| P0 release | Distribution, update/data recovery, security review and platform acceptance | Clean install/upgrade/rollback on supported OSes; signed artifacts; hostile-input and resource-exhaustion tests; documented recovery. |
| P1 voice | Real realtime voice pipeline | Reproducible LiveKit/Pipecat project, provider secret handling, streaming STT/LLM/TTS, VAD/interruption, recordings/metrics and human audio acceptance. |
| P1 knowledge | Source lifecycle and trustworthy synthesis | Import/delete/update/rebuild with citations, contradiction review, freshness triage and recoverable note history; no silent claim promotion. |
| P1 reliability | Dataset-to-regression loop | Versioned datasets/prompts, trace-to-case export, CI pass/fail thresholds and side-by-side regression review. |
| P1 usability | Durable sessions/drafts and global navigation | Navigate/restart without losing an assistant session or form draft; keyboard search across models/runs/notes; measured first-success journey. |
| P2 RL | User-defined and larger environments | Safe environment registration, Gym environment checker, PPO/SAC adapters, multi-seed evaluation, checkpoints/resume, vectorized training and real GPU testing. |
| P2 agents | gstack-style evidence workflows | Plans, review findings, test artifacts and release gates linked to one task; browser QA isolated from host credentials; verified handoffs and retry budgets. |
| P2 deployment/team | Share an application safely | Auth, RBAC, dataset isolation, quotas, deployments, operational metrics and migration/rollback. The current backend remains local and single-user. |

## Paid-value hypotheses

Official paid offerings establish that these categories have commercial products; they do not establish that our implementation has paying demand. LangSmith publishes paid seats/usage for observability and evaluation; W&B publishes paid tracking/evaluation/governance offerings; Wispr publishes paid dictation/team plans; Vapi publishes usage and operational support plans. [LangSmith pricing](https://www.langchain.com/pricing), [W&B pricing](https://wandb.ai/site/pricing/), [Wispr pricing](https://wisprflow.ai/pricing), [Vapi pricing](https://vapi.ai/pricing).

The plausible paid outcome for this project is reducing time from a failed AI experiment to a verified fix, with reproducible local evidence and reusable team knowledge. Validate it with users performing three tasks: recover a failed agent run, compare a model change on held-out cases, and answer a project question using a saved source-backed decision. Measure time, completion rate, incorrect conclusions and context sent externally. A larger feature count alone does not validate that outcome.

## Validation

Executed locally on 15 November 2026:

| Check | Result |
| --- | --- |
| `npm run build:browser` | Core and extension typechecks plus Theia frontend/backend bundles passed. |
| `npm test` | 51 Node tests passed; 27 Python tests passed and 1 optional Gymnasium test skipped. |
| `npm run test:usability` | Chrome component checks passed, including failed RAG runs not marking Home steps complete. |
| `npm run test:voice:ui` | Chrome speech fixtures passed: unsupported APIs, explicit submission, playback opt-in, dictation errors/cleanup, late responses, exports and UTF-8 memory limit. |
| `npm run test:product:ui` | Real Theia UI/RPC, persistent memory, HTTP model fixture, voice-to-memory save, actual Python training/metrics and policy rollout passed. |
| Product workflow integration | MCP read scopes, persistence after reopening, actual policy improvement, and standalone execution of the copied RL template passed. |
| Text reader regression | Directory and real POSIX named-pipe probes passed in bounded subprocesses. |
| `npm run check:format`, `git diff --check` | Passed. |

The optional Gymnasium package download stalled; the real FrozenLake test remains skipped. The missing-package error and wrapped-environment lifecycle are tested. Speech recognition/model responses are fixtures in browser checks; no physical microphone, paid model service or synthesis-quality acceptance is implied. Existing release gates remain in [implementation status](implementation.md). No deployment, account purchase, production call, live GPU benchmark or claim of full competitor parity is part of this change.
