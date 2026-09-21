import { createStore, errorResponse, jsonResponse } from "../../../lib/store.js";
import { faceServiceDetectEmbed } from "../../../lib/face-client.js";
import {
  FACE_DIM,
  FACE_EMBEDDING_VERSION,
  FACE_MIN_QUALITY_SCORE,
  FACE_MODEL,
} from "../../../lib/face-config.js";
import { isValidArcFaceEmbedding } from "../../../lib/face-validate.js";

/**
 * Public face search — multipart selfie only.
 *
 * Browser → POST multipart → Pages Function → FastAPI /detect-embed
 * → SCRFD + ArcFace buffalo_l → 512-d → D1 match → ranked photos.
 *
 * Never accepts client-supplied embeddings.
 * Never returns the face index or raw embeddings.
 */
export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    const contentType = context.request.headers.get("content-type") || "";

    if (!contentType.includes("multipart/form-data")) {
      throw Object.assign(
        new Error(
          "Public face search requires multipart/form-data with an image field. Client-supplied embeddings are not accepted."
        ),
        { status: 400 }
      );
    }

    const form = await context.request.formData();
    const file = form.get("image") || form.get("file");
    if (!file || typeof file === "string") {
      throw Object.assign(new Error("Upload a selfie image."), { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const result = await faceServiceDetectEmbed(
      context.env,
      new Blob([bytes], { type: file.type || "image/jpeg" }),
      file.name || "selfie.jpg"
    );

    const faces = result.faces || [];
    if (!faces.length) {
      throw Object.assign(
        new Error("No clear face found. Use a front-facing selfie with good lighting."),
        { status: 400 }
      );
    }

    const best = faces[0];
    if ((best.quality_score ?? 1) < FACE_MIN_QUALITY_SCORE) {
      throw Object.assign(new Error("Selfie quality is too low. Try again."), { status: 400 });
    }

    const descriptors = faces
      .slice(0, 3)
      .map((f) => f.embedding)
      .filter((e) => isValidArcFaceEmbedding(e));

    if (!descriptors.length) {
      throw Object.assign(
        new Error("Face service returned invalid embeddings."),
        { status: 502 }
      );
    }

    const searchResult = await store.searchFaces(descriptors, "");
    return jsonResponse({
      ...searchResult,
      model: FACE_MODEL,
      version: FACE_EMBEDDING_VERSION,
      dim: FACE_DIM,
    });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
