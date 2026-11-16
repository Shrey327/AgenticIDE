"""Supervise one local job while the IDE-owned pipe remains open (POSIX)."""
import json
import os
import selectors
import signal
import subprocess
import sys
import time

GRACE_SECONDS = 3


def group_exists(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False


def cleanup(child):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + GRACE_SECONDS
    while time.monotonic() < deadline:
        child.poll()
        if not group_exists(child.pid):
            return
        time.sleep(0.05)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def main():
    arguments = sys.argv[1:]
    forward_stdin = bool(arguments and arguments[0] == '--forward-stdin')
    if forward_stdin: arguments = arguments[1:]
    stopped = False

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # The target never inherits either the parent-liveness pipe or diagnostics FD.
    os.set_inheritable(3, False)
    os.set_inheritable(4, False)
    with selectors.DefaultSelector() as selector:
        selector.register(3, selectors.EVENT_READ)
        if selector.select(0) and not os.read(3, 4096):
            return 143
        try:
            child = subprocess.Popen(arguments, stdin=sys.stdin if forward_stdin else subprocess.DEVNULL,
                                     close_fds=True, start_new_session=True)
        except (OSError, ValueError) as error:
            os.write(4, (json.dumps({'error': str(error)[:4096]}) + '\n').encode())
            return 127
        try:
            while child.poll() is None and not stopped:
                if selector.select(0.1) and not os.read(3, 4096):
                    stopped = True
            code = child.poll()
        finally:
            cleanup(child)
        return 143 if stopped else code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main())
