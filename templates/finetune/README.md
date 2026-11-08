# finetune example

Created by AI Engineering IDE. Run `uv sync --locked`, then use Runs → example.
The `aiide_sdk` directory is copied here by the IDE so this project remains portable.
Model-based examples read `AIIDE_MODEL_URL`, `AIIDE_MODEL_NAME`, and optional `AIIDE_MODEL_KEY`.
RAG also reads `QDRANT_URL` and `AIIDE_EMBEDDING_MODEL`.

## No-code Hub workflow

Open **Train → Hugging Face & fine-tuning**, install the locked project environment,
then download a public model such as `Qwen/Qwen3-0.6B`. Select the included
`data/train.jsonl` and **Run one-step smoke test** to check your environment.
This four-example sample verifies the workflow; it is not a useful training dataset.
Replace it with your own JSONL text examples for real fine-tuning. Choose the saved
LoRA adapter in the model selector to test generation. Base weights remain unchanged.
