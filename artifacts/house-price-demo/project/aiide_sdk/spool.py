"""Bounded, content-filtered telemetry journal for disconnected training jobs."""
import fcntl
import json
import os
import re

LIMIT = 32 * 1024 * 1024
SECRET = re.compile(r'api.?key|authorization|password|secret|access.?token|credential', re.I)
CONTENT = re.compile(r'prompt|completion|input|output|content|document|state|message|body|payload|query|actual|expected|text|answer|passage', re.I)


def redact(value, capture=False):
    if isinstance(value, list):
        return [redact(v, capture) for v in value[:1000]]
    if isinstance(value, dict):
        if 'key' in value and 'value' in value:  # OTLP attribute
            key = str(value['key'])
            if SECRET.search(key) or (not capture and CONTENT.search(key) and not any(k in value['value'] for k in ('intValue', 'doubleValue', 'boolValue'))):
                return {'key': key, 'value': {'stringValue': '[REDACTED]' if SECRET.search(key) else '[CONTENT DISABLED]'}}
        return {k: '[REDACTED]' if SECRET.search(k) else '[CONTENT DISABLED]' if not capture and CONTENT.search(k) and not isinstance(v, (int, float, bool)) else redact(v, capture) for k, v in list(value.items())[:500]}
    if isinstance(value, str):
        value = re.sub(r'Bearer\s+[^\s"\']+', 'Bearer [REDACTED]', value[:16384], flags=re.I)
        value = re.sub(r'\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{10,})\b', '[REDACTED]', value)
        return re.sub(r'((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;"\']+', r'\1[REDACTED]', value, flags=re.I)
    return value


def note_drop(file):
    try:
        fd = os.open(file + '.dropped', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            count = int(os.read(fd, 64) or b'0') + 1
            os.lseek(fd, 0, 0)
            value = str(count).encode()
            os.write(fd, value)
            os.ftruncate(fd, len(value))
        finally:
            os.close(fd)
    except (OSError, ValueError):
        pass


def append(file, route, body, capture=False):
    # Filter envelope values without treating the transport's "body" as user content.
    if route == '/events':
        body = {'events': [{**e, 'value': '[CONTENT DISABLED]' if e.get('kind') == 'log' and not capture else redact(e.get('value'), capture)} for e in body.get('events', [])]}
    else:
        body = redact(body, capture)
    line = (json.dumps({'route': route, 'body': body}, allow_nan=False) + '\n').encode()
    if len(line) > 256 * 1024:
        note_drop(file)
        return False
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        if os.fstat(fd).st_size + len(line) > LIMIT:
            note_drop(file)
            return False
        os.write(fd, line)
        return True
    finally:
        os.close(fd)
