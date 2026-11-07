import json
import os
import sys

from . import catalog, final, inspect, predict, sweep

mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode in ("sweep", "final"):
    # Recorded run: config from the IDE, progress on stdout, failure as a non-zero exit.
    try:
        (sweep if mode == "sweep" else final)(json.loads(os.environ["AIIDE_LAB_CONFIG"]))
    except Exception as error:
        print(f"Experiment lab error: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
elif mode in ("catalog", "inspect", "predict"):
    try:
        request = json.loads(sys.stdin.read() or "{}")
        result = {"catalog": catalog, "inspect": inspect, "predict": predict}[mode](request)
        print(json.dumps({"ok": True, "result": result}, allow_nan=False, default=str))
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{error}"}))
else:
    sys.exit("usage: python -m aiide_lab catalog|inspect|predict|sweep|final")
