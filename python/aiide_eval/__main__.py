"""Run a workspace reward function over evaluation outputs.

stdin: {"file": "/abs/path/reward.py", "cases": [{"output", "expected", "case", "tool_calls"}]}
The file defines score(output, expected, case, tool_calls) -> float | bool | {"score", "reason"}.
"""
import json
import math
import runpy
import sys
from pathlib import Path


def normalize(value):
    reason = None
    if isinstance(value, dict):
        reason = value.get('reason')
        value = value.get('score')
    if isinstance(value, bool):
        value = float(value)
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('score() must return a number, bool, or {"score": number, "reason": str}')
    return {'score': min(1.0, max(0.0, float(value))), 'reason': None if reason is None else str(reason)[:2000]}


def run(request):
    file = Path(request['file'])
    sys.path.insert(0, str(file.parent))
    function = runpy.run_path(str(file)).get('score')
    if not callable(function):
        raise ValueError(f'{file.name} must define score(output, expected, case, tool_calls)')
    results = []
    for item in request['cases']:
        try:
            results.append(normalize(function(output=item['output'], expected=item.get('expected'),
                                              case=item.get('case'), tool_calls=item.get('tool_calls') or [])))
        except Exception as error:
            results.append({'score': 0.0, 'reason': f'{type(error).__name__}: {error}'[:2000], 'error': True})
    return results


def main():
    try:
        print(json.dumps({'ok': True, 'result': run(json.load(sys.stdin))}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))


if __name__ == '__main__':
    main()
