# House price prediction: notebook vs AI Engineering IDE

Real UI recording of the browser development target on a synthetic dataset. Narration: local Phonon TTS (Harper).

## 00:00:00 — HOUSE PRICE PREDICTION

Let's train a house price model the way most of us do: in a notebook, in Colab or VS Code. Then in AI Engineering IDE. Same data, same scikit-learn code. The difference is everything around the code.

## 00:00:15 — THE NOTEBOOK WAY

In a notebook, you run a cell and read the score it prints. Change a hyperparameter and run it again, and the previous result is overwritten, unless you copied it somewhere. Comparing runs, keeping track of saved models, and remembering what changed is left to you, or to an extra tool like MLflow or Weights and Biases.

## 00:00:37 — 01 / OPEN THE PROJECT

Here, the project opens on Home. The Train a model card tracks what is already set up. The training command is configured and the environment is installed. The next step is to start a training job.

## 00:00:52 — 02 / TRAIN A BASELINE

In Training, choose the train command and set the parameters: two hundred trees, a learning rate of zero point one, and depth three. Start training. Training and validation error stream in while the job runs, instead of appearing only after the cell finishes. It finishes with a validation R squared of zero point nine zero, and the trained model is recorded as an artifact.

## 00:01:19 — 03 / TRY A BIGGER MODEL

Now try a bigger model: three hundred trees, depth eight, and a learning rate of zero point two. Select the baseline as the comparison run. Its curves appear dashed, on the same charts. Training error drops to about eight thousand dollars, far below the baseline. But validation error ends higher, around fifty-five thousand versus fifty thousand. That gap between training and validation is overfitting, and the overlaid curves show it while the job is still running. The final validation R squared drops to zero point eight eight, so the baseline stays.

## 00:01:56 — 04 / KEEP THE HISTORY

In Runs, both experiments are saved with their exact parameters, duration, metrics, and evaluation results. They are still there after restarting the IDE, and you can compare any two side by side.

## 00:02:19 — 05 / SEE WHERE TIME GOES

The trace breaks each run into steps: load the data, split it, fit, evaluate, and save. Select a step to see its timing and attributes, or jump straight to the code that produced it.

## 00:02:36 — 06 / FIND THE MODEL

Back in Training, the saved model is linked to the run that created it. Inspect it to find the exact file, ready to load for inference.

## 00:02:56 — NOTEBOOK VS WORKSPACE

Notebooks are great for quick exploration, and Colab gives you free hosted GPUs. For iterating on a model, this workspace records every run, charts it live, compares experiments, and keeps models traceable, without setting up a separate tracking server. Your code stays plain Python with a few logging calls. The IDE keeps the record.
