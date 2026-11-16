import asyncio
import http.server
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiide_voice import RETRY_POLICY, chat_provider, report_provider_error, status


class ProviderTelemetryTests(unittest.TestCase):
    def test_provider_failure_evidence_never_includes_exception_or_provider_payload(self):
        class Error:
            type = 'llm_error'
            recoverable = True
            error = RuntimeError('Authorization: Bearer secret-that-must-not-leak')
        health = []
        with patch('aiide_sdk.metric') as metric, patch('aiide_sdk.span') as span:
            report_provider_error(Error(), health.append)
            self.assertEqual(health, [{'state': 'retrying', 'component': 'llm_error'}])
            self.assertNotIn('secret-that-must-not-leak', repr(span.call_args_list))
            metric.assert_called_once_with('voice.provider_errors', 1)
        self.assertEqual(status()['retryPolicy']['maxRetries'], 2)


@unittest.skipUnless(status()['ready'], 'optional pinned LiveKit environment required')
class ProviderReliabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from livekit.agents import APIConnectOptions, llm
        self.requests = 0
        self.mode = 'recover'
        self.release = threading.Event()
        self.received = threading.Event()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                owner.requests += 1
                owner.received.set()
                if owner.mode == 'hang':
                    owner.release.wait(5)
                    return
                if owner.mode == 'permanent' or (owner.mode == 'recover' and owner.requests == 1):
                    self.send_response(503)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(b'{"error":{"message":"temporary outage"}}')
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                if owner.mode == 'partial':
                    self.send_header('Content-Length', '100000')
                self.end_headers()
                value = {'id': 'test', 'object': 'chat.completion.chunk', 'model': 'fixture',
                         'choices': [{'index': 0, 'delta': {'content': 'Recovered reply'}, 'finish_reason': None}]}
                self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
                self.wfile.flush()
                if owner.mode == 'partial':
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                else:
                    self.wfile.write(b'data: [DONE]\n\n')

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.policy = patch.dict(RETRY_POLICY, requestTimeoutSeconds=0.2, retryIntervalSeconds=0.01)
        self.policy.start()
        self.key = patch.dict(os.environ, AIIDE_VOICE_CHAT_KEY='local-fixture')
        self.key.start()
        self.health = []
        self.model = chat_provider({'chatModel': 'fixture', 'chatUrl': f'http://127.0.0.1:{self.server.server_port}/v1'})
        self.model.on('error', lambda error: report_provider_error(error, self.health.append) if error.recoverable else None)
        self.context = llm.ChatContext.empty()
        self.context.add_message(role='user', content='Exercise provider recovery')
        self.options = APIConnectOptions(max_retry=2, retry_interval=0.01, timeout=0.2)

    async def asyncTearDown(self):
        await self.model.aclose()
        self.release.set()
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close()
        self.thread.join(timeout=2)
        self.policy.stop()
        self.key.stop()

    async def reply(self):
        text = ''
        async with self.model.chat(chat_ctx=self.context, conn_options=self.options) as stream:
            async for chunk in stream:
                if chunk.delta and chunk.delta.content:
                    text += chunk.delta.content
        return text

    async def test_real_sdk_recovers_from_transient_503_without_duplicate_reply(self):
        self.assertEqual(await self.reply(), 'Recovered reply')
        self.assertEqual(self.requests, 2)
        self.assertEqual(self.health, [{'state': 'retrying', 'component': 'llm_error'}])

    async def test_real_sdk_exhausts_exactly_three_attempts(self):
        self.mode = 'permanent'
        with self.assertRaises(Exception):
            await self.reply()
        self.assertEqual(self.requests, 3)
        self.assertEqual(len(self.health), 2)

    async def test_real_sdk_bounds_an_unresponsive_provider(self):
        self.mode = 'hang'
        started = time.monotonic()
        with self.assertRaises(Exception):
            await self.reply()
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(self.requests, 3)

    async def test_real_sdk_never_replays_a_partially_delivered_reply(self):
        self.mode = 'partial'
        chunks = []
        with self.assertRaises(Exception):
            async with self.model.chat(chat_ctx=self.context, conn_options=self.options) as stream:
                async for chunk in stream:
                    if chunk.delta and chunk.delta.content:
                        chunks.append(chunk.delta.content)
        self.assertEqual(chunks, ['Recovered reply'])
        self.assertEqual(self.requests, 1)

    async def test_real_sdk_cancellation_stops_pending_request_without_retries(self):
        self.mode = 'hang'
        pending = asyncio.create_task(self.reply())
        self.assertTrue(await asyncio.to_thread(self.received.wait, 2))
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        await asyncio.sleep(0.1)
        self.assertEqual(self.requests, 1)


if __name__ == '__main__':
    unittest.main()
