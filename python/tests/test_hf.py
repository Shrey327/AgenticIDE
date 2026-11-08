import json
import io
from contextlib import redirect_stdout
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiide_hf.__main__ import local, read_data, main


class HubValidationTests(unittest.TestCase):
    def test_status_uses_subprocess_response_envelope(self):
        output = io.StringIO()
        with patch('sys.argv', ['aiide_hf', 'status']), patch('aiide_hf.__main__.status', return_value={'ready': True}), redirect_stdout(output):
            main()
        self.assertEqual(json.loads(output.getvalue()), {'ok': True, 'result': {'ready': True}})

    def test_dataset_validation_and_path_boundary(self):
        with tempfile.TemporaryDirectory() as directory, patch('pathlib.Path.cwd', return_value=Path(directory)):
            file = Path(directory) / 'data.jsonl'
            file.write_text('{"text":"two tokens"}\n\n')
            self.assertEqual(read_data('data.jsonl'), [{'text': 'two tokens'}])
            for content in ['', '{}', 'not json', '{"text":" "}']:
                file.write_text(content)
                with self.assertRaises(ValueError):
                    read_data('data.jsonl')
            with self.assertRaises(ValueError):
                local('../outside.jsonl')
            (Path(directory) / 'link.jsonl').symlink_to('/etc/hosts')
            with self.assertRaises(ValueError):
                read_data('link.jsonl')


if __name__ == '__main__':
    unittest.main()
