import { addPhotos, deletePhoto, getPhotos } from "./db.js";

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

const urls = new Map();
let photos = [];
let activeIndex = 0;
let dragDepth = 0;
let toastTimer = 0;

function objectUrl(photo) {
  if (!urls.has(photo.id)) {
    urls.set(photo.id, URL.createObjectURL(photo.blob));
  }
  return urls.get(photo.id);
}

function revokeAll() {
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

function downloadPhoto(photo) {
  const link = document.createElement("a");
  link.href = objectUrl(photo);
  link.download = photo.name || "photograph.jpg";
  document.body.append(link);
  link.click();
  link.remove();
  showToast(`Saved ${photo.name}`);
}

function render() {
  const hadUrls = urls.size > 0;
  if (hadUrls) revokeAll();

  if (!photos.length) {
    empty.hidden = false;
    grid.hidden = true;
    count.textContent = "Upload photos. Download any photo you want.";
    return;
  }

  empty.hidden = true;
  grid.hidden = false;
  count.textContent =
    photos.length === 1 ? "1 photo" : `${photos.length} photos`;

  grid.replaceChildren(
    ...photos.map((photo, index) => {
      const card = document.createElement("article");
      card.className = "card";

      const img = document.createElement("img");
      img.src = objectUrl(photo);
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
  photos = await getPhotos();
  render();
}

async function ingest(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    showToast("Those files are not photos");
    return;
  }
  await addPhotos(files);
  await refresh();
  showToast(files.length === 1 ? "Photo added" : `${files.length} photos added`);
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
  viewerImage.src = objectUrl(photo);
  viewerImage.alt = photo.name;
  viewerCaption.textContent = photo.name;
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
  if (!photo) return;
  await deletePhoto(photo.id);
  await refresh();
  if (!photos.length) {
    viewer.close();
    showToast("Photo removed");
    return;
  }
  activeIndex = Math.min(activeIndex, photos.length - 1);
  paintViewer();
  showToast("Photo removed");
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
