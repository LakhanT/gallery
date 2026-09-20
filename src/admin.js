import { unzipSync } from "fflate";

const loginPanel = document.querySelector("#login-panel");
const adminPanel = document.querySelector("#admin-panel");
const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#admin-password");
const logoutBtn = document.querySelector("#logout-btn");
const approvalList = document.querySelector("#approval-list");
const approvalEmpty = document.querySelector("#approval-empty");
const adminStats = document.querySelector("#admin-stats");
const adminUploadBtn = document.querySelector("#admin-upload-btn");
const adminFileInput = document.querySelector("#admin-file-input");
const adminRefreshPhotos = document.querySelector("#admin-refresh-photos");
const adminUploadCancel = document.querySelector("#admin-upload-cancel");
const adminUploadProgress = document.querySelector("#admin-upload-progress");
const adminUploadStatus = document.querySelector("#admin-upload-status");
const adminUploadPct = document.querySelector("#admin-upload-pct");
const adminUploadFill = document.querySelector("#admin-upload-fill");
const adminPhotoList = document.querySelector("#admin-photo-list");
const adminPhotoEmpty = document.querySelector("#admin-photo-empty");
const adminShowHidden = document.querySelector("#admin-show-hidden");
const adminDbTable = document.querySelector("#admin-db-table");
const adminDbCsv = document.querySelector("#admin-db-csv");
const adminSql = document.querySelector("#admin-sql");
const adminSqlRun = document.querySelector("#admin-sql-run");
const adminSqlResult = document.querySelector("#admin-sql-result");
const toast = document.querySelector("#toast");
const adminSub = document.querySelector("#admin-sub");

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i;

let toastTimer = 0;
let busy = false;
let uploadAbort = null;
let uploadCancelled = false;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

function setUploadProgress({ message = "", done = 0, total = 0, active = false } = {}) {
  if (!adminUploadProgress) return;
  if (!active) {
    adminUploadProgress.hidden = true;
    if (adminUploadCancel) adminUploadCancel.hidden = true;
    if (adminUploadBtn) adminUploadBtn.disabled = false;
    if (adminUploadStatus) adminUploadStatus.textContent = "";
    if (adminUploadPct) adminUploadPct.textContent = "0%";
    if (adminUploadFill) adminUploadFill.style.width = "0%";
    return;
  }

  adminUploadProgress.hidden = false;
  if (adminUploadCancel) adminUploadCancel.hidden = false;
  if (adminUploadBtn) adminUploadBtn.disabled = true;

  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.max(0, Math.min(safeTotal || done, Number(done) || 0));
  const pct = safeTotal > 0 ? Math.round((safeDone / safeTotal) * 100) : 0;

  if (adminUploadStatus) {
    adminUploadStatus.textContent =
      message ||
      (safeTotal > 0 ? `Uploading ${safeDone} of ${safeTotal}…` : "Preparing upload…");
  }
  if (adminUploadPct) adminUploadPct.textContent = `${pct}%`;
  if (adminUploadFill) adminUploadFill.style.width = `${pct}%`;
}

function cancelActiveUpload() {
  uploadCancelled = true;
  if (uploadAbort) {
    try {
      uploadAbort.abort();
    } catch {
      /* ignore */
    }
  }
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (options.signal?.aborted) {
    throw new DOMException("Upload cancelled", "AbortError");
  }
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function renderStats(counts = {}) {
  adminStats.innerHTML = `
    <div class="stat"><strong>${counts.pending || 0}</strong><span>Pending</span></div>
    <div class="stat"><strong>${counts.same || 0}</strong><span>Same</span></div>
    <div class="stat"><strong>${counts.different || 0}</strong><span>Different</span></div>
    <div class="stat"><strong>${counts.unsure || 0}</strong><span>Not sure</span></div>
  `;
  adminSub.textContent =
    (counts.pending || 0) === 1
      ? "1 uncertain match waiting for review"
      : `${counts.pending || 0} uncertain matches · manage library & DB`;
}

function renderApprovals(approvals = []) {
  approvalEmpty.hidden = approvals.length > 0;
  approvalList.replaceChildren(
    ...approvals.map((item) => {
      const card = document.createElement("article");
      card.className = "approval-card";
      card.innerHTML = `
        <p class="approval-kicker">Improve search results</p>
        <h3>Same or different person?</h3>
        <div class="approval-faces">
          <figure>
            <img src="${item.queryPreview || item.candidateUrl}" alt="Query face" />
            <figcaption>Search face</figcaption>
          </figure>
          <figure>
            <img src="${item.candidatePreview || item.candidateUrl}" alt="${item.candidateName}" />
            <figcaption>${item.candidateName}</figcaption>
          </figure>
        </div>
        <p class="approval-meta">Distance ${Number(item.distance).toFixed(3)} · needs manual review</p>
        <div class="approval-actions">
          <button class="btn btn-same" type="button" data-decision="same">Same</button>
          <button class="btn btn-diff" type="button" data-decision="different">Different</button>
          <button class="btn" type="button" data-decision="unsure">Not sure</button>
        </div>
      `;
      card.querySelectorAll("button[data-decision]").forEach((button) => {
        button.addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          try {
            const data = await api("/api/admin/approvals", {
              method: "PATCH",
              body: JSON.stringify({ id: item.id, decision: button.dataset.decision }),
            });
            showToast(
              button.dataset.decision === "same"
                ? "Marked as same person"
                : button.dataset.decision === "different"
                  ? "Marked as different"
                  : "Saved as not sure"
            );
            renderStats(data.counts);
            await loadApprovals();
          } catch (error) {
            showToast(error.message);
          } finally {
            busy = false;
          }
        });
      });
      return card;
    })
  );
}

async function loadApprovals() {
  const data = await api("/api/admin/approvals?status=pending");
  renderStats(data.counts);
  renderApprovals(data.approvals || []);
}

function renderPhotos(photos = []) {
  const showHidden = adminShowHidden?.checked !== false;
  const visible = showHidden ? photos : photos.filter((item) => !item.hidden);
  adminPhotoEmpty.hidden = visible.length > 0;
  adminPhotoList.replaceChildren(
    ...visible.map((photo) => {
      const row = document.createElement("article");
      row.className = `admin-photo-row${photo.hidden ? " is-hidden" : ""}`;
      row.innerHTML = `
        <img src="${photo.url}" alt="" loading="lazy" />
        <div class="admin-photo-meta">
          <strong>${escapeHtml(photo.name || "photo")}</strong>
          <span>${photo.hidden ? "Hidden from website" : "Visible on website"}</span>
        </div>
        <div class="admin-photo-actions">
          ${
            photo.hidden
              ? `<button class="btn" type="button" data-action="restore">Restore</button>`
              : `<button class="btn" type="button" data-action="hide">Hide</button>`
          }
          <button class="btn btn-danger" type="button" data-action="hard">Delete forever</button>
        </div>
      `;
      row.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", async () => {
          if (busy) return;
          const action = button.dataset.action;
          if (action === "hard") {
            const ok = window.confirm(
              "Permanently delete this photo from storage and the database? This cannot be undone."
            );
            if (!ok) return;
          }
          busy = true;
          try {
            if (action === "hide") {
              await api("/api/admin/photos", {
                method: "PATCH",
                body: JSON.stringify({ action: "hide", url: photo.url }),
              });
              showToast("Hidden from website");
            } else if (action === "restore") {
              await api("/api/admin/photos", {
                method: "PATCH",
                body: JSON.stringify({ action: "restore", url: photo.url }),
              });
              showToast("Restored to website");
            } else {
              await api(`/api/admin/photos?url=${encodeURIComponent(photo.url)}&mode=hard`, {
                method: "DELETE",
              });
              showToast("Deleted forever");
            }
            await loadPhotos();
          } catch (error) {
            showToast(error.message);
          } finally {
            busy = false;
          }
        });
      });
      return row;
    })
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadPhotos() {
  const includeHidden = adminShowHidden?.checked !== false ? "1" : "0";
  const data = await api(`/api/admin/photos?includeHidden=${includeHidden}`);
  renderPhotos(data.photos || []);
}

async function loadDbTables() {
  const data = await api("/api/admin/db");
  const tables = data.tables || [];
  adminDbTable.replaceChildren(
    ...tables.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      return option;
    })
  );
}

function showLoggedIn(counts) {
  loginPanel.hidden = true;
  adminPanel.hidden = false;
  logoutBtn.hidden = false;
  renderStats(counts);
}

function showLoggedOut() {
  loginPanel.hidden = false;
  adminPanel.hidden = true;
  logoutBtn.hidden = true;
  adminSub.textContent = "Upload · Hide · Delete · Database";
  setUploadProgress({ active: false });
}

async function bootstrap() {
  try {
    const me = await api("/api/admin/me");
    showLoggedIn(me.counts);
    await Promise.all([loadApprovals(), loadPhotos(), loadDbTables()]);
  } catch {
    showLoggedOut();
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: passwordInput.value }),
    });
    passwordInput.value = "";
    showToast("Logged in");
    await bootstrap();
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  showLoggedOut();
  showToast("Logged out");
});

async function prepareImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const max = 1920;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    bitmap.close();
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function isZipFile(file) {
  const name = (file.name || "").toLowerCase();
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

function mimeFromName(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return "image/jpeg";
}

async function extractImagesFromZip(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buffer);
  const images = [];
  for (const [entryName, data] of Object.entries(entries)) {
    const base = entryName.split("/").pop() || "";
    if (!base || base.startsWith(".") || entryName.includes("__MACOSX")) continue;
    if (!IMAGE_EXT.test(base)) continue;
    images.push(new File([data], base, { type: mimeFromName(base) }));
  }
  return images;
}

async function expandUploadFiles(files) {
  const images = [];
  for (const file of files) {
    if (isZipFile(file)) {
      const fromZip = await extractImagesFromZip(file);
      images.push(...fromZip);
    } else if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name || "")) {
      images.push(file);
    }
  }
  return images;
}

async function uploadImageFile(file, signal) {
  if (signal?.aborted || uploadCancelled) {
    throw new DOMException("Upload cancelled", "AbortError");
  }
  const prepared = await prepareImage(file);
  if (signal?.aborted || uploadCancelled) {
    throw new DOMException("Upload cancelled", "AbortError");
  }
  const dataUrl = await readDataUrl(prepared);
  await api("/api/admin/photos", {
    method: "POST",
    body: JSON.stringify({ name: prepared.name, dataUrl }),
    signal,
  });
}

adminUploadBtn.addEventListener("click", () => {
  if (busy) return;
  adminFileInput.click();
});
adminUploadCancel?.addEventListener("click", () => {
  cancelActiveUpload();
  setUploadProgress({
    active: true,
    message: "Cancelling…",
    done: Number(adminUploadFill?.dataset.done || 0),
    total: Number(adminUploadFill?.dataset.total || 0),
  });
});
adminRefreshPhotos?.addEventListener("click", async () => {
  try {
    await loadPhotos();
    showToast("List refreshed");
  } catch (error) {
    showToast(error.message);
  }
});
adminShowHidden?.addEventListener("change", () => {
  loadPhotos().catch((error) => showToast(error.message));
});

adminFileInput.addEventListener("change", async () => {
  const picked = [...(adminFileInput.files || [])];
  adminFileInput.value = "";
  if (!picked.length) return;
  if (busy) return;
  busy = true;
  uploadCancelled = false;
  uploadAbort = new AbortController();
  const signal = uploadAbort.signal;
  let uploaded = 0;
  let total = 0;
  try {
    setUploadProgress({ active: true, message: "Reading files…", done: 0, total: 0 });
    const files = await expandUploadFiles(picked);
    if (uploadCancelled || signal.aborted) {
      throw new DOMException("Upload cancelled", "AbortError");
    }
    if (!files.length) {
      showToast("No photos found in those files");
      setUploadProgress({ active: false });
      return;
    }
    total = files.length;
    if (adminUploadFill) {
      adminUploadFill.dataset.done = "0";
      adminUploadFill.dataset.total = String(total);
    }
    setUploadProgress({
      active: true,
      message: `Uploading 0 of ${total}…`,
      done: 0,
      total,
    });

    for (const file of files) {
      if (uploadCancelled || signal.aborted) {
        throw new DOMException("Upload cancelled", "AbortError");
      }
      setUploadProgress({
        active: true,
        message: `Uploading ${uploaded + 1} of ${total}…`,
        done: uploaded,
        total,
      });
      await uploadImageFile(file, signal);
      uploaded += 1;
      if (adminUploadFill) adminUploadFill.dataset.done = String(uploaded);
      setUploadProgress({
        active: true,
        message: `Uploaded ${uploaded} of ${total}`,
        done: uploaded,
        total,
      });
    }
    setUploadProgress({ active: false });
    showToast(total === 1 ? "Photo uploaded" : `${total} photos uploaded`);
    await loadPhotos();
  } catch (error) {
    const cancelled =
      uploadCancelled || error?.name === "AbortError" || /cancelled/i.test(error?.message || "");
    setUploadProgress({ active: false });
    if (cancelled) {
      showToast(
        uploaded > 0
          ? `Upload cancelled · ${uploaded} of ${total || uploaded} saved`
          : "Upload cancelled"
      );
      if (uploaded > 0) await loadPhotos().catch(() => {});
    } else {
      showToast(error.message || "Upload failed");
      if (uploaded > 0) await loadPhotos().catch(() => {});
    }
  } finally {
    busy = false;
    uploadAbort = null;
    uploadCancelled = false;
    setUploadProgress({ active: false });
  }
});

adminDbCsv?.addEventListener("click", async () => {
  const table = adminDbTable.value;
  if (!table) {
    showToast("Choose a table");
    return;
  }
  try {
    const response = await fetch(
      `/api/admin/db?table=${encodeURIComponent(table)}&format=csv&download=1`,
      { credentials: "same-origin" }
    );
    if (!response.ok) {
      const data = await readJson(response);
      throw new Error(data.error || "CSV download failed");
    }
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `${table}.csv`;
    link.click();
    URL.revokeObjectURL(href);
    showToast(`Downloaded ${table}.csv`);
  } catch (error) {
    showToast(error.message);
  }
});

adminSqlRun?.addEventListener("click", async () => {
  if (busy) return;
  const sql = adminSql.value.trim();
  if (!sql) {
    showToast("Enter SQL");
    return;
  }
  busy = true;
  try {
    const result = await api("/api/admin/db", {
      method: "POST",
      body: JSON.stringify({ sql }),
    });
    adminSqlResult.hidden = false;
    adminSqlResult.textContent = JSON.stringify(result, null, 2);
    showToast(result.kind === "query" ? "Query complete" : "SQL executed");
    if (/photos|display_names|face_records/i.test(sql)) {
      await loadPhotos().catch(() => {});
    }
    await loadDbTables().catch(() => {});
  } catch (error) {
    adminSqlResult.hidden = false;
    adminSqlResult.textContent = error.message;
    showToast(error.message);
  } finally {
    busy = false;
  }
});

bootstrap();
