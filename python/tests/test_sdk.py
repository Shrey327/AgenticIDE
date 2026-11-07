import asyncio
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import aiide_sdk as sdk


class TelemetryTests(unittest.TestCase):
    def test_nested_spans_and_error(self):
        emitted = []
        with patch.object(sdk, "_send", side_effect=lambda route, body, **kw: emitted.append(body)):
            with sdk.span("root"):
                with self.assertRaises(ValueError):
                    with sdk.span("child"):
                        raise ValueError("secret should not become exception text")
        child, root = [b["resourceSpans"][0]["scopeSpans"][0]["spans"][0] for b in emitted]
        self.assertEqual(child["traceId"], root["traceId"])
        self.assertEqual(child["parentSpanId"], root["spanId"])
        self.assertEqual(child["status"]["code"], 2)
        self.assertNotIn("secret should", str(child))

    def test_async_contexts_do_not_cross(self):
        emitted = []
        async def job(name):
            with sdk.span(name):
                await asyncio.sleep(0)
                with sdk.span(name + ".child"):
                    pass
        async def run():
            await asyncio.gather(job("a"), job("b"))
        with patch.object(sdk, "_send", side_effect=lambda route, body, **kw: emitted.append(body)):
            asyncio.run(run())
        spans = {b["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"]: b["resourceSpans"][0]["scopeSpans"][0]["spans"][0] for b in emitted}
        self.assertNotEqual(spans["a"]["traceId"], spans["b"]["traceId"])
        self.assertEqual(spans["a.child"]["parentSpanId"], spans["a"]["spanId"])

    def test_invalid_metric_is_not_exported(self):
        with patch.object(sdk, "_send") as send:
            sdk.metric("bad", float("nan"))
            send.assert_not_called()

    def test_training_logs_scalars(self):
        from aiide_sdk.training import log_training
        with patch.object(sdk, "_send") as send:
            log_training({"loss": 0.4}, 12)
            event = send.call_args.args[1]["events"][0]
            self.assertEqual((event["name"], event["step"], event["value"]), ("loss", 12, 0.4))



class TrainingSpoolTests(unittest.TestCase):
    def test_spool_redacts_content_before_disk_and_enforces_budget(self):
        import tempfile
        import json
        from aiide_sdk import spool
        with tempfile.TemporaryDirectory() as directory:
            file = str(pathlib.Path(directory) / 'events.jsonl')
            body = {'events': [{'kind': 'evaluation', 'value': {'actual': 'private', 'api_key': 'hidden', 'score': 1}}]}
            self.assertTrue(spool.append(file, '/events', body))
            record = json.loads(pathlib.Path(file).read_text())
            self.assertEqual(record['body']['events'][0]['value'], {'actual': '[CONTENT DISABLED]', 'api_key': '[REDACTED]', 'score': 1})
            with patch.object(spool, 'LIMIT', 1):
                self.assertFalse(spool.append(file, '/events', body))

    def test_gpu_unavailable_is_not_reported_as_zero(self):
        from aiide_sdk.training import log_system
        with patch('subprocess.check_output', side_effect=FileNotFoundError), patch.object(sdk, '_send') as send:
            log_system(1)
            events = [call.args[1]['events'][0] for call in send.call_args_list]
        self.assertFalse(any(e['name'].endswith('temperature_c') for e in events))
        self.assertEqual([e for e in events if e['kind'] == 'hardware'][0]['value']['gpuStatus'], 'unavailable')

    def test_supported_gpu_measurements_preserve_units_and_missing_values(self):
        from aiide_sdk.training import log_system
        with patch('subprocess.check_output', return_value='0, 82, 1024, 8192, 64\n1, N/A, 512, 4096, N/A\n'), patch.object(sdk, '_send') as send:
            log_system(5)
            events = [call.args[1]['events'][0] for call in send.call_args_list]
        metrics = {e['name']: e['value'] for e in events if e['kind'] == 'metric'}
        self.assertEqual(metrics['gpu.0.temperature_c'], 64)
        self.assertEqual(metrics['gpu.0.memory_used_mb'], 1024)
        self.assertNotIn('gpu.1.temperature_c', metrics)

if __name__ == "__main__": unittest.main()
