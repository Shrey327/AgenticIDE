import json
import pathlib
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from aiide_runtime import remote


class RemoteJournalTests(unittest.TestCase):
    def test_poll_bounds_response_bytes_without_skipping_records(self):
        with tempfile.TemporaryDirectory() as root:
            job = str(uuid.uuid4())
            directory = pathlib.Path(root) / '.aiide/jobs' / job
            directory.mkdir(parents=True)
            (directory / 'status.json').write_text(json.dumps({'status': 'completed'}))
            record = json.dumps({'body': {'value': 'x' * 700}}) + '\n'
            (directory / 'events.jsonl').write_text(record * 3)
            request = {'root': root, 'id': job, 'action': 'poll', 'cursor': 0}
            with patch.object(remote, 'POLL_BYTES', 1024):
                for index in range(3):
                    result = remote.main(request)
                    self.assertEqual(len(result['records']), 1)
                    self.assertEqual(result['cursor'], len(record) * (index + 1))
                    self.assertEqual(result['hasMore'], index < 2)
                    request['cursor'] = result['cursor']


if __name__ == '__main__':
    unittest.main()
