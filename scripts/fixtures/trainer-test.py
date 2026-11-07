"""Tiny real Transformers training/checkpoint test; no pretrained weights or token downloads."""
import os
import torch
from transformers import GPT2Config, GPT2LMHeadModel, Trainer, TrainingArguments
from aiide_sdk import flush
from aiide_sdk.training import trainer_callback, parameters

torch.set_num_threads(1)
torch.manual_seed(42)
config = parameters({'steps': 2})
model = GPT2LMHeadModel(GPT2Config(vocab_size=32, n_positions=16, n_embd=16, n_layer=1, n_head=2, bos_token_id=1, eos_token_id=2))
data = [{'input_ids': torch.tensor([1, 4, 5, 6, 7, 8, 9, 2]), 'labels': torch.tensor([1, 4, 5, 6, 7, 8, 9, 2])} for _ in range(8)]
trainer = Trainer(model=model, train_dataset=data, args=TrainingArguments(output_dir='hf-checkpoints', max_steps=int(config['steps']), per_device_train_batch_size=2, logging_steps=1, save_steps=2, report_to='none', use_cpu=True, disable_tqdm=True), callbacks=[trainer_callback()])
trainer.train(resume_from_checkpoint=os.getenv('AIIDE_RESUME_CHECKPOINT') or None)
flush()
