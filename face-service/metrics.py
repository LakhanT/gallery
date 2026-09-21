"""In-process metrics (safe — no secrets, embeddings, or images)."""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from typing import Any


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[str, int] = defaultdict(int)
        self._gauges: dict[str, float] = {}
        self._latency_sum: dict[str, float] = defaultdict(float)
        self._latency_count: dict[str, int] = defaultdict(int)
        self.started_at = time.time()

    def inc(self, name: str, n: int = 1) -> None:
        with self._lock:
            self._counters[name] += n

    def set_gauge(self, name: str, value: float) -> None:
        with self._lock:
            self._gauges[name] = float(value)

    def observe(self, name: str, value_ms: float) -> None:
        with self._lock:
            self._latency_sum[name] += value_ms
            self._latency_count[name] += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            averages = {}
            for k, total in self._latency_sum.items():
                c = self._latency_count.get(k, 0) or 1
                averages[k] = round(total / c, 2)
            return {
                "uptime_seconds": round(time.time() - self.started_at, 1),
                "counters": dict(self._counters),
                "gauges": dict(self._gauges),
                "latency_ms_avg": averages,
            }


metrics = Metrics()
