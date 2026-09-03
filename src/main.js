const fileInput = document.querySelector("#file-input");
const uploadBtn = document.querySelector("#upload-btn");
const emptyUpload = document.querySelector("#empty-upload");
const empty = document.querySelector("#empty");
const grid = document.querySelector("#grid");
const count = document.querySelector("#count");
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
  if (!photos.length) {
    empty.hidden = false;
    grid.hidden = true;
    count.textContent = "Shared gallery — everyone with this site sees the same photos.";
    return;
  }

  empty.hidden = true;
  grid.hidden = false;
  count.textContent =
    photos.length === 1
      ? "1 photo · shared with everyone on this site"
      : `${photos.length} photos · shared with everyone on this site`;

  grid.replaceChildren(
    ...photos.map((photo, index) => {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.index = String(index);
      card.tabIndex = 0;

      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = photo.name;
      img.loading = "lazy";
      img.addEventListener("click", () => openViewer(index));

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
  render();
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
  activeIndex = index;
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
  if (!photos.length) return;
  activeIndex = (activeIndex + delta + photos.length) % photos.length;
  paintViewer();
}

uploadBtn.addEventListener("click", () => fileInput.click());
emptyUpload.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  await ingest(fileInput.files);
  fileInput.value = "";
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
      startRename(photos[index], host);
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
