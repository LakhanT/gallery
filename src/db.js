const DB_NAME = "atelier-gallery";
const STORE = "photos";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("createdAt", "createdAt");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitFor(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

export async function addPhotos(files) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const createdAt = Date.now();

  files.forEach((file, index) => {
    store.add({
      name: file.name,
      type: file.type || "image/jpeg",
      size: file.size,
      createdAt: createdAt + index,
      blob: file,
    });
  });

  await waitForTx(tx);
  db.close();
}

export async function getPhotos() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const photos = await waitFor(tx.objectStore(STORE).index("createdAt").getAll());
  await waitForTx(tx);
  db.close();
  return (photos || []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deletePhoto(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await waitForTx(tx);
  db.close();
}
