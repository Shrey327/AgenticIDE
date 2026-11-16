"""Authenticated loopback speech API using installed local engines; no model downloads."""
from __future__ import annotations

import argparse
from email.parser import BytesParser
from email.policy import default
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import math
import signal
import wave
import threading

LIMIT = 16 * 1024 * 1024


class SpeechServer(ThreadingHTTPServer):
    """Keep transcription from blocking playback without unbounded client threads."""
    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(2)
        super().__init__(*args, **kwargs)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        return connection, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def transcribe(audio, directory, engine, model, executable=None):
    with wave.open(io.BytesIO(audio)) as decoded:
        if decoded.getcomptype() != 'NONE' or decoded.getnchannels() not in (1, 2) or decoded.getsampwidth() != 2 or not 8000 <= decoded.getframerate() <= 48000 or decoded.getnframes() / decoded.getframerate() > 60:
            raise ValueError('Provide PCM16 WAV audio of at most 60 seconds')
    source, wav = Path(directory) / 'upload', Path(directory) / 'input.wav'
    source.write_bytes(audio)
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-ar', '16000', '-ac', '1', str(wav)], check=True, capture_output=True, timeout=30)
    if engine == 'mlx':
        import mlx_whisper
        return mlx_whisper.transcribe(str(wav), path_or_hf_repo=str(model), verbose=False)['text'].strip()
    output = Path(directory) / 'transcript'
    subprocess.run([str(executable), '-m', str(model), '-f', str(wav), '-otxt', '-of', str(output), '-nt', '-ng'], check=True, capture_output=True, timeout=120)
    return output.with_suffix('.txt').read_text(encoding='utf-8').strip()


def speak(text, directory, response_format='pcm'):
    if not isinstance(text, str) or not text.strip() or len(text) > 4000 or '[[' in text or ']]' in text:
        raise ValueError('Use 1–4,000 plain speech characters without device control directives')
    if response_format not in ('pcm', 'wav'):
        raise ValueError('Local speech supports PCM or WAV response_format')
    # A child-side OS file limit bounds generated files before they can exhaust disk.
    limiter = [sys.executable, '-c', f'import resource,os,sys;resource.setrlimit(resource.RLIMIT_FSIZE,({LIMIT},{LIMIT}));os.execvp(sys.argv[1],sys.argv[1:])']
    source = Path(directory) / 'speech.aiff'
    if sys.platform == 'darwin':
        subprocess.run(limiter + ['say', '-o', str(source)], input=text, text=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    else:
        source = source.with_suffix('.wav')
        subprocess.run(limiter + ['espeak-ng', '-w', str(source), '--stdin'], input=text, text=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    duration = float(subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(source)], check=True, capture_output=True, timeout=10).stdout)
    if not math.isfinite(duration) or not 0 < duration <= 60:
        raise ValueError('Local speech output must be at most 60 seconds; split the message')
    output = Path(directory) / ('output.pcm' if response_format == 'pcm' else 'output.wav')
    args = limiter + ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(source), '-ac', '1', '-ar', '24000']
    if response_format == 'pcm':
        args += ['-f', 's16le', str(output)]
    elif response_format == 'wav':
        args += ['-f', 'wav', str(output)]
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    if output.stat().st_size > LIMIT:
        raise ValueError('Generated audio exceeds 16 MB')
    return output.read_bytes()


def handler(engine, model, executable, token):
    transcription = threading.Lock()
    class SpeechHandler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def permitted(self):
            host = self.headers.get('Host', '')
            if host != f'127.0.0.1:{self.server.server_port}' or self.headers.get('Origin'):
                self.send_error(403, 'Host or origin rejected')
                return False
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.send_error(401, 'Authentication required')
                return False
            return True

        def reply(self, status, data, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self.permitted():
                return
            if self.path != '/health':
                return self.send_error(404)
            self.reply(200, json.dumps({'ready': True, 'engine': engine}).encode())

        def do_POST(self):
            if not self.permitted():
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= LIMIT or self.headers.get('Transfer-Encoding'):
                    return self.send_error(413, 'Use a bounded Content-Length body below 16 MB')
                self.connection.settimeout(15)
                body = self.rfile.read(length)
                if len(body) != length:
                    return self.send_error(400, 'Incomplete request')
                with tempfile.TemporaryDirectory(prefix='aiide-speech-') as directory:
                    if self.path == '/v1/audio/transcriptions':
                        content_type = self.headers.get('Content-Type', '')
                        if not content_type.startswith('multipart/form-data;'):
                            raise ValueError('Expected multipart audio upload')
                        message = BytesParser(policy=default).parsebytes(('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + body)
                        files = [part.get_payload(decode=True) for part in message.iter_parts() if part.get_param('name', header='content-disposition') == 'file']
                        if len(files) != 1 or not files[0]:
                            raise ValueError('Provide one nonempty audio file')
                        if not transcription.acquire(blocking=False):
                            return self.send_error(429, 'A transcription is already active')
                        try:
                            text = transcribe(files[0], directory, engine, model, executable)
                        finally:
                            transcription.release()
                        self.reply(200, json.dumps({'text': text}).encode())
                    elif self.path == '/v1/audio/speech':
                        data = json.loads(body)
                        text = data.get('input')
                        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
                            raise ValueError('Provide 1–4,000 speech characters')
                        audio = speak(text, directory, data.get('response_format', 'pcm'))
                        self.reply(200, audio, 'audio/pcm' if data.get('response_format', 'pcm') == 'pcm' else 'audio/wav')
                    else:
                        self.send_error(404)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                return
            except (ValueError, TypeError, KeyError, wave.Error) as error:
                # Engine errors can contain user paths/text; return a bounded operational error.
                self.reply(400, json.dumps({'error': {'message': f'Local speech failed ({type(error).__name__}); inspect engine setup and audio format.'}}).encode())
            except Exception as error:
                print(f'Local speech engine failure: {type(error).__name__}', file=sys.stderr, flush=True)
                self.reply(500, json.dumps({'error': {'message': 'Local speech engine failed; inspect its run and installed model/tools.'}}).encode())
    return SpeechHandler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=['mlx', 'whisper.cpp'], required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--executable', type=Path)
    parser.add_argument('--port', type=int, default=8099)
    args = parser.parse_args()
    token = os.environ.get('AIIDE_LOCAL_SPEECH_TOKEN', '')
    if len(token) < 32:
        raise ValueError('Set a random AIIDE_LOCAL_SPEECH_TOKEN of at least 32 characters')
    if not args.model.exists() or args.model.is_symlink():
        raise ValueError('Provide an existing local model; network model downloads are disabled')
    if args.engine == 'mlx' and (sys.platform != 'darwin' or not args.model.is_dir()):
        raise ValueError('MLX requires Apple Silicon and a local MLX Whisper model directory')
    if args.engine == 'whisper.cpp' and (not args.model.is_file() or not args.executable or not args.executable.is_file()):
        raise ValueError('whisper.cpp requires a local model file and executable')
    if not all(shutil.which(tool) for tool in ('ffmpeg', 'ffprobe', 'say' if sys.platform == 'darwin' else 'espeak-ng')):
        raise ValueError('Install ffmpeg/ffprobe and device TTS (say on macOS, espeak-ng on Linux) first')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    server = SpeechServer(('127.0.0.1', args.port), handler(args.engine, args.model.resolve(), args.executable, token))
    def stop(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    print(f'Local speech ready on 127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
