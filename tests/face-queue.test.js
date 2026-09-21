import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeQueuePayload,
  buildIndexQueueMessage,
  buildSearchQueueMessage,
  enqueueFaceSearchMessage,
  hasDurableSearchQueue,
  isPermanentFaceError,
  isTransientFaceError,
  SEARCH_QUEUE_NAME,
  tempSelfieObjectKey,
} from "../lib/face-queue.js";
import { createLocalStore } from "../lib/local-store.js";
import {
  JOB_COMPLETED,
  JOB_FAILED,
  JOB_QUEUED,
  acceptFaceSearchJob,
  processFaceSearchJobSynthetic,
} from "../lib/face-search-job.js";

describe("face-queue message contract", () => {
  it("builds search messages with identifiers only", () => {
    const msg = buildSearchQueueMessage({
      jobId: "abc",
      objectKey: "tmp/face-search/abc",
      attempt: 2,
    });
    assert.equal(msg.type, "face-search");
    assert.equal(msg.jobId, "abc");
    assert.equal(msg.objectKey, "tmp/face-search/abc");
    assert.equal(msg.attempt, 2);
    assert.equal(msg.version, 1);
    assert.ok(!("image" in msg));
    assert.ok(!("embedding" in msg));
  });

  it("builds index messages with photoId only", () => {
    const msg = buildIndexQueueMessage({ photoId: "photo-1" });
    assert.equal(msg.type, "face-index");
    assert.equal(msg.photoId, "photo-1");
    assert.ok(!("bytes" in msg));
  });

  it("rejects unsafe payload fields", () => {
    assert.throws(() => assertSafeQueuePayload({ jobId: "x", image: "nope" }));
    assert.throws(() => assertSafeQueuePayload({ jobId: "x", embedding: [] }));
    assert.throws(() => assertSafeQueuePayload({ jobId: "x", apiKey: "secret" }));
  });

  it("temp object key is private tmp path", () => {
    assert.equal(tempSelfieObjectKey("jid1"), "tmp/face-search/jid1");
  });

  it("queue name constants match preferred production names", () => {
    assert.equal(SEARCH_QUEUE_NAME, "gallery-face-search");
  });
});

describe("error classification", () => {
  it("marks capacity/timeouts transient", () => {
    assert.equal(isTransientFaceError({ status: 503 }), true);
    assert.equal(isTransientFaceError({ status: 429 }), true);
    assert.equal(isTransientFaceError({ message: "timeout" }), true);
  });

  it("marks invalid image permanent", () => {
    assert.equal(isPermanentFaceError({ status: 400 }), true);
    assert.equal(isPermanentFaceError({ status: 413 }), true);
    assert.equal(isPermanentFaceError({ message: "No clear face found" }), true);
    assert.equal(isPermanentFaceError({ message: "expired" }), true);
  });
});

describe("durable vs local dispatch", () => {
  it("detects missing durable queue binding", () => {
    assert.equal(hasDurableSearchQueue({}), false);
    assert.equal(hasDurableSearchQueue({ FACE_SEARCH_QUEUE: {} }), false);
  });

  it("enqueueFaceSearchMessage sends identifier payload only", async () => {
    const sent = [];
    const env = {
      FACE_SEARCH_QUEUE: {
        send: async (body) => {
          sent.push(body);
        },
      },
    };
    const ok = await enqueueFaceSearchMessage(env, {
      jobId: "job-9",
      objectKey: "tmp/face-search/job-9",
      attempt: 1,
    });
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jobId, "job-9");
    assert.ok(!("image" in sent[0]));
    assert.ok(!("embedding" in sent[0]));
  });
});

describe("claim idempotency (local store)", () => {
  it("second claim fails while fresh processing hold exists", async () => {
    const store = createLocalStore("http://localhost", {});
    const id = `claim-${Date.now()}`;
    await store.createFaceSearchJob({
      id,
      status: JOB_QUEUED,
      imageSha256: "abc",
      clientKey: "t",
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = await store.claimFaceSearchJob(id);
    const second = await store.claimFaceSearchJob(id);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    const job = await store.getFaceSearchJob(id);
    assert.equal(job.status, "processing");
    assert.equal(job.attemptCount, 1);
  });

  it("completed job is not reclaimed", async () => {
    const store = createLocalStore("http://localhost", {});
    const id = `done-${Date.now()}`;
    await store.createFaceSearchJob({
      id,
      status: JOB_COMPLETED,
      imageSha256: "abc",
      clientKey: "t",
      error: null,
      result: { matches: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const claim = await store.claimFaceSearchJob(id);
    assert.equal(claim.claimed, false);
  });
});

describe("accept + synthetic process (local)", () => {
  it("creates job and completes without embedding leakage", async () => {
    const store = createLocalStore("http://localhost", {});
    // minimal jpeg-ish bytes
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);
    const accepted = await acceptFaceSearchJob({
      store,
      env: {
        FACE_SEARCH_SYNTHETIC: "1",
        FACE_SEARCH_SYNTHETIC_MS: "1",
        MAX_SEARCH_QUEUE: "100",
      },
      imageBytes: bytes.buffer,
      contentType: "image/jpeg",
      filename: "t.jpg",
      clientKey: "test",
      schedule: (fn) => fn(),
    });
    assert.equal(accepted.httpStatus, 202);
    assert.ok(accepted.body.jobId);
    await processFaceSearchJobSynthetic(store, {}, accepted.body.jobId);
    const job = await store.getFaceSearchJob(accepted.body.jobId);
    assert.equal(job.status, JOB_COMPLETED);
    assert.equal(job.result?.synthetic, true);
    assert.ok(!job.result?.embedding);
    assert.ok(!("selfie" in job));
  });

  it("failed permanent status stays failed", async () => {
    const store = createLocalStore("http://localhost", {});
    const id = `fail-${Date.now()}`;
    await store.createFaceSearchJob({
      id,
      status: JOB_FAILED,
      imageSha256: "x",
      clientKey: "t",
      error: "bad",
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const claim = await store.claimFaceSearchJob(id);
    assert.equal(claim.claimed, false);
  });
});
