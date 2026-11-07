# House price prediction — notebook vs AI Engineering IDE

`House-Price-Demo.mp4` is a 3 min 20 s, 1920 × 1080 narrated demo (7.2 MB) with 9 chapters, burned-in captions, and an English subtitle track (`house-price-demo.srt`). `narration.md` has the full script.

It trains the same scikit-learn model the "notebook way" and in the IDE, then shows what the IDE adds: live learning curves, overlaying a second run to spot overfitting, saved run history with parameters and evaluations, a per-step trace with jump-to-source, and the saved model linked to its run. The last card compares both approaches, including where Colab is better (free hosted GPUs).

## What actually ran

- The repository's browser development target, driven in headless Chrome against a disposable copy of `project/`.
- `project/train.py`: `GradientBoostingRegressor` trained in 10-tree increments with `warm_start`, logging train/validation RMSE per step.
  - Baseline (200 trees, learning rate 0.1, depth 3): validation R² 0.905, MAE ≈ $37k.
  - Bigger model (300 trees, learning rate 0.2, depth 8): training RMSE ≈ $8k, validation RMSE ≈ $55k (vs ≈ $50k), R² 0.884, i.e. overfitting.
- `project/data/houses.csv`: 12,000 **synthetic** homes from `project/make_dataset.py` (deterministic, no download). Results show the workflow, not real-market accuracy.
- The notebook section is a generic illustration, not a recording of Colab or VS Code.
- Before recording, the environment was installed (`setup`) and Python imports were warmed once. The first import in a fresh environment took ~47 s on this Mac (one-time native library scan), which would otherwise appear as dead air.

Narration: your local Phonon TTS model (`~/Documents/Stillroom/.models/voice-phonon-31m`, voice "Harper"), fully offline.

## Rebuild

With the IDE serving a fresh copy of `project/` at `http://127.0.0.1:3112`:

```sh
python3 source/produce.py audio      # narration + timeline (DEMO_VOICE=… to change voice)
node source/record.mjs               # screen-record UI scenes; scene length = max(narration, recording)
node source/frames.mjs               # caption frames and full-screen cards
python3 source/produce.py render     # final MP4
```

`record.mjs` resets nothing: give it a project copy with no prior runs.
