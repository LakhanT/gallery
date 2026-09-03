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
  return data.photos || [];
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

async function uploadFile(file) {
  const prepared = await prepareImage(file);
  const form = new FormData();
  form.append("file", prepared);
  const response = await fetch("/api/photos", {
    method: "POST",
    body: form,
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

      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = photo.name;
      img.loading = "lazy";
      img.tabIndex = 0;
      img.addEventListener("click", () => openViewer(index));
      img.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openViewer(index);
        }
      });

      const bar = document.createElement("div");
      bar.className = "card-bar";

      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = photo.name;
      name.title = photo.name;

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
      card.append(img, bar);
      return card;
    })
  );
}

async function refresh() {
  const samples = await loadSamples();
  let uploads = [];
  try {
    uploads = await loadUploads();
  } catch (error) {
    showToast(error.message);
  }
  photos = [...uploads, ...samples];
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
  viewerCaption.textContent = photo.sample
    ? `${photo.name} · starter photo`
    : photo.name;
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

prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));

document.addEventListener("keydown", (event) => {
  if (!viewer.open) return;
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
