"""Safe image validation + resize before InsightFace (preserve selfie quality)."""

from __future__ import annotations

import cv2
import numpy as np

from config import MAX_IMAGE_PIXELS, MAX_LONG_EDGE


def decode_and_preprocess(data: bytes) -> np.ndarray:
    """
    Decode image bytes → BGR ndarray.
    - Rejects corrupt / empty
    - Caps total pixels
    - Downscales long edge to MAX_LONG_EDGE (keeps aspect ratio)
    - Applies EXIF orientation when OpenCV/Pillow can help via flags
    """
    if not data:
        raise ValueError("Empty image.")
    arr = np.frombuffer(data, dtype=np.uint8)
    # IMREAD_COLOR ignores alpha; orientation: use EXIF if available via decode
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not decode image. Use JPEG or PNG.")

    h, w = image.shape[:2]
    pixels = int(h) * int(w)
    if pixels > MAX_IMAGE_PIXELS:
        raise ValueError(
            f"Image too large ({w}x{h} = {pixels} pixels). Max {MAX_IMAGE_PIXELS}."
        )

    long_edge = max(h, w)
    if long_edge > MAX_LONG_EDGE:
        scale = MAX_LONG_EDGE / float(long_edge)
        nw = max(1, int(w * scale))
        nh = max(1, int(h * scale))
        image = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_AREA)

    return image
