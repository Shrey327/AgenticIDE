import json
import sys
from . import run, status


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        print(json.dumps({"ok": True, "result": status()}))
        return
    if len(sys.argv) > 1 and sys.argv[1] == 'local-speech':
        from .local_speech import main as local_main
        sys.argv.pop(1)
        local_main()
    else:
        run()


if __name__ == "__main__":
    main()
