const MODEL_URL = "/models";
const MATCH_DISTANCE = 0.55;
const LOOSE_DISTANCE = 0.62;

let faceapi = null;
let modelsReady = false;
let modelsLoading = null;

export async function loadFaceModels() {
  if (modelsReady) return faceapi;
  if (modelsLoading) return modelsLoading;

  modelsLoading = (async () => {
    faceapi = await import("@vladmandic/face-api");
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
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

async function canvasFromUrl(url) {
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) {
    throw new Error("Could not open that photo");
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const max = 900;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function canvasFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const max = 900;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

function cropFace(canvas, box) {
  const pad = 0.25;
  const x = Math.max(0, box.x - box.width * pad);
  const y = Math.max(0, box.y - box.height * pad);
  const width = Math.min(canvas.width - x, box.width * (1 + pad * 2));
  const height = Math.min(canvas.height - y, box.height * (1 + pad * 2));
  const cut = document.createElement("canvas");
  cut.width = 96;
  cut.height = 96;
  cut.getContext("2d").drawImage(canvas, x, y, width, height, 0, 0, 96, 96);
  return cut.toDataURL("image/jpeg", 0.85);
}

export async function detectFacesFromSource(source) {
  const api = await loadFaceModels();
  const canvas = source instanceof File ? await canvasFromFile(source) : await canvasFromUrl(source);
  const detections = await api
    .detectAllFaces(canvas, new api.SsdMobilenetv1Options({ minConfidence: 0.38 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  return detections.map((item) => {
    const box = item.detection.box;
    return {
      descriptor: Array.from(item.descriptor),
      box: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
      preview: cropFace(canvas, box),
    };
  });
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

export function matchPhotos(queryDescriptor, index, photos) {
  const rows = [];
  for (const photo of photos) {
    const record = index[photo.id];
    const faces = record?.faces || [];
    let best = Infinity;
    for (const face of faces) {
      const distance = faceDistance(queryDescriptor, face.descriptor);
      if (distance < best) best = distance;
    }
    if (best < Infinity) {
      rows.push({ photo, distance: best });
    }
  }
  rows.sort((a, b) => a.distance - b.distance);
  const tight = rows.filter((row) => row.distance <= MATCH_DISTANCE);
  return tight.length ? tight : rows.filter((row) => row.distance <= LOOSE_DISTANCE);
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
  const payload = faces.map(({ descriptor, box }) => ({ descriptor, box }));
  const response = await fetch("/api/faces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, faces: payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Could not save face data");
  }
}

export async function deleteFaceRecord(id) {
  await fetch(`/api/faces?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}
