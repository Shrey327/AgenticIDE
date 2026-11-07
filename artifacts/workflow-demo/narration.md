# AI Engineering IDE — workflow demo

Real UI recording. Deterministic retrieval example and real CPU PyTorch training. Model/RAG sections are configuration tours. Narration uses macOS Daniel speech synthesis.

## 00:00:00 — THE ENGINEERING LOOP

AI engineering is more than writing a prompt. You need to run experiments, understand failures, and prove that a change helps. Here is that workflow inside AI Engineering IDE.

## 00:00:12 — 01 / OPEN YOUR WORKSPACE

Start in Overview with an existing Python project, or choose an instrumented template. Python, LangGraph, RAG, and training templates provide a starting point. For this demo, we have prepared a small support-answer project and its local commands.

## 00:00:30 — 02 / ESTABLISH A BASELINE

In Runs, select baseline and run it locally. The process completes, but the answer correctness score is zero. This example deliberately uses deterministic retrieval, without a language model, so we can isolate the retrieval mistake.

## 00:00:46 — 03 / DIAGNOSE THE RESULT

Open the trace to see retrieval, answer composition, and evaluation on one timeline. Select retrieve documents. Its attributes show that the baseline takes the first chunk and returns the models document, rather than the storage document the question needs.

## 00:01:04 — 04 / MOVE FROM TRACE TO CODE

Open source jumps directly from the selected span to its Python code. The prepared improvement ranks documents by matching question terms instead of taking the first chunk. The same instrumentation measures both versions.

## 00:01:19 — 05 / TEST THE IMPROVEMENT

Back in Runs, choose ranked retrieval and launch the improved variant. It finds the storage document, and the correctness score becomes one. Both attempts remain in local history, including their commands and recorded configuration.

## 00:01:35 — 06 / CHECK THE EVIDENCE

Select the baseline as a comparison and inspect the recorded metrics and evaluation events. The baseline scores zero; the ranked version scores one. This proves the change for our single demo case. A real release would need a representative evaluation dataset.

## 00:01:53 — 07 / HAND OFF USEFUL CONTEXT

Attach the run to the coding assistant to carry its evidence into a focused request. With a configured model, you can ask for an explanation or a proposed patch. Autonomous execution additionally requires tested tool support and Docker; changes are reviewed before applying.

## 00:02:11 — 08 / LAUNCH A TRAINING JOB

For model work, switch to Training, select the training command, and enter experiment parameters. Start a small, real PyTorch regression job on the local CPU. The IDE records learning curves, system measurements, and checkpoint references alongside the other runs.

## 00:02:31 — 09 / INSPECT AND CONTINUE

Inspect the loss curves, then open the saved checkpoint. Choose it for resume, increase the total step count, and launch the continuation. The resumed run continues from the saved state while the original experiment stays available for comparison.

## 00:02:48 — 10 / CONNECT YOUR MODELS

When you are ready to use a model, add a local or HTTPS endpoint in Models. Capability checks distinguish chat, streaming, tools, and embeddings. This recording does not connect a model service or claim a language model quality result.

## 00:03:05 — 11 / EXTEND TO A RAG WORKFLOW

The RAG panel extends this loop to document chunking, ingestion, retrieval, and dataset evaluation. Configure Qdrant and an embedding connection to run that workflow. Retrieved chunks and their provenance help you inspect what an answer was grounded in.

## 00:03:22 — BUILD → OBSERVE → IMPROVE

The benefit is a shorter engineering loop. Run your code, inspect the evidence, compare the change, and continue training, all from the same local workspace.
