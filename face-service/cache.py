"""Short-lived detect-embed cache keyed by image content hash (no selfie retention)."""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any

from config import SEARCH_CACHE_MAX_ENTRIES, SEARCH_CACHE_TTL


class EmbedCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, dict[str, Any]]] = {}

    @staticmethod
    def hash_bytes(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def get(self, key: str) -> dict[str, Any] | None:
        now = time.time()
        with self._lock:
            item = self._items.get(key)
            if not item:
                return None
            expires, value = item
            if expires < now:
                self._items.pop(key, None)
                return None
            return value

    def set(self, key: str, value: dict[str, Any], ttl: int | None = None) -> None:
        ttl = SEARCH_CACHE_TTL if ttl is None else ttl
        if ttl <= 0:
            return
        with self._lock:
            if len(self._items) >= SEARCH_CACHE_MAX_ENTRIES:
                # Drop oldest
                oldest = min(self._items.items(), key=lambda kv: kv[1][0])[0]
                self._items.pop(oldest, None)
            # Store a shallow copy without mutating caller; embeddings already lists
            self._items[key] = (time.time() + ttl, value)


embed_cache = EmbedCache()
