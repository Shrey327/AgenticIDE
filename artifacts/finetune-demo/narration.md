# Fine-tuning Qwen3-0.6B for ticket triage in AI Engineering IDE

Real UI recording of the browser development target; synthetic dataset; local Apple Silicon. Narration: local Phonon TTS (Harper).

## 00:00:00 — FINE-TUNING, END TO END

Here is a common job for a small model: triage support tickets for a company called Lumen, and answer in strict JSON that other tools can rely on. Each ticket needs a category, a priority, the product, and whether a human must step in. The priority and escalation rules are Lumen's own policy, so no model knows them out of the box. We'll start from an empty folder, measure how a small open model does, build a golden dataset, fine-tune, and prove it got better. All of it in AI Engineering IDE.

## 00:00:33 — 01 / START FROM SCRATCH

We open an empty folder and create a project from the PEFT fine-tuning template, called ticket triage. The IDE switches into the new project. It already has instrumentation, an evaluation example, and a locked environment definition.

## 00:00:49 — 02 / GET A BASE MODEL

On the Hugging Face page, we install the locked environment: PyTorch, Transformers, and PEFT, isolated to this project. Then we download Qwen3 0.6B, a six hundred million parameter open model, about one point two gigabytes. The IDE records the exact commit it downloaded.

## 00:01:10 — 03 / BUILD A GOLDEN DATASET

Next, the data. We added a small generator script to the project. Its docstring is the triage policy. P1 for outages, data loss, or a whole team blocked. P2 when one person is blocked or a payment fails. And a human must step in for refunds, cancellations, legal, or security. Every example is labeled by that policy, so every answer is known to be correct. That is our golden dataset. The eval set is held out: forty tickets with different wording and product names than the training data, so it measures generalization, not memorization. We run the generator as a project command: four hundred training tickets and forty eval tickets.

## 00:01:55 — 04 / TRY THE BASE MODEL

Before training anything, let's see how the base model does. In Serve and evaluate, we serve Qwen with the built-in engine. It comes up as an OpenAI-compatible endpoint, and joins our model connections. In the playground, we send a real ticket, with the same instructions the evaluation uses. It answers, but wraps the JSON in a code block, and gets the category and the product wrong. The playground also shows latency, token counts, and tokens per second for every reply.

## 00:02:28 — 05 / MEASURE THE BASELINE

One example proves nothing, so we evaluate all forty held-out tickets against the served model. We pick two verifiable scorers. JSON match needs every field exactly right. A Python reward function gives a quarter point for each correct field. The cases stream in as the model answers them.

## 00:02:49 — 05 / MEASURE THE BASELINE

The base model gets 0 percent of tickets fully right, and 26 percent of fields. That is our baseline. Every case opens as a trace: the prompt, the model's reply, and each scorer's verdict, with its reason.

## 00:03:05 — 06 / FINE-TUNE

Now we fine-tune. The base model, the training set, one hundred fifty steps, batch size four, and LoRA rank sixteen. We train a small adapter, and the base weights stay untouched. Chat examples are trained in the model's own chat format, and the loss counts only the answer. The loss streams in live while the job runs on Apple Silicon. This run took about 5 minutes.

## 00:03:32 — 07 / EVALUATE AGAIN

We serve the new adapter with the same engine, and run the exact same evaluation on the same forty tickets. The adapter loads on top of the base weights in a few seconds, and the cases start streaming in.

## 00:03:47 — 07 / EVALUATE AGAIN

Fully correct tickets go from 0 to 55 percent, and field accuracy from 26 to 87 percent. The answers also got shorter. But we are not done. Reading the failing cases shows a pattern: urgency and escalation worded in ways the training data never used, like nobody at our company can work right now.

## 00:04:09 — 08 / FIX THE DATA

So we fix the data, not the model. Round two of the generator adds new phrasings for urgency, escalation, and product names. They are new paraphrases, not copies of eval tickets, and the eval set stays byte for byte the same. Six hundred training tickets. We fine-tune again from the base model, this time for two hundred steps.

## 00:04:34 — 09 / EVALUATE ROUND 2

We serve the round two adapter and evaluate it the same way. This time we also add an agent review scorer, with a rubric. A coding agent will grade each answer as a support lead would.

## 00:04:50 — 09 / EVALUATE ROUND 2

Round two: 70 percent of tickets fully correct, and 91 percent of fields. The Experiments table keeps every run side by side: baseline, round one, and round two, with scores, latency, speed, and tokens.

## 00:05:08 — 10 / LET AN AGENT REVIEW

The agent review is waiting. In External agents, we issue a scoped credential for this workspace. Then we start Codex in the IDE terminal, connected to the workspace over MCP, and ask it to grade the evaluation. Claude Code connects the same way. It reads every case through MCP, judges it against the rubric, and submits its scores back to the IDE.

## 00:05:34 — 10 / LET AN AGENT REVIEW

Codex finished. Its grades land in the same table: an average of 0.81, with a reason on every case. Exact scorers catch formatting and field mistakes. The agent catches whether a decision is defensible.

## 00:05:50 — 11 / SERVE IT FAST

Finally, serving. The built-in engine handles one request at a time: 27.4 tokens per second for the fine-tuned model on this laptop. We serve the same fine-tuned model with vLLM. The IDE merges the adapter into full weights once, and starts vLLM's OpenAI-compatible server. Then we rerun the evaluation, with eight requests in parallel.

## 00:06:17 — 11 / SERVE IT FAST

With eight requests in parallel, vLLM delivers 72.6 tokens per second in total, about 2.7 times the built-in engine, while each request still runs at 35.7. Median latency drops from 0.8 to 0.6 seconds, and quality stays the same. The tips panel lists what else helps: batching, fewer output tokens, merged adapters, quantization, or a GPU. And the fine-tuned model answers our ticket correctly, in clean JSON.

## 00:06:51 — RESULTS

From an empty folder: a model that couldn't do the job, a golden dataset, two fine-tuning rounds, and a measured jump from 0 to 70 percent of tickets fully correct. Every step was a recorded run that you can trace, compare, and hand to an agent. One caveat: the data is synthetic and the eval set is small. For production, keep a second untouched test set, and evaluate on real tickets.
