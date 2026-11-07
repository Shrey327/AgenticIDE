"""Local model/data paths are required; this example never downloads a model implicitly."""
import os
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments, DataCollatorForLanguageModeling
from peft import LoraConfig, get_peft_model
from aiide_sdk.training import trainer_callback, parameters
from aiide_sdk import flush

config = parameters({"steps": 20, "learning_rate": 0.0002, "batch_size": 1, "save_steps": 10})
model_path = os.environ["AIIDE_TRAIN_MODEL_PATH"]
dataset_path = os.environ["AIIDE_TRAIN_DATASET"]
tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token
model = AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True)
model = get_peft_model(model, LoraConfig(task_type="CAUSAL_LM", target_modules="all-linear", r=8, lora_alpha=16))
dataset = load_dataset("json", data_files=dataset_path, split="train")
dataset = dataset.map(lambda row: tokenizer(row["text"], truncation=True, max_length=256), remove_columns=dataset.column_names)
trainer = Trainer(model=model, train_dataset=dataset,
    args=TrainingArguments(output_dir="checkpoints", max_steps=int(config["steps"]), learning_rate=float(config["learning_rate"]), per_device_train_batch_size=int(config["batch_size"]),
        logging_steps=1, save_steps=int(config["save_steps"]), report_to="none"),
    data_collator=DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False), callbacks=[trainer_callback()])
trainer.train(resume_from_checkpoint=os.getenv("AIIDE_RESUME_CHECKPOINT") or None)
flush()
