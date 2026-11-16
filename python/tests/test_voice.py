import os
from pathlib import Path
import sys
import unittest
import json
import io
import shutil
import tempfile
import threading
import urllib.error
import urllib.request
import wave
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiide_voice import configuration, status, wire_events
from aiide_voice.local_speech import SpeechServer, handler, speak, transcribe


class VoiceTests(unittest.TestCase):
    def test_runtime_status_does_not_require_keys_or_install_anything(self):
        value = status()
        self.assertIsInstance(value['ready'], bool)
        self.assertIn('livekit-agents', value['packages'])

    def test_config_validates_credentials_and_remote_transport(self):
        env = {'LIVEKIT_URL': 'ws://127.0.0.1:7880', 'LIVEKIT_API_KEY': 'devkey', 'LIVEKIT_API_SECRET': 'test-secret'}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(configuration()['agentName'], 'aiide-voice')
        with patch.dict(os.environ, {**env, 'LIVEKIT_URL': 'ws://remote.example'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'WSS'):
                configuration()
        with patch.dict(os.environ, {**env, 'AIIDE_SPEECH_URL': 'http://unsafe.example/v1'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'HTTPS'):
                configuration()
        with patch.dict(os.environ, {'LIVEKIT_URL': 'ws://127.0.0.1:7880'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'credentials'):
                configuration()

    def test_telemetry_hooks_emit_latency_and_content_only_through_sdk(self):
        callbacks = {}
        class Session:
            def on(self, name):
                return lambda callback: callbacks.setdefault(name, callback)
        class Metrics:
            def model_dump(self):
                return {'type': 'llm_metrics', 'ttft': 0.25, 'input_tokens': 4, 'api_key': 'never-export'}
        class Event:
            metrics = Metrics()
        with patch('aiide_sdk.metric') as metric:
            wire_events(Session())
            callbacks['metrics_collected'](Event())
            self.assertEqual(metric.call_count, 2)
            metric.assert_any_call('voice.llm.ttft', 0.25)
            self.assertNotIn('never-export', repr(metric.call_args_list))
        class Handoff:
            type = 'agent_handoff'
        class HandoffEvent:
            item = Handoff()
        with patch('aiide_sdk.span') as span:
            callbacks['conversation_item_added'](HandoffEvent())
            span.assert_not_called()

    def test_local_api_rejects_auth_origin_and_oversized_input_before_engine(self):
        token = 'x' * 32
        server = SpeechServer(('127.0.0.1', 0), handler('mlx', Path('/unused'), None, token))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with self.assertRaises(urllib.error.HTTPError) as failure:
                opener.open(url + '/health')
            self.assertEqual(failure.exception.code, 401)
            failure.exception.close()
            with self.assertRaises(urllib.error.HTTPError) as failure:
                opener.open(urllib.request.Request(url + '/health', headers={'Authorization': 'Bearer ' + token, 'Origin': 'https://untrusted.example'}))
            self.assertEqual(failure.exception.code, 403)
            failure.exception.close()
            with opener.open(urllib.request.Request(url + '/health', headers={'Authorization': 'Bearer ' + token})) as response:
                self.assertTrue(json.load(response)['ready'])
            with self.assertRaises(urllib.error.HTTPError) as failure:
                opener.open(urllib.request.Request(url + '/v1/audio/speech', data=b'{}', headers={'Authorization': 'Bearer ' + token, 'Content-Length': str(17 * 1024 * 1024)}))
            self.assertEqual(failure.exception.code, 413)
            failure.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_local_playback_does_not_wait_for_an_active_transcription(self):
        token, boundary = 'x' * 32, 'speech-test'
        started, finish = threading.Event(), threading.Event()
        def slow_transcription(*_):
            started.set()
            if not finish.wait(5):
                raise TimeoutError('Test transcription was not released')
            return 'recognized speech'
        server = SpeechServer(('127.0.0.1', 0), handler('mlx', Path('/unused'), None, token))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'http://127.0.0.1:{server.server_port}'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\nwaveform\r\n--{boundary}--\r\n').encode()
        result = []
        def transcribe_request():
            request = urllib.request.Request(url + '/v1/audio/transcriptions', data=body,
                headers={'Authorization': 'Bearer ' + token, 'Content-Type': f'multipart/form-data; boundary={boundary}'})
            with urllib.request.urlopen(request, timeout=6) as response:
                result.append(json.load(response)['text'])
        with patch('aiide_voice.local_speech.transcribe', side_effect=slow_transcription), patch('aiide_voice.local_speech.speak', return_value=b'\x01\x00' * 100):
            request_thread = threading.Thread(target=transcribe_request)
            request_thread.start()
            try:
                self.assertTrue(started.wait(2))
                request = urllib.request.Request(url + '/v1/audio/speech', data=b'{"input":"Reply while listening"}',
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=2) as response:
                    self.assertEqual(response.read(), b'\x01\x00' * 100)
                self.assertFalse(finish.is_set())
            finally:
                finish.set()
                request_thread.join(timeout=6)
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
        self.assertEqual(result, ['recognized speech'])

    def test_local_asr_rejects_non_pcm_and_excess_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(wave.Error):
                transcribe(b'not a WAV', directory, 'mlx', '/unused')
            audio = io.BytesIO()
            with wave.open(audio, 'wb') as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000)
                output.writeframes(b'\x00\x00' * (16000 * 61))
            with self.assertRaisesRegex(ValueError, '60 seconds'):
                transcribe(audio.getvalue(), directory, 'mlx', '/unused')

    def test_device_control_sequences_and_oversized_text_are_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as directory, patch('aiide_voice.local_speech.subprocess.run') as run:
            for text in ('[[slnc 100000]]Hello', 'hello]]', 'x' * 4001):
                with self.assertRaisesRegex(ValueError, 'plain speech'):
                    speak(text, directory)
            run.assert_not_called()

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('say' if sys.platform == 'darwin' else 'espeak-ng'), 'local device TTS tools not installed')
    def test_actual_device_tts_produces_pcm(self):
        with tempfile.TemporaryDirectory() as directory:
            pcm = speak('Hello from your local voice agent.', directory)
            self.assertGreater(len(pcm), 24000)
            self.assertEqual(len(pcm) % 2, 0)

    @unittest.skipUnless(os.getenv('AIIDE_VOICE_TEST_MODEL'), 'opt-in local Whisper weights required')
    def test_actual_local_asr_transcribes_device_speech(self):
        with tempfile.TemporaryDirectory() as directory:
            pcm = speak('The weather is sunny today.', directory)
            audio = io.BytesIO()
            with wave.open(audio, 'wb') as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(24000); output.writeframes(pcm)
            engine = os.getenv('AIIDE_VOICE_TEST_ENGINE', 'whisper.cpp' if os.getenv('AIIDE_VOICE_TEST_EXECUTABLE') else 'mlx')
            result = transcribe(audio.getvalue(), directory, engine, os.environ['AIIDE_VOICE_TEST_MODEL'], os.getenv('AIIDE_VOICE_TEST_EXECUTABLE'))
            self.assertIn('weather', result.lower())
            self.assertIn('sunny', result.lower())


if __name__ == '__main__':
    unittest.main()
