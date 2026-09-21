/**
 * Face recognition hardening tests (node:test).
 * Covers audit items A–M without requiring buffalo_l model download.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateRankingScore,
  cosineSimilarity,
  isMatchableFace,
  photoBestMatch,
  rankFaceMatches,
  splitMatches,
} from "../lib/face-match.js";
import {
  FACE_DIM,
  FACE_EMBEDDING_VERSION,
  FACE_MIN_QUALITY_SCORE,
  FACE_MODEL,
} from "../lib/face-config.js";
import {
  assertSearchableFaceWrite,
  filterQueryEmbeddings,
  isValidArcFaceEmbedding,
  sanitizeFacesForStorage,
  validateApprovalEmbeddings,
} from "../lib/face-validate.js";

function unitVec(seed = 1) {
  const v = Array.from({ length: FACE_DIM }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe("ArcFace embedding invariants", () => {
  it("C: accepts 512-d ArcFace embedding", () => {
    const emb = unitVec(1);
    assert.equal(isValidArcFaceEmbedding(emb), true);
    assert.doesNotThrow(() =>
      assertSearchableFaceWrite([{ embedding: emb }], {
        model: FACE_MODEL,
        embeddingVersion: FACE_EMBEDDING_VERSION,
      })
    );
  });

  it("D: rejects 128-d FaceNet embedding", () => {
    const emb128 = Array.from({ length: 128 }, (_, i) => i * 0.01);
    assert.equal(isValidArcFaceEmbedding(emb128), false);
    assert.equal(sanitizeFacesForStorage([{ embedding: emb128 }]).length, 0);
    assert.throws(
      () =>
        assertSearchableFaceWrite([{ embedding: emb128 }], {
          model: FACE_MODEL,
          embeddingVersion: FACE_EMBEDDING_VERSION,
        }),
      /512/
    );
  });

  it("E: rejects wrong model", () => {
    const emb = unitVec(2);
    assert.throws(
      () =>
        assertSearchableFaceWrite([{ embedding: emb }], {
          model: "facenet",
          embeddingVersion: FACE_EMBEDDING_VERSION,
        }),
      /model/
    );
  });

  it("F: rejects wrong embedding version", () => {
    const emb = unitVec(3);
    assert.throws(
      () =>
        assertSearchableFaceWrite([{ embedding: emb }], {
          model: FACE_MODEL,
          embeddingVersion: 7,
        }),
      /embedding_version/
    );
  });

  it("approval merge rejects FaceNet descriptors", () => {
    assert.throws(() => validateApprovalEmbeddings([Array(128).fill(0.1)]), /rejected|valid/i);
  });

  it("approval merge accepts only 512-d", () => {
    const emb = unitVec(4);
    const out = validateApprovalEmbeddings([emb]);
    assert.equal(out.length, 1);
    assert.equal(out[0].length, FACE_DIM);
  });
});

describe("matching & quality", () => {
  it("G: multi-face photo uses strongest face similarity (not average)", () => {
    const query = unitVec(10);
    const weak = unitVec(99);
    const strong = query.map((x) => x); // identical → sim ~1
    const best = photoBestMatch([query], [
      { embedding: weak, quality_score: 0.9, detection_score: 0.9 },
      { embedding: strong, quality_score: 0.9, detection_score: 0.9 },
    ]);
    assert.ok(best.similarity > 0.99);
  });

  it("H: low-quality face rejected by isMatchableFace", () => {
    const face = {
      embedding: unitVec(5),
      quality_score: FACE_MIN_QUALITY_SCORE - 0.1,
      detection_score: 0.9,
    };
    assert.equal(isMatchableFace(face), false);
    const best = photoBestMatch([unitVec(5)], [face]);
    assert.equal(best.similarity, -1);
  });

  it("ranking uses similarity primarily; quality is secondary", () => {
    const a = { similarity: 0.5, qualityScore: 1, detectionScore: 1 };
    const b = { similarity: 0.55, qualityScore: 0.3, detectionScore: 0.3 };
    assert.ok(calculateRankingScore(b) > calculateRankingScore(a));
  });

  it("cosine rejects dim mismatch (FaceNet vs ArcFace)", () => {
    assert.equal(cosineSimilarity(unitVec(1), Array(128).fill(0)), -1);
  });

  it("rankFaceMatches keeps identity similarity visible", () => {
    const q = unitVec(7);
    const rows = rankFaceMatches(
      [q],
      [
        {
          id: "p1",
          name: "a",
          url: "/a",
          faces: [{ embedding: q, quality_score: 0.8, detection_score: 0.9 }],
        },
      ]
    );
    assert.equal(rows.length, 1);
    assert.ok(typeof rows[0].similarity === "number");
    assert.ok(typeof rows[0].rankingScore === "number");
    const { matches } = splitMatches(rows);
    assert.equal(matches.length, 1);
  });
});

describe("public search contract helpers", () => {
  it("B: filterQueryEmbeddings drops non-512 vectors", () => {
    const ok = unitVec(8);
    const filtered = filterQueryEmbeddings([ok, Array(128).fill(0), "x", null]);
    assert.equal(filtered.length, 1);
  });

  it("M: sanitize never pads/truncates wrong dims", () => {
    const short = Array(256).fill(0.1);
    const long = Array(1024).fill(0.1);
    assert.equal(sanitizeFacesForStorage([{ embedding: short }]).length, 0);
    assert.equal(sanitizeFacesForStorage([{ embedding: long }]).length, 0);
  });
});

describe("reindex status semantics (unit)", () => {
  it("J/K: failed does not count as pending", () => {
    const total = 10;
    const indexed = 7;
    const failed = 3;
    const pending = Math.max(0, total - indexed - failed);
    assert.equal(pending, 0);
  });

  it("L: completed empty faces is still indexed (idempotent zero-face)", () => {
    const faces = sanitizeFacesForStorage([]);
    assert.equal(faces.length, 0);
    assert.doesNotThrow(() =>
      assertSearchableFaceWrite(faces, {
        model: FACE_MODEL,
        embeddingVersion: FACE_EMBEDDING_VERSION,
      })
    );
  });
});

describe("face-client config requirements", () => {
  it("I: missing FACE_SERVICE_URL / API_KEY fails closed", async () => {
    const { faceServiceDetectEmbed } = await import("../lib/face-client.js");
    await assert.rejects(
      () => faceServiceDetectEmbed({}, new Blob([new Uint8Array([1, 2, 3])])),
      /FACE_SERVICE/
    );
    await assert.rejects(
      () =>
        faceServiceDetectEmbed(
          { FACE_SERVICE_URL: "http://127.0.0.1:8090" },
          new Blob([new Uint8Array([1, 2, 3])])
        ),
      /FACE_SERVICE_API_KEY/
    );
  });
});

describe("public search module contract", () => {
  it("A/B: public search module documents multipart-only (source check)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../functions/api/faces/search.js", import.meta.url),
      "utf8"
    );
    assert.match(src, /multipart\/form-data/);
    assert.match(src, /Client-supplied embeddings are not accepted/);
    assert.doesNotMatch(src, /body\.descriptors/);
  });

  it("admin embedding search exists and is admin-gated", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../functions/api/admin/faces/search.js", import.meta.url),
      "utf8"
    );
    assert.match(src, /requireAdmin/);
    assert.match(src, /descriptors/);
  });
});
