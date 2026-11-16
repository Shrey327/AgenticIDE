import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aiide_hf.server import parse_tool_calls, engines
from aiide_eval.__main__ import run


class ServeTests(unittest.TestCase):
    def test_tool_calls_are_split_from_content(self):
        text, calls = parse_tool_calls('<think>hmm</think>Checking.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>')
        self.assertEqual(text, 'Checking.')
        self.assertEqual(calls[0]['function']['name'], 'get_weather')
        self.assertEqual(json.loads(calls[0]['function']['arguments']), {'city': 'Paris'})
        self.assertEqual(parse_tool_calls('plain <tool_call>{bad}</tool_call>'), ('plain <tool_call>{bad}</tool_call>', []))

    def test_builtin_engine_always_available(self):
        self.assertEqual(engines()['transformers'], 'built-in')


class RewardTests(unittest.TestCase):
    def test_reward_function_scores_and_errors_are_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'reward.py'
            file.write_text('def score(output, expected, case, tool_calls):\n'
                            '    if output == "boom": raise ValueError("bad")\n'
                            '    return {"score": 2 if output == expected else 0, "reason": "checked"}\n')
            result = run({'file': str(file), 'cases': [{'output': 'a', 'expected': 'a'}, {'output': 'b', 'expected': 'a'}, {'output': 'boom'}]})
            self.assertEqual([r['score'] for r in result], [1.0, 0.0, 0.0])
            self.assertTrue(result[2]['error'])


if __name__ == '__main__':
    unittest.main()
