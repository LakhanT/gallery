import { loadArcFaceModel } from "./arcface.js";

const MODEL_URL = "/models";
/**
 * FaceNet (face-api) is the primary matcher. ArcFace is optional and skipped
 * during gallery indexing for speed.
 */
export const SCAN_VERSION = 8;
/** @deprecated FaceNet Euclidean — gallery matching uses cosine similarity in lib/face-match.js */
export const MATCH_DISTANCE = 0.58;
export const UNCERTAIN_DISTANCE = 0.68;
const MIN_FACE_SIZE = 40;
const MIN_SIDE = 480;
const MAX_SIDE = 1280;
const FAST_MAX_SIDE = 960;
const MAX_DESCRIPTORS_PER_FACE = 2;
const MEDIAPIPE_VERSION = "1.0.1";
const MEDIAPIPE_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MEDIAPIPE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

let faceapi = null;
let poseDetector = null;
let poseVision = null;
let poseFailures = 0;
let modelsReady = false;
let modelsLoading = null;
let arcFaceReady = false;

async function createPoseDetector(delegate) {
  const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
  if (!poseVision) {
    poseVision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
  }
  return FaceDetector.createFromOptions(poseVision, {
    baseOptions: {
      modelAssetPath: MEDIAPIPE_MODEL,
      delegate,
    },
    runningMode: "IMAGE",
    minDetectionConfidence: 0.45,
    minSuppressionThreshold: 0.4,
  });
}

function closePoseDetector() {
  try {
    poseDetector?.close?.();
  } catch {
    /* already closed */
  }
  poseDetector = null;
}

export async function loadFaceModels({ withArcFace = false } = {}) {
  if (modelsReady) {
    if (withArcFace && !arcFaceReady) {
      try {
        await loadArcFaceModel();
        arcFaceReady = true;
      } catch {
        arcFaceReady = false;
      }
    }
    return faceapi;
  }
  if (modelsLoading) {
    await modelsLoading;
    if (withArcFace && !arcFaceReady) {
      try {
        await loadArcFaceModel();
        arcFaceReady = true;
      } catch {
        arcFaceReady = false;
      }
    }
    return faceapi;
  }

  modelsLoading = (async () => {
    faceapi = await import("@vladmandic/face-api");
    // Tiny + landmarks + FaceNet first (needed for fast indexing). SSD loads in parallel.
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    ]);
    // Skip ArcFace + MediaPipe on initial load — they dominate startup/index time
    modelsReady = true;
    return faceapi;
  })();

  try {
    await modelsLoading;
    if (withArcFace) {
      try {
        await loadArcFaceModel();
        arcFaceReady = true;
      } catch {
        arcFaceReady = false;
      }
    }
    return faceapi;
  } catch (error) {
    modelsLoading = null;
    throw error;
  }
}

function canvasFromBitmap(bitmap, maxSide = MAX_SIDE) {
  const longest = Math.max(bitmap.width, bitmap.height);
  const shortest = Math.min(bitmap.width, bitmap.height);
  let scale = shortest < MIN_SIDE ? MIN_SIDE / shortest : 1;
  if (longest * scale > maxSide) scale = maxSide / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function canvasFromUrl(url) {
  const response = await fetch(url, { mode: "cors", credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("Could not open that photo");
  }
  const blob = await response.blob();
  return canvasFromBitmap(await createImageBitmap(blob));
}

async function canvasFromFile(file) {
  return canvasFromBitmap(await createImageBitmap(file));
}

function flipHorizontal(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function cropBox(canvas, box, pad = 0.35) {
  const x = Math.max(0, box.x - box.width * pad);
  const y = Math.max(0, box.y - box.height * pad);
  const width = Math.min(canvas.width - x, box.width * (1 + pad * 2));
  const height = Math.min(canvas.height - y, box.height * (1 + pad * 2));
  const cut = document.createElement("canvas");
  cut.width = Math.max(1, Math.round(width));
  cut.height = Math.max(1, Math.round(height));
  cut.getContext("2d").drawImage(canvas, x, y, width, height, 0, 0, cut.width, cut.height);
  return cut;
}

function previewFromBox(canvas, box) {
  const cut = cropBox(canvas, box, 0.2);
  const preview = document.createElement("canvas");
  preview.width = 96;
  preview.height = 96;
  preview.getContext("2d").drawImage(cut, 0, 0, 96, 96);
  return preview.toDataURL("image/jpeg", 0.85);
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

function boxFromDetection(det) {
  const box = det.box || det.detection?.box;
  if (!box) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function compactDescriptor(values) {
  return values.map((value) => Math.round(Number(value) * 1e6) / 1e6);
}

function uniqueDescriptors(list, limit = MAX_DESCRIPTORS_PER_FACE) {
  const kept = [];
  for (const item of list) {
    if (!item?.length || item.length < 64) continue;
    const compact = compactDescriptor(item);
    if (kept.some((other) => other.length === compact.length && faceDistance(other, compact) < 0.08)) {
      continue;
    }
    kept.push(compact);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * One-shot detect + landmarks + FaceNet descriptors (much faster than re-detecting per face).
 */
async function detectWithDescriptors(api, canvas, { fast = false } = {}) {
  if (fast) {
    const tiny = await api
      .detectAllFaces(
        canvas,
        new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.38 })
      )
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (tiny.length) return tiny;
    return api
      .detectAllFaces(canvas, new api.SsdMobilenetv1Options({ minConfidence: 0.4 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
  }

  const ssd = await api
    .detectAllFaces(canvas, new api.SsdMobilenetv1Options({ minConfidence: 0.35 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  if (ssd.length) return ssd;

  return api
    .detectAllFaces(
      canvas,
      new api.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 })
    )
    .withFaceLandmarks()
    .withFaceDescriptors();
}

function entryFromDet(canvas, det) {
  const box = boxFromDetection(det);
  if (!box || box.width < MIN_FACE_SIZE || box.height < MIN_FACE_SIZE) return null;
  if (!det.descriptor?.length) return null;
  return {
    box,
    descriptors: uniqueDescriptors([Array.from(det.descriptor)], MAX_DESCRIPTORS_PER_FACE),
    preview: previewFromBox(canvas, box),
    score: det.detection?.score || 0,
  };
}

async function ensurePoseDetector() {
  if (poseDetector || poseFailures >= 3) return poseDetector;
  try {
    poseDetector = await createPoseDetector("GPU");
  } catch {
    try {
      poseDetector = await createPoseDetector("CPU");
    } catch {
      poseFailures = 3;
      poseDetector = null;
    }
  }
  return poseDetector;
}

async function descriptorFromAlignedCrop(api, crop) {
  try {
    const hit = await api
      .detectSingleFace(
        crop,
        new api.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 })
      )
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (hit?.descriptor) return Array.from(hit.descriptor);
  } catch {
    /* try ssd */
  }
  try {
    const hit = await api
      .detectSingleFace(crop, new api.SsdMobilenetv1Options({ minConfidence: 0.3 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (hit?.descriptor) return Array.from(hit.descriptor);
  } catch {
    /* no embedding */
  }
  return null;
}

function mediaPipeBoxes(canvas) {
  if (!poseDetector || poseFailures >= 3) return [];
  try {
    const result = poseDetector.detect(canvas);
    poseFailures = 0;
    return (result?.detections || [])
      .map((item) => {
        const box = item.boundingBox;
        return {
          x: box.originX,
          y: box.originY,
          width: box.width,
          height: box.height,
          score: item.categories?.[0]?.score || 0,
        };
      })
      .filter((box) => box.width >= MIN_FACE_SIZE && box.height >= MIN_FACE_SIZE);
  } catch {
    poseFailures += 1;
    closePoseDetector();
    return [];
  }
}

function mergeFaceEntries(entries) {
  const sorted = [...entries].sort(
    (a, b) => b.box.width * b.box.height - a.box.width * a.box.height
  );
  const kept = [];
  for (const entry of sorted) {
    const twin = kept.find((other) => iou(entry.box, other.box) > 0.4);
    if (twin) {
      twin.descriptors = uniqueDescriptors(
        [...twin.descriptors, ...entry.descriptors],
        MAX_DESCRIPTORS_PER_FACE
      );
      continue;
    }
    kept.push({
      box: entry.box,
      descriptors: uniqueDescriptors(entry.descriptors, MAX_DESCRIPTORS_PER_FACE),
      preview: entry.preview,
      score: entry.score || 0,
    });
  }
  return kept.filter((item) => item.descriptors.length);
}

/**
 * @param {File|string} source
 * @param {{ fast?: boolean }} [options] fast=true for gallery indexing (TinyFace, no flip/ArcFace)
 */
export async function detectFacesFromSource(source, options = {}) {
  const fast = Boolean(options.fast);
  const api = await loadFaceModels();
  const maxSide = fast ? FAST_MAX_SIDE : MAX_SIDE;

  let canvas;
  if (source instanceof File) {
    canvas = canvasFromBitmap(await createImageBitmap(source), maxSide);
  } else {
    const response = await fetch(source, { mode: "cors", credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not open that photo");
    canvas = canvasFromBitmap(await createImageBitmap(await response.blob()), maxSide);
  }

  let detections = await detectWithDescriptors(api, canvas, { fast });
  const entries = [];
  for (const det of detections) {
    const entry = entryFromDet(canvas, det);
    if (entry) entries.push(entry);
  }

  // Full/query mode only: flip pass for harder poses
  if (!fast && entries.length && entries.length < 3) {
    try {
      const flipped = flipHorizontal(canvas);
      const flippedDets = await detectWithDescriptors(api, flipped, { fast: false });
      for (const det of flippedDets) {
        const box = boxFromDetection(det);
        if (!box) continue;
        const mirroredBox = {
          x: canvas.width - box.x - box.width,
          y: box.y,
          width: box.width,
          height: box.height,
        };
        const entry = entryFromDet(flipped, det);
        if (entry) {
          entries.push({
            ...entry,
            box: mirroredBox,
            preview: previewFromBox(canvas, mirroredBox),
          });
        }
      }
    } catch {
      /* flip optional */
    }
  }

  // Rescue only when nothing found (lazy-load MediaPipe)
  if (!entries.length && !fast) {
    await ensurePoseDetector();
    for (const box of mediaPipeBoxes(canvas)) {
      const crop = cropBox(canvas, box, 0.45);
      const desc = await descriptorFromAlignedCrop(api, crop);
      if (!desc) continue;
      entries.push({
        box,
        descriptors: [desc],
        preview: previewFromBox(canvas, box),
        score: box.score || 0,
      });
    }
  }

  return mergeFaceEntries(entries);
}

function laplacianVariance(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const value =
        gray[i - width] + gray[i - 1] + gray[i + 1] + gray[i + width] - 4 * gray[i];
      sum += value;
      sumSq += value * value;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

export async function assessFaceQuality(source, { requireSingle = false } = {}) {
  let bitmap = null;
  try {
    bitmap = source instanceof File ? await createImageBitmap(source) : null;
  } catch {
    bitmap = null;
  }

  if (source instanceof File) {
    if (source.size < 20_000) {
      return {
        ok: false,
        reason: "Photo quality is too low. Please reupload a clearer, higher-quality photo.",
      };
    }
    if (bitmap && Math.min(bitmap.width, bitmap.height) < 360) {
      bitmap.close();
      return {
        ok: false,
        reason: "Photo is too small. Please reupload a good-quality photo (at least 360px).",
      };
    }
  }

  const faces = await detectFacesFromSource(source);
  if (bitmap) bitmap.close();

  if (!faces.length) {
    return {
      ok: false,
      reason: "No clear face found. Please reupload a good-quality photo with your face visible.",
      faces: [],
    };
  }

  if (requireSingle && faces.length > 1) {
    return {
      ok: false,
      reason: "Multiple faces found. Please upload one clear photo of only you.",
      faces,
    };
  }

  const canvas =
    source instanceof File ? await canvasFromFile(source) : await canvasFromUrl(source);
  const ranked = [...faces].sort(
    (a, b) => b.box.width * b.box.height - a.box.width * a.box.height
  );
  const best = ranked[0];
  const faceRatio = Math.min(best.box.width / canvas.width, best.box.height / canvas.height);
  if (faceRatio < 0.12 || Math.min(best.box.width, best.box.height) < 80) {
    return {
      ok: false,
      reason: "Face is too small or far away. Please reupload a closer, clearer photo.",
      faces,
      bestFace: best,
    };
  }

  if ((best.score || 0) > 0 && best.score < 0.35) {
    return {
      ok: false,
      reason: "Face is not clear enough. Please reupload a sharper front-facing photo.",
      faces,
      bestFace: best,
    };
  }

  const crop = cropBox(canvas, best.box, 0.15);
  const sharpness = laplacianVariance(crop);
  if (sharpness < 18) {
    return {
      ok: false,
      reason: "Photo looks blurry. Please reupload a sharp, good-quality photo.",
      faces,
      bestFace: best,
      sharpness,
    };
  }

  return {
    ok: true,
    reason: "",
    faces,
    bestFace: best,
    sharpness,
    faceRatio,
  };
}

export function flattenFaceRecords(faces) {
  return (faces || []).map((face) => {
    const descriptors = uniqueDescriptors(
      face.descriptors || (face.descriptor ? [face.descriptor] : []),
      MAX_DESCRIPTORS_PER_FACE
    );
    return {
      descriptors,
      descriptor: descriptors[0],
      box: face.box,
      score: face.score || 0,
    };
  }).filter((face) => face.descriptors.length);
}

function storedDescriptors(face) {
  const raw =
    Array.isArray(face?.descriptors) && face.descriptors.length
      ? face.descriptors
      : face?.descriptor
        ? [face.descriptor]
        : [];
  return raw.filter((item) => Array.isArray(item) && item.length >= 64);
}

export function faceDistance(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 64) return 1;
  if (a.length >= 256) {
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    return Math.max(0, Math.min(2, 1 - dot));
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

/** Best same-dimension descriptor-pair distance for a photo. */
function photoMatchDistance(queryDescriptors, faces) {
  const queries = (queryDescriptors || []).filter((item) => item?.length >= 64);
  let best = Infinity;
  for (const face of faces || []) {
    for (const stored of storedDescriptors(face)) {
      for (const query of queries) {
        if (query.length !== stored.length) continue;
        const distance = faceDistance(query, stored);
        if (distance < best) best = distance;
      }
    }
  }
  return best;
}

export function rankPhotos(queryDescriptors, index, photos) {
  const rows = [];
  for (const photo of photos) {
    const record = index[photo.id];
    const distance = photoMatchDistance(queryDescriptors, record?.faces || []);
    if (Number.isFinite(distance)) {
      rows.push({ photo, distance });
    }
  }
  rows.sort((a, b) => a.distance - b.distance);
  return rows;
}

export function matchPhotos(queryDescriptors, index, photos) {
  return rankPhotos(queryDescriptors, index, photos).filter(
    (row) => row.distance <= MATCH_DISTANCE
  );
}

export function uncertainPhotos(queryDescriptors, index, photos) {
  return rankPhotos(queryDescriptors, index, photos).filter(
    (row) => row.distance > MATCH_DISTANCE && row.distance <= UNCERTAIN_DISTANCE
  );
}

export async function loadFaceVersions() {
  const response = await fetch("/api/faces/status");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Could not load face status");
  }
  return data.versions || {};
}

/**
 * Public face search — selfie file only (multipart).
 * Server generates buffalo_l embeddings; client never sends descriptors.
 */
export async function searchFacesOnServer({ file = null } = {}) {
  if (!file) {
    throw new Error("Upload a selfie image to search.");
  }
  const form = new FormData();
  form.append("image", file, file.name || "selfie.jpg");
  const response = await fetch("/api/faces/search", {
    method: "POST",
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Face search failed");
  }
  return {
    matches: data.matches || [],
    uncertain: data.uncertain || [],
    indexedCount: data.indexedCount,
    photoCount: data.photoCount,
    thresholds: data.thresholds,
    model: data.model,
    version: data.version,
  };
}

/** @deprecated Public indexing disabled — admin reindex only. */
export async function saveFaceRecord() {
  throw new Error("Public face indexing is disabled. Use Admin → Re-index faces.");
}

export async function deleteFaceRecord(id) {
  await fetch(`/api/faces?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
