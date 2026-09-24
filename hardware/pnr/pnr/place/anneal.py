"""Reproducible exploration and finite-window plateau detection.

A plateau is an observed lack of improvement under this search budget, not a
proof of a global optimum. Budget exhaustion must be reported separately.
"""
import math
import random
from dataclasses import dataclass


def choose_cost(costs, temperature, rng):
    """Boltzmann sample; temperature is in the same units as costs."""
    if not costs:
        raise ValueError('empty candidate distribution')
    if temperature <= 0:
        return min(range(len(costs)), key=lambda i: costs[i])
    low = min(costs)
    weights = [math.exp(max(-700., -(c-low)/temperature)) for c in costs]
    return rng.choices(range(len(costs)), weights=weights, k=1)[0]


@dataclass
class Plateau:
    warmup: int = 6
    patience: int = 6
    initial_temperature: float = .15
    observations: int = 0
    cold_stale: int = 0
    best: float = math.inf

    @property
    def temperature(self):
        # Reach zero explicitly; exponential cooling alone never does.
        return self.initial_temperature * max(0., 1.-self.observations/self.warmup)

    def observe(self, objective):
        cold = self.temperature == 0
        improved = objective < self.best
        if improved:
            self.best = objective
            self.cold_stale = 0
        elif cold:
            self.cold_stale += 1
        self.observations += 1
        return improved

    @property
    def reached(self):
        return self.cold_stale >= self.patience
