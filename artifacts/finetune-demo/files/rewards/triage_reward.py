# Verifiable reward for ticket triage: 0.25 per correct field, 0 for invalid JSON.
import json

FIELDS = ['category', 'priority', 'product', 'needs_human']


def score(output, expected, case, tool_calls):
    text = output.strip().removeprefix('```json').removeprefix('```').removesuffix('```').strip()
    try:
        answer = json.loads(text)
    except ValueError:
        return {'score': 0.0, 'reason': 'not valid JSON'}
    if not isinstance(answer, dict):
        return {'score': 0.0, 'reason': 'JSON is not an object'}
    gold = json.loads(expected)
    wrong = [field for field in FIELDS if answer.get(field) != gold[field]]
    reason = 'all fields correct' if not wrong else 'wrong: ' + ', '.join(f'{f}={answer.get(f)!r} (want {gold[f]!r})' for f in wrong)
    return {'score': (len(FIELDS) - len(wrong)) / len(FIELDS), 'reason': reason}
