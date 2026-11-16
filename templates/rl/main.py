"""Train a small policy; no model, GPU, network, or extra packages required."""
import os
import uuid
from aiide_rl.__main__ import main

# Each invocation saves a separate policy; earlier experiments stay intact.
os.environ.setdefault("AIIDE_RL_OUTPUT", "rl-policies/" + str(uuid.uuid4()))
main()
