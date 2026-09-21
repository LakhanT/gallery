"""Bounded concurrency + queue for buffalo_l inference (search vs index lanes)."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, TypeVar

from config import (
    INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT,
    MAX_INDEX_CONCURRENCY,
    MAX_QUEUE_SIZE,
    MAX_SEARCH_CONCURRENCY,
    REQUEST_TIMEOUT_SECONDS,
)
from metrics import metrics

T = TypeVar("T")


@dataclass
class CapacitySnapshot:
    search_active: int
    index_active: int
    search_waiting: int
    index_waiting: int
    search_limit: int
    index_limit: int
    max_queue: int


class InferenceCapacity:
    """
    Two priority lanes share one model process:
    - search: live event selfies (higher concurrency)
    - index: background gallery indexing (lower concurrency; pauses under search load)
    Queue is bounded; overflow → 503 busy (caller maps exception).
    """

    def __init__(self) -> None:
        self._search_sem = asyncio.Semaphore(MAX_SEARCH_CONCURRENCY)
        self._index_sem = asyncio.Semaphore(MAX_INDEX_CONCURRENCY)
        self._search_waiting = 0
        self._index_waiting = 0
        self._search_active = 0
        self._index_active = 0
        self._lock = asyncio.Lock()

    def snapshot(self) -> CapacitySnapshot:
        return CapacitySnapshot(
            search_active=self._search_active,
            index_active=self._index_active,
            search_waiting=self._search_waiting,
            index_waiting=self._index_waiting,
            search_limit=MAX_SEARCH_CONCURRENCY,
            index_limit=MAX_INDEX_CONCURRENCY,
            max_queue=MAX_QUEUE_SIZE,
        )

    async def run(
        self,
        lane: str,
        fn: Callable[[], Awaitable[T]] | Callable[[], T],
        *,
        timeout: float | None = None,
    ) -> T:
        is_search = lane != "index"
        sem = self._search_sem if is_search else self._index_sem
        timeout = REQUEST_TIMEOUT_SECONDS if timeout is None else timeout

        async with self._lock:
            waiting = self._search_waiting + self._index_waiting
            if waiting >= MAX_QUEUE_SIZE:
                metrics.inc("face_busy_reject")
                raise CapacityBusyError("Face service is at capacity. Please try again shortly.")
            if is_search:
                self._search_waiting += 1
            else:
                # Backpressure: refuse new index work when search queue is deep
                if self._search_waiting >= INDEX_PAUSE_WHEN_SEARCH_QUEUE_GT:
                    metrics.inc("index_paused")
                    raise CapacityBusyError(
                        "Indexing paused while live face search is busy. Retry later."
                    )
                self._index_waiting += 1
            metrics.set_gauge("queue_depth", self._search_waiting + self._index_waiting)

        acquired = False
        try:
            try:
                await asyncio.wait_for(sem.acquire(), timeout=timeout)
                acquired = True
            except asyncio.TimeoutError as exc:
                metrics.inc("face_queue_timeout")
                raise CapacityBusyError(
                    "Face service is busy. Please try again in a few seconds."
                ) from exc
            finally:
                async with self._lock:
                    if is_search:
                        self._search_waiting = max(0, self._search_waiting - 1)
                    else:
                        self._index_waiting = max(0, self._index_waiting - 1)
                    metrics.set_gauge("queue_depth", self._search_waiting + self._index_waiting)

            async with self._lock:
                if is_search:
                    self._search_active += 1
                else:
                    self._index_active += 1
                metrics.set_gauge(
                    "active_inference",
                    self._search_active + self._index_active,
                )

            t0 = time.perf_counter()
            try:
                if asyncio.iscoroutinefunction(fn):
                    result = await asyncio.wait_for(fn(), timeout=timeout)
                else:
                    result = await asyncio.wait_for(asyncio.to_thread(fn), timeout=timeout)
                metrics.observe("inference_latency_ms", (time.perf_counter() - t0) * 1000)
                return result
            except asyncio.TimeoutError as exc:
                metrics.inc("face_inference_timeout")
                raise CapacityBusyError("Face inference timed out. Please try again.") from exc
        finally:
            if acquired:
                sem.release()
            async with self._lock:
                if is_search:
                    self._search_active = max(0, self._search_active - 1)
                else:
                    self._index_active = max(0, self._index_active - 1)
                metrics.set_gauge(
                    "active_inference",
                    self._search_active + self._index_active,
                )


class CapacityBusyError(Exception):
    """Mapped to HTTP 503 by the API layer."""


capacity = InferenceCapacity()
