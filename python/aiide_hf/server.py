"""Serve a downloaded or fine-tuned model behind an OpenAI-compatible API.

The built-in engine uses Transformers + PEFT directly, so any model the IDE can
train can be served without extra packages. External engines (vLLM, SGLang,
MLX) replace this process after an adapter is merged into full weights.
"""
import importlib.util
import json
import os
import re
import secrets
import shutil
import sys
import time
from pathlib import Path

# engine id -> (python module, command on PATH)
ENGINES = {
    'vllm': ('vllm', 'vllm'),
    'sglang': ('sglang', None),
    'mlx': ('mlx_lm', 'mlx_lm.server'),
}
TOOL_CALL = re.compile(r'<tool_call>\s*(\{.*?\})\s*</tool_call>', re.S)
THINK = re.compile(r'<think>(.*?)</think>', re.S)


def engines():
    found = {'transformers': 'built-in'}
    for name, (module, command) in ENGINES.items():
        if importlib.util.find_spec(module):
            found[name] = 'python'
        elif command and shutil.which(command):
            found[name] = 'command'
    return found


def parse_tool_calls(text):
    """Split model text into content and OpenAI tool calls (Hermes/Qwen <tool_call> format)."""
    text = THINK.sub('', text).strip()
    calls = []
    for match in TOOL_CALL.finditer(text):
        try:
            call = json.loads(match.group(1))
        except ValueError:
            continue
        if not isinstance(call, dict) or not isinstance(call.get('name'), str):
            continue
        arguments = call.get('arguments', {})
        calls.append({'id': 'call_' + secrets.token_hex(6), 'type': 'function',
                      'function': {'name': call['name'],
                                   'arguments': arguments if isinstance(arguments, str) else json.dumps(arguments)}})
    if calls:
        text = TOOL_CALL.sub('', text).strip()
    return text, calls


def engine_command(engine, model, port, name, repo=''):
    module, command = ENGINES[engine]
    available = engines().get(engine)
    if not available:
        raise ValueError(f'{engine} is not installed in the project environment or on PATH')
    python = available == 'python'
    host = ['--host', '127.0.0.1', '--port', str(port)]
    qwen = 'qwen' in repo.lower()
    if engine == 'vllm':
        base = [sys.executable, '-m', 'vllm.entrypoints.openai.api_server', '--model', model] if python else [command, 'serve', model]
        return base + host + ['--served-model-name', name] + (['--enable-auto-tool-choice', '--tool-call-parser', 'hermes'] if qwen else [])
    if engine == 'sglang':
        return [sys.executable, '-m', 'sglang.launch_server', '--model-path', model, '--served-model-name', name] + host + (['--tool-call-parser', 'qwen25'] if qwen else [])
    return ([sys.executable, '-m', 'mlx_lm.server'] if python else [command]) + ['--model', model] + host


def merged(source, base):
    """Merge a LoRA adapter into full weights once; cached beside the adapter."""
    target = source / 'merged'
    if (target / 'config.json').is_file():
        return target
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    print('Merging LoRA adapter into full weights for the external engine…', flush=True)
    model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False,
                                                 use_safetensors=True, torch_dtype=torch.bfloat16)
    model = PeftModel.from_pretrained(model, source, local_files_only=True).merge_and_unload()
    staging = source / f'.merged-{secrets.token_hex(4)}'
    model.save_pretrained(staging, safe_serialization=True)
    AutoTokenizer.from_pretrained(base, local_files_only=True).save_pretrained(staging)
    staging.rename(target)
    return target


def serve(config, local, metadata, load_model):
    engine, port, name = config['engine'], int(config['port']), config['name']
    if engine != 'transformers':
        source = local(config['model'])
        meta = metadata(source)
        path = merged(source, local(meta['base'])) if meta['kind'] == 'adapter' else source
        command = engine_command(engine, str(path.relative_to(Path.cwd())), port, name, meta.get('repo', ''))
        print('Starting ' + ' '.join(command), flush=True)
        from aiide_sdk import flush
        flush()
        os.execvp(command[0], command)
    serve_builtin(config, load_model, port, name)


def serve_builtin(config, load_model, port, name):
    import threading
    import torch
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    model, tokenizer, device, _ = load_model(config)
    model.eval()
    lock = threading.Lock()

    def complete(body):
        if body.get('stream'):
            raise ValueError('The built-in engine does not stream; send stream: false')
        messages = body.get('messages')
        if not isinstance(messages, list) or not messages:
            raise ValueError('messages must be a nonempty list')
        tools = body.get('tools') or None
        switches = {'enable_thinking': False, **(body.get('chat_template_kwargs') or {})}
        prompt = tokenizer.apply_chat_template(messages, tools=tools, tokenize=False, add_generation_prompt=True,
                                               **switches) if tokenizer.chat_template else \
            '\n'.join(str(m.get('content') or '') for m in messages)
        inputs = tokenizer(prompt, return_tensors='pt').to(device)
        limit = max(1, min(int(body.get('max_tokens') or body.get('max_completion_tokens') or 256), 4096))
        temperature = float(body.get('temperature') or 0)
        options = {'max_new_tokens': limit, 'pad_token_id': tokenizer.pad_token_id, 'do_sample': temperature > 0}
        if temperature > 0:
            options.update(temperature=temperature, top_p=float(body.get('top_p') or 1))
        with lock, torch.inference_mode():
            tokens = model.generate(**inputs, **options)
        generated = tokens[0][inputs.input_ids.shape[-1]:]
        text = tokenizer.decode(generated, skip_special_tokens=True)
        thought = THINK.search(text)
        content, calls = parse_tool_calls(text)
        message = {'role': 'assistant', 'content': content or (None if calls else '')}
        if thought and thought.group(1).strip():
            message['reasoning_content'] = thought.group(1).strip()
        if calls:
            message['tool_calls'] = calls
        prompt_tokens, completion_tokens = int(inputs.input_ids.shape[-1]), int(generated.shape[-1])
        return {'id': 'chatcmpl-' + secrets.token_hex(8), 'object': 'chat.completion', 'created': int(time.time()), 'model': name,
                'choices': [{'index': 0, 'message': message,
                             'finish_reason': 'tool_calls' if calls else 'length' if completion_tokens >= limit else 'stop'}],
                'usage': {'prompt_tokens': prompt_tokens, 'completion_tokens': completion_tokens,
                          'total_tokens': prompt_tokens + completion_tokens}}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.rstrip('/') == '/v1/models':
                return self.reply(200, {'object': 'list', 'data': [{'id': name, 'object': 'model', 'owned_by': 'aiide'}]})
            self.reply(404, {'error': {'message': 'Not found'}})

        def do_POST(self):
            if self.path.rstrip('/') != '/v1/chat/completions':
                return self.reply(404, {'error': {'message': 'Not found'}})
            length = int(self.headers.get('Content-Length') or 0)
            if length > 4 * 1024 * 1024:
                return self.reply(413, {'error': {'message': 'Request too large'}})
            try:
                result = complete(json.loads(self.rfile.read(length)))
            except Exception as error:
                return self.reply(400, {'error': {'message': str(error)}})
            self.reply(200, result)

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Serving {name} on http://127.0.0.1:{port}/v1 ({device})', flush=True)
    server.serve_forever()
