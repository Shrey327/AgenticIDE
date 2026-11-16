"""Run an IDE-owned module in isolated Python without workspace import shadowing."""
from pathlib import Path
import runpy
import sys

allowed = {'aiide_rl', 'aiide_voice', 'aiide_hf', 'aiide_lab', 'aiide_eval', 'aiide_documents'}
if len(sys.argv) < 2 or sys.argv[1] not in allowed:
    raise SystemExit('Choose an allowlisted bundled AIIDE runtime module')
module = sys.argv.pop(1)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# alter_sys preserves -m's __main__.__spec__, required by spawned worker processes.
runpy.run_module(module, run_name='__main__', alter_sys=True)
