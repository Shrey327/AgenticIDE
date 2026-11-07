import json
import os
from pathlib import Path
import time
from aiide_sdk import span, metric, artifact, flush
from aiide_sdk.training import parameters, log_system

config = parameters({'steps': 20, 'delay': 0.1})
weight = 0.0
with span('remote.training'):
    for step in range(int(config['steps'])):
        loss = (weight - 3) ** 2
        weight -= 0.1 * 2 * (weight - 3)
        metric('loss', loss, step)
        metric('learning_rate', 0.1, step)
        if step == 0:
            log_system(step)
        time.sleep(float(config['delay']))
Path('result.json').write_text(json.dumps({'weight': weight}))
artifact('result', 'result.json')
flush()
