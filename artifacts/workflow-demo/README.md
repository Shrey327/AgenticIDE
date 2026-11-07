# AI Engineering IDE — workflow demo

`AI-Engineering-IDE-Workflow-Demo.mp4` is a narrated, captioned 1920 × 1080 workflow video, 3 minutes 34 seconds long (9.4 MB). It includes chapter markers and an English subtitle track. The captions are also burned into the picture; `workflow-demo.srt` is available separately.

The story follows an AI engineer opening a project, running a baseline, diagnosing a retrieval mistake through nested traces, jumping to source, running a prepared improvement, comparing evaluations, attaching run context to the assistant, and training/resuming a small PyTorch model.

## What actually ran

- The repository's browser development target, using its actual Theia engineering panels and backend, in a disposable project beneath `/tmp`.
- A dependency-free, deterministic retrieval example: first-chunk selection scores 0; keyword ranking scores 1 on the same single question. These are executed sample results, not a language-model benchmark.
- The repository's PyTorch regression template on CPU, including emitted learning curves, checkpoint inspection, and a resumed run.
- Document chunk preview in the RAG panel.

The assistant context is attached and a prompt is drafted, but no model request is sent. The Models and RAG sections explain configuration; no model endpoint, embedding service, or Qdrant database is connected. No remote SSH, GPU, or W&B execution is demonstrated.

## Files

- `narration.md`: full spoken script with chapter timestamps.
- `workflow-demo.srt`: standalone English captions.
- `preview.png`: poster image.
- `source/`: sample Python code, chapter script, and local capture/render helpers.
- `assets/`: original screen recordings, narration audio, caption frames, and intermediate chapter videos.

Narration was generated locally with the macOS Daniel voice. Graphics use system fonts and CSS; no stock media or external music is included. Existing project files were not changed.

The production helpers use the installed Puppeteer and FFmpeg. `produce.py audio` generates narration/timing, `frames.mjs` renders chapter/caption frames through the capture browser, and `produce.py render` assembles the final MP4. `control.mjs` drives the disposable IDE through the capture browser's loopback debugging port; it is a production helper, not an application feature.

## Verification

The complete MP4 decoded without errors and played successfully in Chrome. Its streams contain 1080p H.264 video, 48 kHz AAC narration, English subtitles, 13 chapters, and 38 caption cues. The retrieval fixture's assertions passed. The recorded PyTorch job completed step 12 with loss 0.359151; checkpoint resume continued through step 24 with loss 0.064796. These small synthetic results demonstrate the workflow, not production model quality.
