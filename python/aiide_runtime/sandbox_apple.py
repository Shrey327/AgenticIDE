"""Supervise one uniquely named Apple Container VM through the IDE-owned FD."""
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time


def container(arguments, timeout):
    binary = os.environ.get('AIIDE_APPLE_CONTAINER') or 'container'
    with tempfile.TemporaryFile() as output:
        result = subprocess.run([binary, *arguments], stdout=output,
                                stderr=subprocess.DEVNULL, timeout=timeout)
        if output.tell() > 1024 * 1024:
            raise ValueError('Container inspection exceeded its output budget')
        output.seek(0)
        return result.returncode, output.read().decode(errors='replace')


def owned(value, name, owner, command):
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        return False
    configuration = value[0].get('configuration')
    if not isinstance(configuration, dict) or configuration.get('id') != name:
        return False
    labels = configuration.get('labels')
    return isinstance(labels, dict) and labels.get('aiide.workspace') == owner and \
        labels.get('aiide.managed') == 'sandbox-vm-v1' and labels.get('aiide.command') == command


def cleanup(child, name, owner, command, interrupted):
    # A VM create already in flight can finish after its IDE has died.
    deadline = time.monotonic() + 12
    while True:
        try:
            code, value = container(['inspect', name], 2)
            if code == 0:
                if not owned(json.loads(value), name, owner, command):
                    return
                code, _ = container(['delete', '--force', name], 3)
                if code == 0:
                    return
            elif not interrupted:
                return
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        if time.monotonic() >= deadline:
            return
        time.sleep(.1)


def stop_client(child):
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    except ProcessLookupError:
        child.wait()


def main():
    name, owner, command, *arguments = sys.argv[1:]
    if (not re.fullmatch(r'aiide-vm-[a-f0-9-]{36}', name) or
            not re.fullmatch(r'[a-f0-9]{64}', owner) or
            not re.fullmatch(r'[a-f0-9-]{36}', command) or
            not arguments or arguments[0] != 'run'):
        raise ValueError('Invalid VM sandbox guardian configuration')
    stopped = False
    expired = False

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    os.set_inheritable(3, False)
    with selectors.DefaultSelector() as selector:
        selector.register(3, selectors.EVENT_READ)
        if selector.select(0) and not os.read(3, 4096):
            return 143
        binary = os.environ.get('AIIDE_APPLE_CONTAINER') or 'container'
        child = subprocess.Popen([binary, *arguments], stdin=subprocess.DEVNULL,
                                 close_fds=True, start_new_session=True)
        deadline = time.monotonic() + 120
        try:
            while child.poll() is None and not stopped:
                if time.monotonic() >= deadline:
                    expired = stopped = True
                elif selector.select(.1) and not os.read(3, 4096):
                    stopped = True
            code = child.poll()
        finally:
            try:
                cleanup(child, name, owner, command, stopped or child.poll() not in (0, None))
            finally:
                stop_client(child)
        return 124 if expired else 143 if stopped else code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main())
