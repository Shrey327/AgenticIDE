import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time


def local(value):
    root = Path.cwd().resolve()
    path = (root / value).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Path must be inside the workspace')
    return path


def status():
    missing = [name for name in ['torch', 'transformers', 'peft', 'datasets', 'accelerate', 'huggingface_hub'] if importlib.util.find_spec(name) is None]
    devices = ['cpu']
    if 'torch' not in missing:
        import torch
        if torch.backends.mps.is_available():
            devices.append('mps')
        if torch.cuda.is_available():
            devices.append('cuda')
    from .server import engines
    return {'ready': not missing, 'missing': missing, 'devices': devices, 'python': sys.executable, 'engines': engines()}


def choose_device(requested):
    import torch
    if requested == 'auto':
        return 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
    if requested not in status()['devices']:
        raise ValueError(f'{requested} is unavailable; choose CPU or an available accelerator')
    return requested


def read_data(file):
    path = local(file)
    if path.suffix.lower() != '.jsonl' or path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError('Choose a JSONL dataset up to 50 MB')
    rows = []
    with path.open() as stream:
        for number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError as error:
                raise ValueError(f'Invalid JSON on dataset line {number}') from error
            if not isinstance(row, dict) or not isinstance(row.get('text'), str) or not row['text'].strip():
                raise ValueError(f'Dataset line {number} needs a nonempty "text" field')
            rows.append({'text': row['text']})
            if len(rows) > 100000:
                raise ValueError('Dataset exceeds 100,000 rows')
    if not rows:
        raise ValueError('Dataset is empty')
    return rows


def metadata(directory):
    value = json.loads((directory / 'aiide-model.json').read_text())
    if value.get('format') != 'aiide-hf-v1':
        raise ValueError('Select a model downloaded or trained by the IDE')
    return value


def download(config):
    from huggingface_hub import HfApi, snapshot_download
    directory = local(config['output'])
    directory.mkdir(parents=True, exist_ok=False)
    info = HfApi().model_info(config['repo'], revision=config['revision'], token=False)
    print(f'Downloading {config["repo"]} at {info.sha}', flush=True)
    snapshot_download(config['repo'], revision=info.sha, local_dir=directory, token=False,
                      allow_patterns=['*.json', '*.safetensors', '*.model', '*.txt', '*.tiktoken', '*.jinja'],
                      max_workers=4)
    if not (directory / 'config.json').is_file() or not list(directory.glob('*.safetensors')):
        raise ValueError('Choose a Transformers causal language model with safetensors weights')
    result = {'format': 'aiide-hf-v1', 'kind': 'base', 'repo': config['repo'], 'revision': info.sha, 'created': int(time.time() * 1000)}
    (directory / 'aiide-model.json').write_text(json.dumps(result))
    from aiide_sdk import artifact
    artifact('downloaded model', config['output'], repo=config['repo'], revision=info.sha)
    return result


def load_model(config, train=False):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    source = local(config['model'])
    meta = metadata(source)
    base = local(meta['base']) if meta['kind'] == 'adapter' else source
    target = choose_device(config.get('device', 'auto'))
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    if tokenizer.pad_token is None:
        raise ValueError('Model tokenizer must define a pad or EOS token')
    model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False,
                                                use_safetensors=True, torch_dtype=torch.float32 if target == 'cpu' else torch.bfloat16)
    if meta['kind'] == 'adapter':
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, source, local_files_only=True, is_trainable=train)
    model.to(target)
    return model, tokenizer, target, meta


def train(config):
    from datasets import Dataset
    from transformers import Trainer, TrainingArguments, DataCollatorForLanguageModeling, set_seed
    from peft import LoraConfig, get_peft_model
    from aiide_sdk import artifact
    from aiide_sdk.training import trainer_callback
    rows = read_data(config['dataset'])
    set_seed(42)
    model, tokenizer, device, meta = load_model(config, train=True)
    if meta['kind'] != 'base':
        raise ValueError('Choose a base model to start a new LoRA fine-tune')
    model = get_peft_model(model, LoraConfig(task_type='CAUSAL_LM', target_modules='all-linear', r=config['rank'], lora_alpha=2 * config['rank']))
    dataset = Dataset.from_list(rows).map(lambda row: tokenizer(row['text'], truncation=True, max_length=config['maxLength']), remove_columns=['text'])
    if any(len(row['input_ids']) < 2 for row in dataset):
        raise ValueError('Each training example must tokenize to at least two tokens')
    output = local(config['output'])
    output.mkdir(parents=True, exist_ok=False)
    trainer = Trainer(model=model, train_dataset=dataset,
        args=TrainingArguments(output_dir=str(output / 'checkpoints'), max_steps=config['steps'], learning_rate=config['learningRate'],
            per_device_train_batch_size=config['batchSize'], logging_steps=1, save_strategy='no', report_to='none', use_cpu=device == 'cpu',
            dataloader_pin_memory=False, seed=42),
        data_collator=DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False), callbacks=[trainer_callback()])
    trained = trainer.train()
    if not math.isfinite(trained.training_loss):
        raise ValueError("Training loss is not finite; check data and reduce the learning rate")
    model.save_pretrained(output, safe_serialization=True)
    tokenizer.save_pretrained(output)
    result = {'format': 'aiide-hf-v1', 'kind': 'adapter', 'base': config['model'], 'repo': meta['repo'], 'revision': meta['revision'],
              'created': int(time.time() * 1000), 'device': device, 'steps': config['steps'], 'loss': trained.training_loss, 'config': config}
    (output / 'aiide-model.json').write_text(json.dumps(result))
    artifact('LoRA adapter', config['output'], framework='transformers', steps=config['steps'])
    return result


def generate(config):
    import torch
    from aiide_sdk import metric
    model, tokenizer, device, _ = load_model(config)
    text = tokenizer.apply_chat_template([{'role': 'user', 'content': config['prompt']}], tokenize=False, add_generation_prompt=True, enable_thinking=False) if tokenizer.chat_template else config['prompt']
    inputs = tokenizer(text, return_tensors='pt', truncation=True, max_length=2048).to(device)
    model.eval()
    started = time.monotonic()
    with torch.inference_mode():
        tokens = model.generate(**inputs, max_new_tokens=config['maxNewTokens'], do_sample=False, pad_token_id=tokenizer.pad_token_id)
    count = tokens.shape[-1] - inputs.input_ids.shape[-1]
    elapsed = time.monotonic() - started
    result = {'text': tokenizer.decode(tokens[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True), 'device': device, 'tokens': count, 'seconds': elapsed}
    output = local(config['output'])
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as stream:
        json.dump(result, stream)
    os.chmod(output, 0o600)
    metric('generation.tokens', count)
    metric('generation.seconds', elapsed)
    return {key: value for key, value in result.items() if key != 'text'}


def main():
    mode = sys.argv[1]
    if mode == 'status':
        print(json.dumps({"ok": True, "result": status()}))
        return
    config = json.loads(os.environ['AIIDE_HF_CONFIG'])
    try:
        if mode == 'serve':
            from .server import serve
            return serve(config, local, metadata, load_model)
        result = {'download': download, 'train': train, 'generate': generate}[mode](config)
        print(json.dumps(result), flush=True)
    finally:
        from aiide_sdk import flush
        flush()


if __name__ == '__main__':
    main()
