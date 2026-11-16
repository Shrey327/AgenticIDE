import json
import os
import sys
import signal
from . import train, rollout


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "train"
    if mode == "train":
        from aiide_sdk import artifact, evaluation, flush, metric, span
        request = json.loads(os.environ.get("AIIDE_RL_CONFIG", "{}"))
        advanced = request.get("algorithm") in ("ppo", "sac")
        trainer = train
        if advanced:
            from .advanced import train as trainer
            def interrupted(*_):
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM, interrupted)
        output = os.environ.get("AIIDE_RL_OUTPUT", "rl-policies/example")
        def log(step, reward, steps, seed=None):
            metric("rl.episode_reward", reward, step if seed is None else None)
            metric("rl.episode_steps", steps, step if seed is None else None)
            if seed is not None:
                metric(f"rl.seed.{seed}.episode_reward", reward, step)
            flush()
        with span("rl.train", algorithm=request.get("algorithm", "q-learning"), environment=request.get("environment", "gridworld")):
            result = trainer(request, output, log)
            for key, value in result["evaluation"].items():
                metric("rl.eval." + key, value)
            evaluation("random-policy improvement", result["evaluation"]["meanReward"],
                       result["baseline"]["meanReward"],
                       float(result["evaluation"]["meanReward"] > result["baseline"]["meanReward"]))
            artifact("RL policy", output + "/policy.json", framework="stable-baselines3" if advanced else "tabular-q-learning")
        flush()
        print(json.dumps({"policy": output, "baseline": result["baseline"], "evaluation": result["evaluation"]}))
    elif mode == "rollout":
        request = json.load(sys.stdin)
        try:
            if request.get('root'): os.chdir(request['root'])
            file = request["file"]
            from pathlib import Path
            metadata = json.loads(Path(file).read_text())
            if metadata.get("format") == "aiide-sb3-v1":
                custom = metadata.get('config',{}).get('customEnvironment')
                if request.get('allowCustom') is False and (custom is not None or str(metadata.get('config',{}).get('environment')).startswith('custom:')):
                    raise ValueError('Custom environments require an explicit IDE execution action')
                if custom is not None and custom != request.get('customEnvironment'):
                    raise ValueError('Custom rollout requires the current reviewed environment registration')
                from .advanced import rollout as neural_rollout
                result = neural_rollout(file, request.get("seed", 12345), request.get('customEnvironment'), request.get('allowCustom',True))
            else:
                result = rollout(file, request.get("seed", 12345))
            print(json.dumps({"ok": True, "result": result}, allow_nan=False))
        except (OSError, ValueError, KeyError, TypeError) as error:
            print(json.dumps({"ok": False, "error": str(error)}))
    elif mode == 'check-environment':
        try:
            from .custom import check
            request=json.load(sys.stdin)
            if request.get('root'): os.chdir(request['root'])
            print(json.dumps({'ok':True,'result':check(request['customEnvironment'])},allow_nan=False))
        except (OSError,ValueError,KeyError,TypeError,AssertionError) as error:
            print(json.dumps({'ok':False,'error':str(error)}))
    elif mode == "status":
        from .advanced import status
        print(json.dumps({"ok": True, "result": status()}))
    else:
        raise ValueError("Use train, rollout or status")


if __name__ == "__main__":
    main()
