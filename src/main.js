import {
  assessFaceQuality,
  detectFacesFromSource,
  loadFaceModels,
  loadFaceVersions,
  saveFaceRecord,
  SCAN_VERSION,
  searchFacesOnServer,
} from "./faces.js";

const fileInput = document.querySelector("#file-input");
const faceInput = document.querySelector("#face-input");
const uploadBtn = document.querySelector("#upload-btn");
const myPhotosBtn = document.querySelector("#my-photos-btn");
const emptyUpload = document.querySelector("#empty-upload");
const emptyMyPhotos = document.querySelector("#empty-my-photos");
const empty = document.querySelector("#empty");
const emptyEyebrow = document.querySelector("#empty-eyebrow");
const emptyTitle = document.querySelector("#empty-title");
const emptyCopy = document.querySelector("#empty-copy");
const grid = document.querySelector("#grid");
const count = document.querySelector("#count");
const scanStatus = document.querySelector("#scan-status");
const searchBar = document.querySelector("#search-bar");
const searchLabel = document.querySelector("#search-label");
const searchClear = document.querySelector("#search-clear");
const myPhotosRetake = document.querySelector("#my-photos-retake");
const tabAll = document.querySelector("#tab-all");
const tabMine = document.querySelector("#tab-mine");
const facePicker = document.querySelector("#face-picker");
const faceChoices = document.querySelector("#face-choices");
const sourcePicker = document.querySelector("#source-picker");
const sourceEyebrow = document.querySelector("#source-eyebrow");
const sourceTitle = document.querySelector("#source-title");
const sourceCopy = document.querySelector("#source-copy");
const sourceCapture = document.querySelector("#source-capture");
const sourceUpload = document.querySelector("#source-upload");
const camera = document.querySelector("#camera");
const cameraVideo = document.querySelector("#camera-video");
const cameraShot = document.querySelector("#camera-shot");
const dropVeil = document.querySelector("#drop-veil");
const toast = document.querySelector("#toast");
const viewer = document.querySelector("#viewer");
const viewerImage = document.querySelector("#viewer-image");
const viewerCaption = document.querySelector("#viewer-caption");
const viewerDownload = document.querySelector("#viewer-download");
const viewerDelete = document.querySelector("#viewer-delete");
const prevBtn = document.querySelector("#prev");
const nextBtn = document.querySelector("#next");
const disclaimer = document.querySelector("#disclaimer");
const disclaimerAgree = document.querySelector("#disclaimer-agree");
const disclaimerContinue = document.querySelector("#disclaimer-continue");
const consentName = document.querySelector("#consent-name");

const CONSENT_KEY = "gallery-consent-v1";
const CONSENT_STATEMENT =
  "I acknowledge that photographs in which I appear may be taken, used, downloaded and displayed.";
const qualityDialog = document.querySelector("#quality-dialog");
const qualityCopy = document.querySelector("#quality-copy");
const qualityRetry = document.querySelector("#quality-retry");
const adminPanel = document.querySelector("#admin-panel");
const adminPanelClose = document.querySelector("#admin-panel-close");

const MY_PHOTOS_KEY = "gallery-my-photos-v1";

let photos = [];
let activeIndex = 0;
let dragDepth = 0;
let toastTimer = 0;
let busy = false;
let myPhotoIds = null;
let viewMode = "all";
let sharedFaceIndex = {};
let scanRunning = false;
let sourceMode = "face";
let cameraStream = null;
let qualityRetryMode = "face";

function loadMyPhotos() {
  try {
    const raw = sessionStorage.getItem(MY_PHOTOS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const ids = Array.isArray(data?.ids) ? data.ids.filter(Boolean) : [];
    return ids.length ? new Set(ids) : null;
  } catch {
    return null;
  }
}

function saveMyPhotos(ids) {
  const list = [...ids];
  if (!list.length) {
    sessionStorage.removeItem(MY_PHOTOS_KEY);
    myPhotoIds = null;
    return;
  }
  myPhotoIds = new Set(list);
  sessionStorage.setItem(
    MY_PHOTOS_KEY,
    JSON.stringify({ ids: list, savedAt: new Date().toISOString() })
  );
}

function clearMyPhotos() {
  sessionStorage.removeItem(MY_PHOTOS_KEY);
  myPhotoIds = null;
}

myPhotoIds = loadMyPhotos();
if (myPhotoIds?.size) viewMode = "mine";

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

function setBusy(state) {
  busy = state;
  uploadBtn.disabled = state;
  emptyUpload.disabled = state;
  emptyMyPhotos.disabled = state;
  myPhotosBtn.disabled = state;
  sourceCapture.disabled = state;
  sourceUpload.disabled = state;
  cameraShot.disabled = state;
  tabAll.disabled = state;
  tabMine.disabled = state;
}

function setViewMode(mode) {
  viewMode = mode === "mine" ? "mine" : "all";
  tabAll.classList.toggle("is-active", viewMode === "all");
  tabMine.classList.toggle("is-active", viewMode === "mine");
  tabAll.setAttribute("aria-selected", viewMode === "all" ? "true" : "false");
  tabMine.setAttribute("aria-selected", viewMode === "mine" ? "true" : "false");
  render();
}

function displayedPhotos() {
  if (viewMode === "mine" && myPhotoIds?.size) {
    return photos.filter((photo) => myPhotoIds.has(photo.id));
  }
  return photos;
}

async function loadUploads() {
  const response = await fetch("/api/photos");
  if (!response.ok) {
    throw new Error("Could not load the shared gallery");
  }
  const data = await response.json();
  return {
    photos: data.photos || [],
    names: data.names || {},
  };
}

function fileStemAndExt(name) {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, lastDot), ext: name.slice(lastDot) };
}

function finishRenameValue(original, next) {
  const trimmed = next.trim();
  if (!trimmed) return original;
  const { ext } = fileStemAndExt(original);
  if (ext && !trimmed.includes(".")) return `${trimmed}${ext}`;
  return trimmed.slice(0, 80);
}

function captionText(photo) {
  return photo.name;
}

async function saveRename(photo, nextName) {
  const name = finishRenameValue(photo.name, nextName);
  if (name === photo.name) return photo.name;
  const response = await fetch("/api/photos", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: photo.id, name }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Could not rename photo");
  }
  photo.name = data.name || name;
  showToast("Renamed for everyone");
  return photo.name;
}

function startRename(photo, host) {
  if (!photo || !host || host.querySelector(".name-input")) return;

  const original = photo.name;
  const input = document.createElement("input");
  input.className = "name-input";
  input.type = "text";
  input.value = original;
  input.setAttribute("aria-label", "Rename photo");
  host.replaceChildren(input);

  const { stem } = fileStemAndExt(original);
  input.focus();
  if (stem && stem !== original) {
    input.setSelectionRange(0, stem.length);
  } else {
    input.select();
  }

  let settled = false;
  let commit = true;

  const settle = async () => {
    if (settled) return;
    settled = true;
    try {
      if (commit) await saveRename(photo, input.value);
    } catch (error) {
      showToast(error.message);
    }
    if (host === viewerCaption) {
      host.textContent = captionText(photo);
    } else {
      host.textContent = photo.name;
      host.title = `${photo.name} — double-click or F2 to rename`;
    }
    const img = host.closest(".tile")?.querySelector("img");
    if (img) img.alt = photo.name;
    if (viewer.open && host !== viewerCaption) paintViewer();
  };

  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      commit = false;
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    settle();
  });
}

async function prepareImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const max = 1920;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.86);
    });
    bitmap.close();
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
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

async function uploadFile(file) {
  const prepared = await prepareImage(file);
  const dataUrl = await readDataUrl(prepared);
  const response = await fetch("/api/photos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: prepared.name,
      dataUrl,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Could not upload ${file.name}`);
  }
}

async function downloadPhoto(photo) {
  try {
    const response = await fetch(photo.url);
    if (!response.ok) throw new Error("Download failed");
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = photo.name || "photo.jpg";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
    showToast(`Saved ${photo.name}`);
  } catch {
    const link = document.createElement("a");
    link.href = photo.url;
    link.download = photo.name || "photo.jpg";
    link.target = "_blank";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }
}

function render() {
  const shown = displayedPhotos();
  const inMine = viewMode === "mine";
  const hasMine = Boolean(myPhotoIds?.size);

  tabAll.classList.toggle("is-active", !inMine);
  tabMine.classList.toggle("is-active", inMine);
  tabAll.setAttribute("aria-selected", inMine ? "false" : "true");
  tabMine.setAttribute("aria-selected", inMine ? "true" : "false");

  if (inMine && hasMine) {
    searchBar.hidden = false;
    myPhotosRetake.hidden = false;
    searchLabel.textContent =
      shown.length === 1 ? "1 photo of you" : `${shown.length} photos of you`;
  } else {
    searchBar.hidden = true;
    myPhotosRetake.hidden = true;
  }

  if (!photos.length) {
    empty.hidden = false;
    grid.hidden = true;
    emptyEyebrow.textContent = "Abbsolute Legends";
    emptyTitle.textContent = "No photos yet";
    emptyCopy.textContent = "Add the first shot to the shared gallery, or find photos of you once they land.";
    emptyMyPhotos.hidden = false;
    emptyUpload.hidden = false;
    count.textContent = "Shared photos";
    return;
  }

  if (inMine && !hasMine) {
    empty.hidden = false;
    grid.hidden = true;
    emptyEyebrow.textContent = "Personal";
    emptyTitle.textContent = "Find photos of you";
    emptyCopy.textContent =
      "Take or upload a clear selfie. We’ll match your face across the shared gallery — no account needed.";
    emptyMyPhotos.hidden = false;
    emptyUpload.hidden = true;
    count.textContent = "My photos";
    return;
  }

  if (inMine && hasMine && !shown.length) {
    empty.hidden = false;
    grid.hidden = true;
    emptyEyebrow.textContent = "Personal";
    emptyTitle.textContent = "No photos of you yet";
    emptyCopy.textContent =
      "We couldn’t match your face in the current gallery. Retake a clearer selfie, or check back after more photos are added.";
    emptyMyPhotos.hidden = false;
    emptyMyPhotos.textContent = "Retake selfie";
    emptyUpload.hidden = true;
    count.textContent = "My photos";
    searchBar.hidden = false;
    myPhotosRetake.hidden = false;
    searchLabel.textContent = "0 photos of you";
    return;
  }

  emptyMyPhotos.textContent = inMine && hasMine && !shown.length ? "Retake selfie" : "Find my photos";
  empty.hidden = true;
  grid.hidden = false;
  count.textContent = inMine
    ? shown.length === 1
      ? "1 photo of you"
      : `${shown.length} photos of you`
    : shown.length === 1
      ? "1 photo"
      : `${shown.length} photos`;

  grid.replaceChildren(
    ...shown.map((photo, index) => {
      const tile = document.createElement("article");
      tile.className = inMine ? "tile match" : "tile";
      tile.dataset.index = String(index);
      tile.tabIndex = 0;
      tile.style.animationDelay = `${Math.min(index, 12) * 28}ms`;

      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = photo.name;
      img.loading = "lazy";
      img.addEventListener("click", () => openViewer(index));

      if (inMine) {
        const tag = document.createElement("span");
        tag.className = "match-tag";
        tag.textContent = "You";
        tile.append(tag);
      }

      const bar = document.createElement("div");
      bar.className = "tile-bar";

      const name = document.createElement("span");
      name.className = "tile-name";
      name.textContent = photo.name;
      name.title = `${photo.name} — double-click or F2 to rename`;
      name.tabIndex = 0;
      name.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startRename(photo, name);
      });
      name.addEventListener("keydown", (event) => {
        if (event.key === "F2") {
          event.preventDefault();
          event.stopPropagation();
          startRename(photo, name);
        }
      });

      const download = document.createElement("button");
      download.className = "btn-sm";
      download.type = "button";
      download.textContent = "Save";
      download.setAttribute("aria-label", `Download ${photo.name}`);
      download.addEventListener("click", (event) => {
        event.stopPropagation();
        downloadPhoto(photo);
      });

      bar.append(name, download);
      tile.addEventListener("keydown", (event) => {
        if (event.target.closest(".name-input")) return;
        if (event.key === "F2") {
          event.preventDefault();
          startRename(photo, name);
          return;
        }
        if (event.target.closest(".tile-name")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openViewer(index);
        }
      });
      tile.append(img, bar);
      return tile;
    })
  );
}

async function refresh() {
  let uploads = [];
  try {
    const gallery = await loadUploads();
    uploads = gallery.photos;
  } catch (error) {
    photos = [];
    render();
    showToast(error.message);
    return;
  }
  photos = uploads;
  if (myPhotoIds?.size) {
    const ids = new Set(photos.map((photo) => photo.id));
    const next = [...myPhotoIds].filter((id) => ids.has(id));
    if (next.length !== myPhotoIds.size) saveMyPhotos(next);
  }
  render();
  scanGalleryFaces().catch(() => {});
}

async function ingest(fileList) {
  if (busy) return;
  const files = [...fileList].filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    showToast("Those files are not photos");
    return;
  }

  setBusy(true);
  showToast(files.length === 1 ? "Uploading photo…" : `Uploading ${files.length} photos…`);
  try {
    for (const file of files) {
      await uploadFile(file);
    }
    await refresh();
    showToast(
      files.length === 1
        ? "Photo is live for everyone"
        : `${files.length} photos are live for everyone`
    );
  } catch (error) {
    showToast(error.message);
    await refresh();
  } finally {
    setBusy(false);
  }
}

function openViewer(index) {
  const shown = displayedPhotos();
  const photo = shown[index];
  if (!photo) return;
  activeIndex = photos.indexOf(photo);
  paintViewer();
  if (!viewer.open) viewer.showModal();
}

function paintViewer() {
  const photo = photos[activeIndex];
  if (!photo) {
    viewer.close();
    return;
  }
  viewerImage.src = photo.url;
  viewerImage.alt = photo.name;
  if (!viewerCaption.querySelector(".name-input")) {
    viewerCaption.textContent = captionText(photo);
  }
}

function step(delta) {
  const shown = displayedPhotos();
  if (!shown.length) return;
  const current = photos[activeIndex];
  const from = Math.max(0, shown.indexOf(current));
  const next = shown[(from + delta + shown.length) % shown.length];
  activeIndex = photos.indexOf(next);
  paintViewer();
}

function withTimeout(promise, ms, message) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => window.clearTimeout(timer));
}

const SCAN_CONCURRENCY = 3;

async function scanOnePhoto(photo) {
  const faces = await withTimeout(
    detectFacesFromSource(photo.url, { fast: true }),
    20000,
    `Timed out on ${photo.name}`
  );
  if (!faces.length) {
    // Mark no-face photos done so we don't re-scan them forever
    try {
      await saveFaceRecord(photo.id, []);
    } catch {
      /* ignore */
    }
    sharedFaceIndex[photo.id] = { version: SCAN_VERSION, faceCount: 0 };
    return;
  }
  const stored = await withTimeout(
    saveFaceRecord(photo.id, faces),
    12000,
    `Could not save ${photo.name}`
  );
  sharedFaceIndex[photo.id] = { version: SCAN_VERSION, faceCount: stored.length };
}

async function runPool(items, limit, worker) {
  let next = 0;
  let completed = 0;
  const total = items.length;
  const runners = Array.from({ length: Math.min(limit, total) || 1 }, async () => {
    while (next < total) {
      const index = next;
      next += 1;
      const item = items[index];
      try {
        await worker(item, index);
      } catch {
        try {
          await worker(item, index);
        } catch {
          /* skip after retry */
        }
      }
      completed += 1;
      scanStatus.textContent = `Indexing faces… ${completed} of ${total}`;
    }
  });
  await Promise.all(runners);
}

async function scanGalleryFaces() {
  if (scanRunning) return sharedFaceIndex;
  scanRunning = true;
  try {
    await loadFaceModels();
    try {
      const versions = await loadFaceVersions();
      sharedFaceIndex = { ...sharedFaceIndex };
      for (const [id, version] of Object.entries(versions)) {
        sharedFaceIndex[id] = { ...(sharedFaceIndex[id] || {}), version };
      }
    } catch (error) {
      if (error.message) showToast(error.message);
    }
    const pending = photos.filter((photo) => sharedFaceIndex[photo.id]?.version !== SCAN_VERSION);
    if (!pending.length) {
      scanStatus.hidden = true;
      return sharedFaceIndex;
    }
    scanStatus.hidden = false;
    scanStatus.textContent = `Indexing faces… 0 of ${pending.length}`;
    await runPool(pending, SCAN_CONCURRENCY, (photo) => scanOnePhoto(photo));
    scanStatus.hidden = true;
    return sharedFaceIndex;
  } catch (error) {
    scanStatus.hidden = true;
    showToast(error.message || "Face scanning failed");
    throw error;
  } finally {
    scanRunning = false;
  }
}

function pickQueryFace(faces) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (facePicker.open) facePicker.close();
      resolve(value);
    };

    faceChoices.replaceChildren(
      ...faces.map((face, index) => {
        const button = document.createElement("button");
        button.className = "face-choice";
        button.type = "button";
        const img = document.createElement("img");
        img.src = face.preview;
        img.alt = `Face ${index + 1}`;
        button.append(img);
        button.addEventListener("click", () => finish(face));
        return button;
      })
    );

    facePicker.addEventListener("close", () => finish(null), { once: true });
    facePicker.showModal();
  });
}

function clearFaceSearch() {
  clearMyPhotos();
  setViewMode("all");
}

async function searchByFace(file) {
  if (busy) return;
  setBusy(true);
  showToast("Checking photo quality…");
  try {
    await loadFaceModels();
    const quality = await assessFaceQuality(file, { requireSingle: false });
    if (!quality.ok) {
      askForBetterPhoto(quality.reason, "face");
      return;
    }

    const versionMap = {};
    try {
      const versions = await loadFaceVersions();
      for (const [id, version] of Object.entries(versions)) {
        versionMap[id] = version;
        sharedFaceIndex[id] = { ...(sharedFaceIndex[id] || {}), version };
      }
    } catch {
      /* continue */
    }

    const indexedAnywhere = Object.keys(versionMap).length;
    const currentVersionCount = photos.filter(
      (photo) => sharedFaceIndex[photo.id]?.version === SCAN_VERSION
    ).length;

    // Always refresh the index in the background; only block if almost nothing is indexed yet
    if (indexedAnywhere < Math.min(8, photos.length) && !scanRunning) {
      showToast("Indexing faces first — try again in a moment");
      scanGalleryFaces().catch(() => {});
      return;
    }
    if (!scanRunning) scanGalleryFaces().catch(() => {});
    if (currentVersionCount < photos.length * 0.3) {
      showToast("Finding your photos… (still improving index)");
    } else {
      showToast("Finding your photos…");
    }

    const faces = quality.faces?.length ? quality.faces : await detectFacesFromSource(file);
    if (!faces.length) {
      askForBetterPhoto("No clear face found. Please reupload a good-quality photo.", "face");
      return;
    }
    const query = faces.length === 1 ? faces[0] : await pickQueryFace(faces);
    if (!query) return;

    await runFaceSearch(query.descriptors, query.preview);
  } catch (error) {
    showToast(error.message || "Face search failed");
  } finally {
    setBusy(false);
  }
}

async function runFaceSearch(queryDescriptors, queryPreview = "") {
  const result = await searchFacesOnServer({
    descriptors: queryDescriptors,
    queryPreview,
  });
  const confident = result.matches || [];
  const uncertain = result.uncertain || [];
  const visible = [
    ...confident,
    ...uncertain.filter((row) => !confident.some((c) => c.id === row.id)),
  ];

  const indexedCount =
    result.indexedCount ??
    photos.filter((photo) => sharedFaceIndex[photo.id]?.version === SCAN_VERSION).length;
  const photoCount = result.photoCount ?? photos.length;

  if (!visible.length) {
    clearMyPhotos();
    setViewMode("mine");
    showToast(
      indexedCount < photoCount
        ? `No match yet — still indexing ${indexedCount} of ${photoCount} photos`
        : "No photos of you found yet"
    );
    return;
  }

  saveMyPhotos(visible.map((row) => row.id));
  setViewMode("mine");
  const sure = confident.length;
  const maybe = uncertain.filter((row) => !confident.some((c) => c.id === row.id)).length;
  showToast(
    sure > 0
      ? sure === 1
        ? "Found 1 photo of you"
        : `Found ${sure} photos of you`
      : maybe === 1
        ? "1 possible photo — check My photos"
        : `${maybe} possible photos — check My photos`
  );
}

function askForBetterPhoto(reason, mode = "face") {
  qualityRetryMode = mode;
  qualityCopy.textContent = reason || "Please reupload a good-quality photo.";
  if (!qualityDialog.open) qualityDialog.showModal();
  showToast(reason || "Please reupload a good-quality photo");
}

function readStoredConsent() {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.id || !data?.fullName) return null;
    return data;
  } catch {
    return null;
  }
}

function writeStoredConsent(consent) {
  localStorage.setItem(
    CONSENT_KEY,
    JSON.stringify({
      id: consent.id,
      fullName: consent.fullName,
      at: consent.createdAt || new Date().toISOString(),
    })
  );
}

function syncConsentForm() {
  const nameOk = Boolean(consentName.value.trim().length >= 2);
  const agreed = Boolean(disclaimerAgree.checked);
  disclaimerContinue.disabled = !(nameOk && agreed);
}

function ensureEntryConsent() {
  return new Promise((resolve) => {
    if (readStoredConsent()) {
      resolve(true);
      return;
    }

    consentName.value = "";
    disclaimerAgree.checked = false;
    disclaimerContinue.disabled = true;
    syncConsentForm();

    const onCancel = (event) => {
      event.preventDefault();
    };

    const cleanup = () => {
      consentName.oninput = null;
      disclaimerAgree.onchange = null;
      disclaimerContinue.onclick = null;
      disclaimer.removeEventListener("cancel", onCancel);
    };

    consentName.oninput = () => syncConsentForm();
    disclaimerAgree.onchange = () => syncConsentForm();

    disclaimerContinue.onclick = async () => {
      const fullName = consentName.value.trim();
      if (fullName.length < 2 || !disclaimerAgree.checked) {
        syncConsentForm();
        return;
      }
      disclaimerContinue.disabled = true;
      try {
        const response = await fetch("/api/consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName,
            agreed: true,
            statement: CONSENT_STATEMENT,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not save consent");
        writeStoredConsent(data.consent);
        cleanup();
        disclaimer.close();
        showToast(`Welcome, ${data.consent.fullName.split(" ")[0]}`);
        resolve(true);
      } catch (error) {
        showToast(error.message || "Could not save consent");
        syncConsentForm();
      }
    };

    disclaimer.addEventListener("cancel", onCancel);
    if (!disclaimer.open) disclaimer.showModal();
  });
}

async function openPhotoUploadFlow() {
  const agreed = await ensureEntryConsent();
  if (!agreed) {
    showToast("Consent required");
    return;
  }
  openSourcePicker("photos");
}

function openMyPhotosFlow() {
  setViewMode("mine");
  openSourcePicker("face");
}

function openSourcePicker(mode) {
  sourceMode = mode;
  if (mode === "face") {
    sourceEyebrow.textContent = "Personal";
    sourceTitle.textContent = "My photos";
    sourceCopy.textContent = "Take or upload a clear selfie to find your photos in the gallery.";
  } else {
    sourceEyebrow.textContent = "Upload";
    sourceTitle.textContent = "Add photos";
    sourceCopy.textContent = "Take a photo or upload from this device.";
  }
  sourcePicker.showModal();
}

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  cameraVideo.srcObject = null;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Camera is not available in this browser");
    return;
  }
  const facingMode = sourceMode === "face" ? "user" : { ideal: "environment" };
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    cameraVideo.style.transform = sourceMode === "face" ? "scaleX(-1)" : "none";
    await cameraVideo.play().catch(() => {});
    camera.showModal();
  } catch {
    showToast("Could not open the camera. Allow camera access, or use Upload.");
  }
}

function snapshotFromCamera() {
  const width = cameraVideo.videoWidth;
  const height = cameraVideo.videoHeight;
  if (!width || !height) {
    throw new Error("Camera is not ready yet");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (sourceMode === "face") {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(cameraVideo, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not capture that photo"));
          return;
        }
        resolve(new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9
    );
  });
}

myPhotosBtn.addEventListener("click", () => {
  if (myPhotoIds?.size) setViewMode("mine");
  else openMyPhotosFlow();
});
uploadBtn.addEventListener("click", () => openPhotoUploadFlow());
emptyUpload.addEventListener("click", () => openPhotoUploadFlow());
emptyMyPhotos.addEventListener("click", () => openMyPhotosFlow());
tabAll.addEventListener("click", () => setViewMode("all"));
tabMine.addEventListener("click", () => {
  if (myPhotoIds?.size) setViewMode("mine");
  else openMyPhotosFlow();
});
myPhotosRetake.addEventListener("click", () => openMyPhotosFlow());

qualityRetry.addEventListener("click", () => {
  qualityDialog.close();
  faceInput.click();
});

sourceCapture.addEventListener("click", async () => {
  sourcePicker.close();
  await startCamera();
});
sourceUpload.addEventListener("click", () => {
  sourcePicker.close();
  if (sourceMode === "face") faceInput.click();
  else fileInput.click();
});
cameraShot.addEventListener("click", async () => {
  try {
    const file = await snapshotFromCamera();
    stopCamera();
    if (camera.open) camera.close();
    if (sourceMode === "face") await searchByFace(file);
    else await ingest([file]);
  } catch (error) {
    showToast(error.message || "Could not capture that photo");
  }
});
camera.addEventListener("close", () => stopCamera());
searchClear.addEventListener("click", () => clearFaceSearch());
fileInput.addEventListener("change", async () => {
  await ingest(fileInput.files);
  fileInput.value = "";
});
faceInput.addEventListener("change", async () => {
  const file = faceInput.files?.[0];
  faceInput.value = "";
  if (file) await searchByFace(file);
});

viewerDownload.addEventListener("click", () => {
  const photo = photos[activeIndex];
  if (photo) downloadPhoto(photo);
});

viewerDelete.addEventListener("click", async () => {
  const photo = photos[activeIndex];
  if (!photo) return;
  try {
    const response = await fetch(`/api/photos?url=${encodeURIComponent(photo.url)}`, {
      method: "DELETE",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not remove photo");
    await refresh();
    if (!photos.length) {
      viewer.close();
      showToast("Photo removed for everyone");
      return;
    }
    activeIndex = Math.min(activeIndex, photos.length - 1);
    paintViewer();
    showToast("Photo removed for everyone");
  } catch (error) {
    showToast(error.message);
  }
});

viewerCaption.title = "Double-click or F2 to rename";
viewerCaption.tabIndex = 0;
viewerCaption.addEventListener("dblclick", (event) => {
  event.preventDefault();
  startRename(photos[activeIndex], viewerCaption);
});
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));

function openAdminPanel() {
  if (!adminPanel.open) adminPanel.showModal();
}

function closeAdminPanel() {
  if (adminPanel.open) adminPanel.close();
}

function toggleAdminPanel() {
  if (adminPanel.open) closeAdminPanel();
  else openAdminPanel();
}

adminPanelClose?.addEventListener("click", () => closeAdminPanel());

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && (event.key === "L" || event.key === "l")) {
    event.preventDefault();
    toggleAdminPanel();
    return;
  }

  if (event.key === "F2") {
    if (document.querySelector(".name-input")) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (viewer.open) {
      startRename(photos[activeIndex], viewerCaption);
      return;
    }
    const tile = document.activeElement?.closest?.(".tile");
    if (tile) {
      const index = Number(tile.dataset.index);
      const host = tile.querySelector(".tile-name");
      startRename(displayedPhotos()[index], host);
    }
    return;
  }

  if (!viewer.open || document.querySelector(".name-input")) return;
  if (event.key === "ArrowLeft") step(-1);
  if (event.key === "ArrowRight") step(1);
});

window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  dropVeil.hidden = false;
});

window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropVeil.hidden = true;
});

window.addEventListener("dragover", (event) => event.preventDefault());

window.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropVeil.hidden = true;
  const agreed = await ensureEntryConsent();
  if (!agreed) {
    showToast("Consent required");
    return;
  }
  await ingest(event.dataTransfer.files);
});

ensureEntryConsent().then(() => {
  refresh().catch((error) => {
    showToast(error.message || "Could not load the gallery");
  });
});
