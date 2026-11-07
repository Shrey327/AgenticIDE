"""Read-only W&B public API bridge. Credentials arrive through stdin, never argv."""
import contextlib
import itertools
import json
import math
import os
import sys
from urllib.parse import urlparse


def main(request):
    import requests
    from aiide_sdk.spool import redact
    base = request['url'].rstrip('/')
    expected = urlparse(base + '/graphql')
    original = requests.Session.request

    def readonly(self, method, url, **kwargs):
        parsed = urlparse(url)
        body = kwargs.get('json')
        if body is None and kwargs.get('data'):
            body = json.loads(kwargs['data'])
        query = (body or {}).get('query', '')
        if method.upper() != 'POST' or (parsed.scheme, parsed.netloc, parsed.path) != (expected.scheme, expected.netloc, expected.path) or 'mutation' in query.lower() or not query:
            raise ValueError('W&B reader permits only GraphQL queries to the configured endpoint')
        kwargs['allow_redirects'] = False
        return original(self, method, url, **kwargs)

    requests.Session.request = readonly
    import wandb
    if wandb.__version__ != '0.23.0':
        raise ValueError('Install the pinned W&B reader before connecting')
    api = wandb.Api(api_key=request['secret'], overrides={'base_url': base}, timeout=10)
    operation = request['operation']
    offset = request.get('offset', 0)
    if operation == 'runs':
        collection = api.runs(request['project'], per_page=25, order='-created_at')
        rows = list(itertools.islice(collection, offset, offset + 26))
        result = {'items': [{'id': r.id, 'name': r.name, 'state': r.state, 'config': r.config, 'summary': dict(r.summary), 'createdAt': r.created_at} for r in rows[:25]], 'nextOffset': offset + 25 if len(rows) > 25 else None}
    else:
        run = api.run(request['project'] + '/' + request['run'])
        if operation == 'history':
            start = request.get('step', 0)
            end = min(start + 500, run.lastHistoryStep + 1)
            rows = list(run.scan_history(min_step=start, max_step=end, page_size=500)) if end > start else []
            result = {'items': rows, 'nextStep': end if end <= run.lastHistoryStep else None, 'lastStep': run.lastHistoryStep, 'config': run.config, 'summary': dict(run.summary)}
        elif operation == 'artifacts':
            rows = list(itertools.islice(run.logged_artifacts(per_page=25), offset, offset + 26))
            result = {'items': [{'name': a.name, 'type': a.type, 'digest': a.digest, 'size': a.size, 'metadata': a.metadata} for a in rows[:25]], 'nextOffset': offset + 25 if len(rows) > 25 else None}
        elif operation == 'artifact.files':
            # Require association with this run; arbitrary artifact paths are not accepted.
            artifact = next((a for a in itertools.islice(run.logged_artifacts(per_page=25), 500) if a.name == request['artifact']), None)
            if artifact is None:
                raise ValueError('Artifact is not in the first 500 logged artifacts of this run')
            rows = list(itertools.islice(artifact.files(per_page=50), offset, offset + 51))
            result = {'items': [{'name': f.name, 'size': f.size, 'digest': getattr(f, 'digest', None)} for f in rows[:50]], 'nextOffset': offset + 50 if len(rows) > 50 else None}
        else:
            raise ValueError('Unsupported read-only operation')
    def finite(value):
        if isinstance(value, dict): return {k: finite(v) for k, v in value.items()}
        if isinstance(value, list): return [finite(v) for v in value]
        if isinstance(value, float) and not math.isfinite(value): return None
        return value
    # W&B data is displayed on request, not exported or merged into local training runs.
    return finite(redact(result, True))


if __name__ == '__main__':
    request = json.load(sys.stdin)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = main(request)
        print(json.dumps({'ok': True, 'result': result}, allow_nan=False, default=str))
    except ImportError:
        print(json.dumps({'ok': False, 'error': 'Install the W&B reader in the Training panel'}))
    except Exception as error:
        # SDK exception text may include headers or server data; return a bounded redacted message.
        from aiide_sdk.spool import redact
        message = str(error).replace(request.get('secret', ''), '[REDACTED]') if request.get('secret') else str(error)
        print(json.dumps({'ok': False, 'error': str(redact(message, True))[:1500]}))
