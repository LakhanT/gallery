import {
  detectFacesFromSource,
  loadFaceIndex,
  loadFaceModels,
  matchPhotos,
  saveFaceRecord,
} from "./faces.js";

const fileInput = document.querySelector("#file-input");
const faceInput = document.querySelector("#face-input");
const uploadBtn = document.querySelector("#upload-btn");
const findBtn = document.querySelector("#find-btn");
const emptyUpload = document.querySelector("#empty-upload");
const empty = document.querySelector("#empty");
const grid = document.querySelector("#grid");
const count = document.querySelector("#count");
const scanStatus = document.querySelector("#scan-status");
const searchBar = document.querySelector("#search-bar");
const searchLabel = document.querySelector("#search-label");
const searchClear = document.querySelector("#search-clear");
const facePicker = document.querySelector("#face-picker");
const faceChoices = document.querySelector("#face-choices");
const dropVeil = document.querySelector("#drop-veil");
const toast = document.querySelector("#toast");
const viewer = document.querySelector("#viewer");
const viewerImage = document.querySelector("#viewer-image");
const viewerCaption = document.querySelector("#viewer-caption");
const viewerDownload = document.querySelector("#viewer-download");
const viewerDelete = document.querySelector("#viewer-delete");
const prevBtn = document.querySelector("#prev");
const nextBtn = document.querySelector("#next");

let photos = [];
let activeIndex = 0;
let dragDepth = 0;
let toastTimer = 0;
let busy = false;
let faceMatches = null;
let matchScores = new Map();
let scanToken = 0;

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
  findBtn.disabled = state;
}

function displayedPhotos() {
  if (!faceMatches) return photos;
  return photos.filter((photo) => faceMatches.has(photo.id));
}

async function loadSamples() {
  const response = await fetch("/samples/manifest.json");
  if (!response.ok) return [];
  const items = await response.json();
  return items.map((item) => ({
    ...item,
    sample: true,
  }));
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
  return photo.sample ? `${photo.name} · starter photo` : photo.name;
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
    const img = host.closest(".card")?.querySelector("img");
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

  if (!photos.length) {
    empty.hidden = false;
    grid.hidden = true;
    searchBar.hidden = !faceMatches;
    empty.querySelector("h2").textContent = "No photos yet";
    empty.querySelector("p").textContent =
      "Upload a photo and everyone who opens this site will see it. Starter photos are already in the gallery.";
    emptyUpload.hidden = false;
    count.textContent = "Shared gallery — everyone with this site sees the same photos.";
    return;
  }

  if (faceMatches && !shown.length) {
    empty.hidden = false;
    grid.hidden = true;
    empty.querySelector("h2").textContent = "No matching dumps";
    empty.querySelector("p").textContent =
      "That face was not found in the gallery. Try a clearer photo, or show all dumps again.";
    emptyUpload.hidden = true;
    count.textContent = "0 matching dumps";
    return;
  }

  empty.hidden = true;
  empty.querySelector("h2").textContent = "No photos yet";
  empty.querySelector("p").textContent =
    "Upload a photo and everyone who opens this site will see it. Starter photos are already in the gallery.";
  emptyUpload.hidden = false;
  grid.hidden = false;
  count.textContent = faceMatches
    ? shown.length === 1
      ? "1 matching dump"
      : `${shown.length} matching dumps`
    : shown.length === 1
      ? "1 photo · shared with everyone on this site"
      : `${shown.length} photos · shared with everyone on this site`;

  grid.replaceChildren(
    ...shown.map((photo, index) => {
      const card = document.createElement("article");
      card.className = faceMatches ? "card match" : "card";
      card.dataset.index = String(index);
      card.tabIndex = 0;

      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = photo.name;
      img.loading = "lazy";
      img.addEventListener("click", () => openViewer(index));

      if (faceMatches) {
        const tag = document.createElement("span");
        tag.className = "match-tag";
        const score = matchScores.get(photo.id);
        tag.textContent = score ? `${score}% match` : "Match";
        card.append(tag);
      }

      const bar = document.createElement("div");
      bar.className = "card-bar";

      const name = document.createElement("span");
      name.className = "card-name";
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
      download.textContent = "Download";
      download.setAttribute("aria-label", `Download ${photo.name}`);
      download.addEventListener("click", (event) => {
        event.stopPropagation();
        downloadPhoto(photo);
      });

      bar.append(name, download);
      card.addEventListener("keydown", (event) => {
        if (event.target.closest(".name-input")) return;
        if (event.key === "F2") {
          event.preventDefault();
          startRename(photo, name);
          return;
        }
        if (event.target.closest(".card-name")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openViewer(index);
        }
      });
      card.append(img, bar);
      return card;
    })
  );
}

async function refresh() {
  const samples = await loadSamples();
  let uploads = [];
  let names = {};
  try {
    const gallery = await loadUploads();
    uploads = gallery.photos;
    names = gallery.names;
  } catch (error) {
    showToast(error.message);
  }
  photos = [
    ...uploads,
    ...samples.map((sample) => ({
      ...sample,
      name: names[sample.id] || sample.name,
    })),
  ];
  if (faceMatches) {
    const ids = new Set(photos.map((photo) => photo.id));
    faceMatches = new Set([...faceMatches].filter((id) => ids.has(id)));
    if (!faceMatches.size) clearFaceSearch();
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
  viewerDelete.hidden = Boolean(photo.sample);
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

async function scanGalleryFaces() {
  const token = (scanToken += 1);
  try {
    await loadFaceModels();
    let index = await loadFaceIndex();
    const pending = photos.filter((photo) => !index[photo.id]);
    if (!pending.length) {
      scanStatus.hidden = true;
      return index;
    }
    scanStatus.hidden = false;
    for (let i = 0; i < pending.length; i += 1) {
      if (token !== scanToken) return index;
      const photo = pending[i];
      scanStatus.textContent = `Scanning faces in dumps… ${i + 1} of ${pending.length}`;
      try {
        const faces = await detectFacesFromSource(photo.url);
        await saveFaceRecord(photo.id, faces);
        index[photo.id] = { faces };
      } catch {
        try {
          await saveFaceRecord(photo.id, []);
        } catch {
          /* keep going */
        }
        index[photo.id] = { faces: [] };
      }
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
    if (token === scanToken) scanStatus.hidden = true;
    return index;
  } catch (error) {
    if (token === scanToken) {
      scanStatus.hidden = true;
      showToast(error.message || "Face scanning failed");
    }
    throw error;
  }
}

function matchPercent(distance) {
  return Math.max(1, Math.min(99, Math.round((1 - distance / 0.7) * 100)));
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
  faceMatches = null;
  matchScores = new Map();
  searchBar.hidden = true;
  render();
}

async function searchByFace(file) {
  if (busy) return;
  setBusy(true);
  showToast("Looking for that face in the dumps…");
  try {
    const index = await scanGalleryFaces();
    const faces = await detectFacesFromSource(file);
    if (!faces.length) {
      showToast("No face found in that photo");
      return;
    }
    const query = faces.length === 1 ? faces[0] : await pickQueryFace(faces);
    if (!query) return;
    const matches = matchPhotos(query.descriptor, index, photos);
    if (!matches.length) {
      faceMatches = new Set();
      matchScores = new Map();
      searchBar.hidden = false;
      searchLabel.textContent = "No dumps matched that face";
      render();
      return;
    }
    faceMatches = new Set(matches.map((row) => row.photo.id));
    matchScores = new Map(matches.map((row) => [row.photo.id, matchPercent(row.distance)]));
    searchBar.hidden = false;
    searchLabel.textContent =
      matches.length === 1
        ? "1 dump has this face"
        : `${matches.length} dumps have this face`;
    render();
    showToast(
      matches.length === 1 ? "Found 1 matching dump" : `Found ${matches.length} matching dumps`
    );
  } catch (error) {
    showToast(error.message || "Face search failed");
  } finally {
    setBusy(false);
  }
}

uploadBtn.addEventListener("click", () => fileInput.click());
findBtn.addEventListener("click", () => faceInput.click());
emptyUpload.addEventListener("click", () => fileInput.click());
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
  if (!photo || photo.sample) return;
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

document.addEventListener("keydown", (event) => {
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
    const card = document.activeElement?.closest?.(".card");
    if (card) {
      const index = Number(card.dataset.index);
      const host = card.querySelector(".card-name");
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
  await ingest(event.dataTransfer.files);
});

refresh();
