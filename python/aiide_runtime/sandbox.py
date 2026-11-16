"""Own a Docker command while the IDE's private liveness descriptor stays open."""
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time


def docker(arguments, timeout):
    # Even daemon error output cannot grow an in-memory capture without bound.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(["docker", *arguments], stdout=output,
                                stderr=subprocess.DEVNULL, timeout=timeout)
        output.seek(0)
        return result.returncode, output.read(4096).decode(errors="replace").strip()


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


def cleanup(child, name, owner, command, cidfile, interrupted):
    # A create request can finish after the IDE dies; retain its CLI while checking.
    deadline = time.monotonic() + 12
    while True:
        try:
            code, identity = docker([
                "inspect", "--format",
                '{{.Id}} {{index .Config.Labels "aiide.workspace"}} {{index .Config.Labels "aiide.command"}}', name], 2)
            if code == 0:
                identifier, label, instance = identity.split(" ", 2)
                if label != owner or instance != command or not re.fullmatch(r"[a-f0-9]{64}", identifier):
                    return
                code, _ = docker(["rm", "-f", identifier], 3)
                if code == 0:
                    return
            elif not interrupted or (child.poll() is not None and os.path.exists(cidfile)):
                return
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        if time.monotonic() >= deadline:
            return
        time.sleep(.1)


def main():
    name, owner, command, *arguments = sys.argv[1:]
    if (not re.fullmatch(r"aiide-[a-f0-9-]{36}", name) or
            not re.fullmatch(r"[a-f0-9]{64}", owner) or
            not re.fullmatch(r"[a-f0-9-]{36}", command) or
            not arguments or arguments[0] != "run"):
        raise ValueError("Invalid sandbox guardian configuration")
    stopped = False
    expired = False

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    os.set_inheritable(3, False)
    with selectors.DefaultSelector() as selector, tempfile.TemporaryDirectory(prefix="aiide-container-") as temporary:
        selector.register(3, selectors.EVENT_READ)
        if selector.select(0) and not os.read(3, 4096):
            return 143
        cidfile = os.path.join(temporary, "container.id")
        child = subprocess.Popen(["docker", "run", "--cidfile", cidfile, *arguments[1:]],
                                 stdin=subprocess.DEVNULL, close_fds=True, start_new_session=True)
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
                cleanup(child, name, owner, command, cidfile, stopped or child.poll() not in (0, None))
            finally:
                stop_client(child)
        return 124 if expired else 143 if stopped else code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main())
