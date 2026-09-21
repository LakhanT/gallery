import { createStore, errorResponse, jsonResponse } from "../../../../lib/store.js";
import { FACE_DIM, FACE_EMBEDDING_VERSION, FACE_MODEL } from "../../../../lib/face-config.js";
import { filterQueryEmbeddings, isValidArcFaceEmbedding } from "../../../../lib/face-validate.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/**
 * Admin-only embedding search for calibration / debug.
 * Accepts JSON 512-d ArcFace embeddings. Never returns raw gallery embeddings.
 */
export async function onRequestPost(context) {
  try {
    const store = createStore(context.env, new URL(context.request.url).origin);
    await store.requireAdmin(context.request);

    const body = await readJson(context.request);
    const raw = body.descriptors || body.embeddings || [];
    let descriptors = filterQueryEmbeddings(Array.isArray(raw) ? raw : []);
    if (!descriptors.length && isValidArcFaceEmbedding(body.embedding)) {
      descriptors = [body.embedding];
    }
    if (!descriptors.length) {
      throw Object.assign(
        new Error(`Send 512-d ArcFace embeddings (model ${FACE_MODEL}, version ${FACE_EMBEDDING_VERSION}).`),
        { status: 400 }
      );
    }

    const rejected = (Array.isArray(raw) ? raw : []).filter((item) => !isValidArcFaceEmbedding(item));
    if (rejected.length) {
      throw Object.assign(
        new Error(
          `Rejected ${rejected.length} invalid embedding(s). Only ${FACE_DIM}-d ArcFace is allowed.`
        ),
        { status: 400 }
      );
    }

    const result = await store.searchFaces(descriptors, body.queryPreview || "");
    return jsonResponse({
      ...result,
      model: FACE_MODEL,
      version: FACE_EMBEDDING_VERSION,
      dim: FACE_DIM,
      admin: true,
    });
  } catch (error) {
    return errorResponse(error, error.status || 400);
  }
}
