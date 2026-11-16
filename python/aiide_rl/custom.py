"""Reviewed project factories are trusted local Python code, not a sandbox."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types


def definition(value):
    fields = {'id', 'title', 'entrypoint', 'factory', 'files', 'parameters', 'revision'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('A reviewed custom environment registration is required')
    if (not isinstance(value['id'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', value['id']) or
        not isinstance(value['title'], str) or not 1 <= len(value['title']) <= 100 or
        not isinstance(value['factory'], str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', value['factory']) or
        not isinstance(value['revision'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['revision'])):
        raise ValueError('Invalid custom environment registration')
    if not isinstance(value['parameters'], dict) or len(json.dumps(value['parameters'],allow_nan=False).encode()) > 16000:
        raise ValueError('Custom parameters must be finite JSON below 16 KB')
    sources = value['files']
    if not isinstance(sources, list) or not 1 <= len(sources) <= 20:
        raise ValueError('Review 1–20 custom source files')
    files = set()
    for source in sources:
        if (not isinstance(source,dict) or set(source) != {'file','sha256'} or
            not isinstance(source['file'],str) or len(source['file'])>300 or
            not source['file'].endswith('.py') or '\\' in source['file'] or '\0' in source['file'] or
            Path(source['file']).is_absolute() or any(part in ('','.', '..') for part in source['file'].split('/')) or
            not isinstance(source['sha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',source['sha256']) or source['file'] in files):
            raise ValueError('Invalid custom source path or fingerprint')
        files.add(source['file'])
    if value['entrypoint'] not in files:
        raise ValueError('The factory must be in reviewed sources')
    return value


def sources(value):
    value = definition(value)
    root = Path.cwd().resolve()
    contents, total = {}, 0
    for source in value['files']:
        file = root / source['file']
        current = root
        for part in Path(source['file']).parts:
            current = current / part
            if current.is_symlink():
                raise ValueError('Symbolic links are not allowed in custom sources')
        descriptor = os.open(file, os.O_RDONLY | getattr(os,'O_NOFOLLOW',0) | getattr(os,'O_NONBLOCK',0))
        with os.fdopen(descriptor,'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 256000:
                raise ValueError('Custom sources must be regular files below 256 KB')
            content = stream.read(256001)
        total += len(content)
        if len(content)>256000 or total>1000000:
            raise ValueError('Reviewed custom sources exceeded their size limit')
        if hashlib.sha256(content).hexdigest() != source['sha256']:
            raise ValueError('Custom environment source changed; review and register it again')
        content.decode('utf-8')
        contents[source['file']] = content
    return contents


def make(value, algorithm, max_steps, seed):
    import gymnasium as gym
    import numpy as np
    content = sources(value)
    name = 'aiide_custom_' + value['revision']
    module = sys.modules.get(name)
    if module is None:
        module = types.ModuleType(name)
        module.__file__ = str(Path.cwd() / value['entrypoint'])
        module.__package__ = '.'.join(Path(value['entrypoint']).parts[:-1])
        for directory in (str(Path.cwd().resolve()),str(Path(module.__file__).parent)):
            if directory not in sys.path: sys.path.append(directory)
        # Execute exactly the fingerprinted entrypoint bytes, never a second file read.
        sys.modules[name] = module
        try:
            exec(compile(content[value['entrypoint']], module.__file__, 'exec'), module.__dict__)
        except BaseException:
            sys.modules.pop(name,None)
            raise
    factory = getattr(module,value['factory'],None)
    if not callable(factory):
        raise ValueError('The reviewed factory is missing or is not callable')
    env = factory(json.loads(json.dumps(value['parameters'])))
    try:
        if not isinstance(env,gym.Env):
            raise ValueError('Custom factory must return a Gymnasium Env')
        observations, actions = env.observation_space, env.action_space
        if (not isinstance(observations,gym.spaces.Box) or len(observations.shape)!=1 or
            not 1<=observations.shape[0]<=256 or not np.issubdtype(observations.dtype,np.floating)):
            raise ValueError('Custom observations must be a flat floating-point Box with 1–256 values')
        continuous = isinstance(actions,gym.spaces.Box)
        discrete = isinstance(actions,gym.spaces.Discrete) and actions.start==0 and 2<=actions.n<=256
        if continuous and (len(actions.shape)!=1 or not 1<=actions.shape[0]<=32 or not np.issubdtype(actions.dtype,np.floating) or not np.isfinite(actions.low).all() or not np.isfinite(actions.high).all() or not (actions.low<actions.high).all()):
            raise ValueError('Continuous actions require a finite floating-point Box with 1–32 values')
        if not continuous and not discrete:
            raise ValueError('Use zero-based Discrete actions (2–256) or a finite Box')
        if algorithm=='sac' and not continuous:
            raise ValueError('SAC requires continuous Box actions')
        class CheckedEnvironment(gym.Wrapper):
            def observation(self, observation):
                if not self.observation_space.contains(observation) or not np.isfinite(observation).all():
                    raise ValueError('Custom observation is non-finite or outside its declared Box')
                return observation

            def reset(self, **kwargs):
                observation, info = self.env.reset(**kwargs)
                if not isinstance(info,dict): raise ValueError('Custom reset info must be a dictionary')
                return self.observation(observation), info

            def step(self, action):
                observation,reward,terminated,truncated,info = self.env.step(action)
                if (not isinstance(reward,(int,float,np.number)) or not np.isfinite(reward) or
                    not isinstance(terminated,(bool,np.bool_)) or not isinstance(truncated,(bool,np.bool_)) or not isinstance(info,dict)):
                    raise ValueError('Custom step must return a finite reward, boolean terminal flags and info dictionary')
                return self.observation(observation),float(reward),bool(terminated),bool(truncated),info
        env = CheckedEnvironment(gym.wrappers.TimeLimit(env,max_episode_steps=max_steps))
        env.reset(seed=seed)
        env.action_space.seed(seed)
        return env
    except BaseException:
        close = getattr(env,'close',None)
        if callable(close): close()
        raise


def check(value):
    from contextlib import closing
    from stable_baselines3.common.env_checker import check_env
    import gymnasium as gym
    with closing(make(value,'ppo',100,42)) as env:
        check_env(env,warn=True,skip_render_check=True)
        return {'id':value['id'],'revision':value['revision'],'valid':True,
                'observation':str(env.observation_space),'action':str(env.action_space),
                'algorithms':['ppo','sac'] if isinstance(env.action_space,gym.spaces.Box) else ['ppo']}
