const MODEL_URL = "/models";
export const SCAN_VERSION = 3;
const MATCH_DISTANCE = 0.52;
const MIN_FACE_SIZE = 24;
const MIN_SIDE = 320;
const MAX_SIDE = 720;
const MEDIAPIPE_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm";
const MEDIAPIPE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/latest/blaze_face_full_range.tflite";

let faceapi = null;
let poseDetector = null;
let modelsReady = false;
let modelsLoading = null;

export async function loadFaceModels() {
  if (modelsReady) return faceapi;
  if (modelsLoading) return modelsLoading;

  modelsLoading = (async () => {
    faceapi = await import("@vladmandic/face-api");
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    try {
      const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      poseDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MEDIAPIPE_MODEL,
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.2,
        minSuppressionThreshold: 0.25,
      });
    } catch {
      try {
        const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
        poseDetector = await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MEDIAPIPE_MODEL,
            delegate: "CPU",
          },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.2,
          minSuppressionThreshold: 0.25,
        });
      } catch {
        poseDetector = null;
      }
    }
    modelsReady = true;
    return faceapi;
  })();

  try {
    return await modelsLoading;
  } catch (error) {
    modelsLoading = null;
    throw error;
  }
}

function canvasFromBitmap(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height);
  const shortest = Math.min(bitmap.width, bitmap.height);
  let scale = shortest < MIN_SIDE ? MIN_SIDE / shortest : 1;
  if (longest * scale > MAX_SIDE) scale = MAX_SIDE / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function canvasFromUrl(url) {
  const response = await fetch(url, { mode: "cors" });
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

function rotateCanvas(source, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * cos + source.height * sin);
  canvas.height = Math.round(source.width * sin + source.height * cos);
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function cropBox(canvas, box, pad = 0.45) {
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

function mediaPipeBoxes(canvas) {
  if (!poseDetector) return [];
  const result = poseDetector.detect(canvas);
  return (result?.detections || [])
    .map((item) => {
      const box = item.boundingBox;
      return {
        x: box.originX,
        y: box.originY,
        width: box.width,
        height: box.height,
      };
    })
    .filter((box) => box.width >= MIN_FACE_SIZE && box.height >= MIN_FACE_SIZE);
}

async function faceApiBoxes(api, canvas) {
  const tiny = await api.detectAllFaces(
    canvas,
    new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.15 })
  );
  let detected = tiny;
  if (!detected.length) {
    detected = await api.detectAllFaces(
      canvas,
      new api.SsdMobilenetv1Options({ minConfidence: 0.2 })
    );
  }
  return detected
    .map((item) => item.box || item.detection?.box)
    .filter(Boolean)
    .map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height }))
    .filter((box) => box.width >= MIN_FACE_SIZE && box.height >= MIN_FACE_SIZE);
}

function mergeBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => b.width * b.height - a.width * a.height);
  const kept = [];
  for (const box of sorted) {
    if (kept.some((other) => iou(box, other) > 0.35)) continue;
    kept.push(box);
  }
  return kept;
}

async function descriptorFromCrop(api, crop) {
  try {
    const aligned = await api
      .detectSingleFace(crop, new api.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.12 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (aligned?.descriptor) return Array.from(aligned.descriptor);
  } catch {
    /* use fallback */
  }
  const square = document.createElement("canvas");
  square.width = 150;
  square.height = 150;
  square.getContext("2d").drawImage(crop, 0, 0, 150, 150);
  const desc = await api.nets.faceRecognitionNet.computeFaceDescriptor(square);
  return Array.from(desc);
}

function compactDescriptor(values) {
  return values.map((value) => Math.round(Number(value) * 1e6) / 1e6);
}

async function descriptorsForBox(api, canvas, box) {
  const crop = cropBox(canvas, box, 0.45);
  const values = [];
  for (const view of [crop, flipHorizontal(crop)]) {
    const desc = await descriptorFromCrop(api, view);
    if (desc?.length) values.push(compactDescriptor(desc));
  }
  return values;
}

export function flattenFaceRecords(faces) {
  return (faces || []).flatMap((face) => {
    const descriptors = (face.descriptors || (face.descriptor ? [face.descriptor] : []))
      .filter((item) => item?.length)
      .slice(0, 2);
    return descriptors.map((descriptor) => ({
      descriptor: compactDescriptor(descriptor),
      box: face.box,
    }));
  });
}

function storedDescriptors(face) {
  if (Array.isArray(face?.descriptors) && face.descriptors.length) return face.descriptors;
  if (face?.descriptor) return [face.descriptor];
  return [];
}

async function boxesOnCanvas(api, canvas) {
  const fromPose = mediaPipeBoxes(canvas);
  if (fromPose.length) return mergeBoxes(fromPose);
  return mergeBoxes(await faceApiBoxes(api, canvas));
}

export async function detectFacesFromSource(source) {
  const api = await loadFaceModels();
  const canvas = source instanceof File ? await canvasFromFile(source) : await canvasFromUrl(source);
  const boxes = await boxesOnCanvas(api, canvas);
  const faces = [];
  for (const box of boxes) {
    const descriptors = await descriptorsForBox(api, canvas, box);
    if (!descriptors.length) continue;
    faces.push({
      descriptors,
      box,
      preview: previewFromBox(canvas, box),
    });
  }
  return faces;
}

export function faceDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

export function matchPhotos(queryDescriptors, index, photos) {
  const queries = (queryDescriptors || []).filter((item) => item?.length);
  const rows = [];
  for (const photo of photos) {
    const record = index[photo.id];
    const faces = record?.faces || [];
    let best = Infinity;
    for (const face of faces) {
      for (const stored of storedDescriptors(face)) {
        for (const query of queries) {
          const distance = faceDistance(query, stored);
          if (distance < best) best = distance;
        }
      }
    }
    if (best <= MATCH_DISTANCE) {
      rows.push({ photo, distance: best });
    }
  }
  rows.sort((a, b) => a.distance - b.distance);
  return rows;
}

export async function loadFaceIndex() {
  const response = await fetch("/api/faces");
  if (!response.ok) {
    throw new Error("Could not load the face index");
  }
  const data = await response.json();
  return data.index || {};
}

export async function saveFaceRecord(id, faces) {
  const payload = flattenFaceRecords(faces);
  let lastError = new Error("Could not save face data");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("/api/faces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, faces: payload, version: SCAN_VERSION }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    lastError = new Error(data.error || "Could not save face data");
    await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw lastError;
}

export async function deleteFaceRecord(id) {
  await fetch(`/api/faces?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}
