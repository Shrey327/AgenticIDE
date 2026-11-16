"""Editable Gymnasium factory: learn to match a target with discrete or Box actions."""
import gymnasium as gym
from gymnasium import spaces
import numpy as np


class TargetEnvironment(gym.Env):
    metadata = {'render_modes': []}

    def __init__(self, continuous=False, target=0.7):
        self.continuous = bool(continuous)
        self.target = float(target)
        if not -1 <= self.target <= 1:
            raise ValueError('target must be between -1 and 1')
        self.observation_space = spaces.Box(-1,1,shape=(1,),dtype=np.float32)
        self.action_space = spaces.Box(-1,1,shape=(1,),dtype=np.float32) if self.continuous else spaces.Discrete(2)

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        return np.array([self.target],dtype=np.float32), {}

    def step(self, action):
        value = float(action[0]) if self.continuous else (1.0 if int(action) else -1.0)
        error = abs(value - self.target)
        return np.array([self.target],dtype=np.float32), float(1-error*error), False, False, {'is_success':error<0.4}


def make_env(parameters):
    return TargetEnvironment(**parameters)
