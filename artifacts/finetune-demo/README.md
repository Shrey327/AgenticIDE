# Fine-tuning an open model, end to end

`Fine-Tuning-Demo.mp4` is a 7 min 17 s, 1920 × 1080 narrated demo (18 chapters, burned-in captions, English subtitle track `fine-tuning-demo.srt`, script in `narration.md`).

It starts from an empty folder and fine-tunes **Qwen3-0.6B** for a job it can't do out of the box: triaging support tickets for a fictional company ("Lumen") into strict JSON (`category`, `priority`, `product`, `needs_human`) following Lumen's own priority and escalation policy.

## What the video shows

1. Create a project from the PEFT fine-tuning template, install its locked environment, download Qwen3-0.6B (pinned commit).
2. Build golden data with `files/make_dataset.py`: labels come from the policy in its docstring. 400 training tickets plus a **held-out** 40-ticket eval set with different wording and product names.
3. Serve the base model (built-in engine) and try a ticket in the inference playground.
4. Baseline eval with verifiable scorers: **JSON match** (all fields exact) and a **Python reward** (`files/rewards/triage_reward.py`, 0.25 per correct field). Each case opens as a trace.
5. LoRA fine-tune (150 steps) with a live loss curve, then the same eval.
6. Error analysis in the traces, then **round 2** of the data (`--round 2`: broader phrasing, 600 examples, eval set byte-identical), retrain (200 steps), re-evaluate with **agent review** added.
7. **Codex** grades the 40 cases from the IDE terminal over MCP with a scoped credential (blurred on screen).
8. Serve the round-2 model with **vLLM** (adapter merged once), evaluate with 8 parallel requests, compare tokens per second, open the speed tips, and check the playground answer.

## Recorded results (40 held-out tickets)

| | Tickets fully correct | Fields correct | Output tok/s per request | Total tok/s | p50 latency |
|---|---|---|---|---|---|
| Base model, built-in engine | 0% | 26% | 39.1 | 38.7 (1 parallel) | 1.0 s |
| Round 1 (400 examples, 150 steps) | 55% | 87% | 24.5 | 24.2 (1 parallel) | 0.9 s |
| Round 2 (600 examples, 200 steps) | 70% | 91% | 27.4 | 26.9 (1 parallel) | 0.8 s |
| Round 2 on vLLM | 73% | 91% | 35.7 | 72.6 (8 parallel) | 0.6 s |

Codex agent review of round 2: mean 0.81. Training: about 5 min per round on Apple MPS. Numbers come from `assets/results.json`, which the recorder writes from the eval files.

## Notes

- Real UI recording of the browser development target driven by headless Chrome; everything ran locally on Apple Silicon (vLLM via the `vllm-metal` Homebrew build).
- Data is **synthetic** and the eval set is small. The round-2 phrasings were chosen after reading round-1 failures, so round-2 eval scores are somewhat optimistic; keep a second untouched test set and evaluate on real tickets before production.
- Long waits (download, training, evaluations) happen off camera between chapters. Chapters whose recording ran longer than the narration are fast-forwarded (up to 3×, shown with a ▶▶ badge).
- The built-in engine serves unmerged LoRA adapters, so fine-tuned models run slower per request there than the base model; vLLM serves merged weights.
- vLLM's total-throughput gain (2.7×) was lower than in an earlier off-camera run (about 8×), probably because screen recording shared the laptop GPU.
- Claude Code would connect the same way, but its CLI wasn't logged in on this machine, so Codex did the grading. One terminal line is an unrelated error from a Notion MCP server in the local Codex config.
- Narration: local Phonon TTS (`~/Documents/Stillroom`), offline.

## Rebuild

Serve an empty folder at `artifacts/finetune-demo/recording` on port 3120 (launch config `aiide-demo-record`), then:

```sh
python3 source/produce.py audio     # narration; numbers come from assets/results.json once it exists
node source/record.mjs              # drives the IDE and records chapters (about 35 min including training)
python3 source/produce.py audio     # re-narrate with the recorded numbers
python3 source/produce.py fit       # fast-forward over-long chapters
node source/frames.mjs              # caption frames and cards
python3 source/produce.py render    # final MP4
```
