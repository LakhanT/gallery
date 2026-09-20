import * as ort from "onnxruntime-web/wasm";

const MODEL_URL = "/models/arcface/w600k_mbf.onnx";
const MODEL_CDN = "https://huggingface.co/WeChat/buffalo_sc/resolve/main/w600k_mbf.onnx";
const FACE_SIZE = 112;
const ORT_WASM_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";

/** InsightFace ArcFace 5-point template for 112×112 */
const ARC_FACE_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let session = null;
let sessionLoading = null;
let inputName = "input.1";
let outputName = null;

function setWasmPaths() {
  ort.env.wasm.wasmPaths = ORT_WASM_CDN;
  ort.env.wasm.numThreads = 1;
}

/** Similarity transform (Umeyama) mapping src → dst points. */
function estimateSimilarityTransform(src, dst) {
  const n = src.length;
  let srcMeanX = 0;
  let srcMeanY = 0;
  let dstMeanX = 0;
  let dstMeanY = 0;
  for (let i = 0; i < n; i += 1) {
    srcMeanX += src[i][0];
    srcMeanY += src[i][1];
    dstMeanX += dst[i][0];
    dstMeanY += dst[i][1];
  }
  srcMeanX /= n;
  srcMeanY /= n;
  dstMeanX /= n;
  dstMeanY /= n;

  let srcVar = 0;
  let cov00 = 0;
  let cov01 = 0;
  let cov10 = 0;
  let cov11 = 0;
  for (let i = 0; i < n; i += 1) {
    const sx = src[i][0] - srcMeanX;
    const sy = src[i][1] - srcMeanY;
    const dx = dst[i][0] - dstMeanX;
    const dy = dst[i][1] - dstMeanY;
    srcVar += sx * sx + sy * sy;
    cov00 += sx * dx;
    cov01 += sx * dy;
    cov10 += sy * dx;
    cov11 += sy * dy;
  }
  srcVar /= n;
  cov00 /= n;
  cov01 /= n;
  cov10 /= n;
  cov11 /= n;

  // SVD of 2x2 covariance via closed form
  const det = cov00 * cov11 - cov01 * cov10;
  const s = [1, det < 0 ? -1 : 1];

  // Eigen of cov^T cov
  const a = cov00 * cov00 + cov10 * cov10;
  const b = cov00 * cov01 + cov10 * cov11;
  const c = cov01 * cov01 + cov11 * cov11;
  const trace = a + c;
  const diff = a - c;
  const halfDisc = Math.sqrt(Math.max(0, diff * diff + 4 * b * b)) / 2;
  const eig1 = trace / 2 + halfDisc;
  const eig2 = trace / 2 - halfDisc;

  let u00 = 1;
  let u10 = 0;
  if (Math.abs(b) > 1e-10 || Math.abs(diff) > 1e-10) {
    if (Math.abs(b) > Math.abs(diff)) {
      u00 = eig1 - c;
      u10 = b;
    } else {
      u00 = b;
      u10 = eig1 - a;
    }
    const norm = Math.hypot(u00, u10) || 1;
    u00 /= norm;
    u10 /= norm;
  }
  const u01 = -u10;
  const u11 = u00;

  // V from cov * U
  let v00 = cov00 * u00 + cov01 * u10;
  let v10 = cov10 * u00 + cov11 * u10;
  let v01 = cov00 * u01 + cov01 * u11;
  let v11 = cov10 * u01 + cov11 * u11;
  const n0 = Math.hypot(v00, v10) || 1;
  v00 /= n0;
  v10 /= n0;
  const n1 = Math.hypot(v01, v11) || 1;
  v01 /= n1;
  v11 /= n1;

  // Ensure proper rotation
  const detU = u00 * u11 - u01 * u10;
  const detV = v00 * v11 - v01 * v10;
  if (detU * detV < 0) {
    v01 *= -1;
    v11 *= -1;
    s[1] *= -1;
  }

  const r00 = v00 * u00 + v01 * u10;
  const r01 = v00 * u01 + v01 * u11;
  const r10 = v10 * u00 + v11 * u10;
  const r11 = v10 * u01 + v11 * u11;

  const scale = srcVar > 1e-10 ? (Math.sqrt(Math.max(0, eig1)) * s[0] + Math.sqrt(Math.max(0, eig2)) * s[1]) / srcVar : 1;

  const m00 = scale * r00;
  const m01 = scale * r01;
  const m10 = scale * r10;
  const m11 = scale * r11;
  const tx = dstMeanX - (m00 * srcMeanX + m01 * srcMeanY);
  const ty = dstMeanY - (m10 * srcMeanX + m11 * srcMeanY);

  return [m00, m01, tx, m10, m11, ty];
}

function fivePointsFromLandmarks(positions) {
  if (!positions || positions.length < 68) return null;
  const avg = (indexes) => {
    let x = 0;
    let y = 0;
    for (const i of indexes) {
      x += positions[i].x;
      y += positions[i].y;
    }
    return [x / indexes.length, y / indexes.length];
  };
  return [
    avg([36, 37, 38, 39, 40, 41]),
    avg([42, 43, 44, 45, 46, 47]),
    [positions[30].x, positions[30].y],
    [positions[48].x, positions[48].y],
    [positions[54].x, positions[54].y],
  ];
}

function fivePointsFromBox(box) {
  const { x, y, width, height } = box;
  return [
    [x + width * 0.3, y + height * 0.38],
    [x + width * 0.7, y + height * 0.38],
    [x + width * 0.5, y + height * 0.55],
    [x + width * 0.35, y + height * 0.75],
    [x + width * 0.65, y + height * 0.75],
  ];
}

function warpFace(sourceCanvas, matrix) {
  const out = document.createElement("canvas");
  out.width = FACE_SIZE;
  out.height = FACE_SIZE;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(matrix[0], matrix[3], matrix[1], matrix[4], matrix[2], matrix[5]);
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

function canvasToArcFaceTensor(aligned) {
  const { data } = aligned.getContext("2d").getImageData(0, 0, FACE_SIZE, FACE_SIZE);
  const float = new Float32Array(3 * FACE_SIZE * FACE_SIZE);
  const plane = FACE_SIZE * FACE_SIZE;
  for (let i = 0; i < plane; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // InsightFace expects BGR, normalized to [-1, 1]
    float[i] = (b - 127.5) / 127.5;
    float[plane + i] = (g - 127.5) / 127.5;
    float[plane * 2 + i] = (r - 127.5) / 127.5;
  }
  return new ort.Tensor("float32", float, [1, 3, FACE_SIZE, FACE_SIZE]);
}

function l2Normalize(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i] * values[i];
  const norm = Math.sqrt(sum) || 1;
  return Array.from(values, (v) => v / norm);
}

export async function loadArcFaceModel() {
  if (session) return session;
  if (sessionLoading) return sessionLoading;

  sessionLoading = (async () => {
    setWasmPaths();
    const providers = [];
    try {
      providers.push("webgpu");
    } catch {
      /* ignore */
    }
    providers.push("wasm");

    let lastError = null;
    const modelUrls = [MODEL_URL, MODEL_CDN];
    outer: for (const modelUrl of modelUrls) {
      for (const ep of providers) {
        try {
          session = await ort.InferenceSession.create(modelUrl, {
            executionProviders: [ep],
            graphOptimizationLevel: "all",
          });
          break outer;
        } catch (error) {
          lastError = error;
        }
      }
    }
    if (!session) {
      throw lastError || new Error("Could not load ArcFace model");
    }
    inputName = session.inputNames[0] || "input.1";
    outputName = session.outputNames[0];
    return session;
  })();

  try {
    return await sessionLoading;
  } catch (error) {
    sessionLoading = null;
    throw error;
  }
}

/**
 * Build a 512-d L2-normalized ArcFace embedding from a detected face.
 * Prefer 68 landmarks for alignment; fall back to box estimate.
 */
export async function embedArcFace(sourceCanvas, { landmarks, box, requireLandmarks = false } = {}) {
  await loadArcFaceModel();
  const fromLandmarks = fivePointsFromLandmarks(landmarks?.positions || landmarks);
  if (requireLandmarks && !fromLandmarks) return null;
  const points = fromLandmarks || (box ? fivePointsFromBox(box) : null);
  if (!points) return null;

  const matrix = estimateSimilarityTransform(points, ARC_FACE_DST);
  const aligned = warpFace(sourceCanvas, matrix);
  const tensor = canvasToArcFaceTensor(aligned);
  const feeds = { [inputName]: tensor };
  const result = await session.run(feeds);
  const out = result[outputName];
  if (!out?.data?.length) return null;
  return l2Normalize(out.data);
}

export function isArcFaceReady() {
  return Boolean(session);
}
