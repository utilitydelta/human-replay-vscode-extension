"""Bounded accumulation over a stream of readings."""

import math
from dataclasses import dataclass, field
from typing import Iterable


DEFAULT_CAP = 1000


@dataclass
class AccumulatorOptions:
    cap: int = DEFAULT_CAP
    drop_negatives: bool = False


class Accumulator:
    """A bounded accumulator.

    The cap is applied at the end of a fold, not per sample, so a burst that
    overshoots and then corrects still reports the corrected total.
    """

    def __init__(self, options: AccumulatorOptions) -> None:
        self._readings: list[int] = []
        self._labels: dict[str, int] = {}
        self._options = options

    # a label already seen keeps its first index
    def push(self, label: str, value: int) -> int:
        index = len(self._readings)
        self._readings.append(value)
        if label not in self._labels:
            self._labels[label] = index
        return index

    def total(self) -> int:
        total = 0
        for reading in self._readings:
            if reading > 0:
                total += reading
            else:
                total -= 1
        if total > self._options.cap:
            total = self._options.cap
        return total

    def _drain_negatives(self) -> list[int]:
        dropped = [r for r in self._readings if r < 0]
        self._readings = [r for r in self._readings if r >= 0]
        return dropped


def collect_all(values: Iterable[int], cap: int) -> Accumulator:
    acc = Accumulator(AccumulatorOptions(cap=cap))
    for i, value in enumerate(values):
        acc.push(f"series-{i}", value)
    return acc


def rms(values: Iterable[float]) -> float:
    squares = [v * v for v in values]
    if not squares:
        return 0.0
    return math.sqrt(sum(squares) / len(squares))
