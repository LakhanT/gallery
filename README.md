# Gallery

A minimal photo gallery you can run in the browser. Upload photographs, browse them in a clean grid, open any image full-size, and download it on its own.

Photos stay on the device. Nothing is sent to a server.

**Live demo:** [gallery-nine-sigma-24.vercel.app](https://gallery-nine-sigma-24.vercel.app)

[![Live demo](https://img.shields.io/badge/demo-Vercel-000000?logo=vercel&logoColor=white)](https://gallery-nine-sigma-24.vercel.app)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_modules-F7DF1E?logo=javascript&logoColor=black)
![License: MIT](https://img.shields.io/badge/License-MIT-1C1916)

## Features

- **Upload** — choose files or drag photos onto the page
- **Browse** — a clear grid with the filename on every card
- **View** — click a photo to open it larger; use arrow keys to move between images
- **Download** — save any photo individually, at original quality
- **Remove** — delete a photo from the collection
- **Private by default** — storage is local (IndexedDB), so a refresh keeps the gallery without an account

## Stack

| Piece | Choice |
| --- | --- |
| Build | [Vite](https://vite.dev) 6 |
| UI | Semantic HTML, CSS, vanilla JavaScript |
| Persistence | IndexedDB in the browser |

No backend, database, or cloud storage. The deployed site is a static app.

## Quick start

Requirements: Node.js 18 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

| Script | What it does |
| --- | --- |
| `npm run dev` | Local development server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |

## How it works

1. Selected image files are stored as blobs in IndexedDB.
2. The grid reads that store and renders object URLs for each photo.
3. Download creates a temporary link to the original blob, so the saved file matches what you uploaded.
4. Clearing site data for this origin removes the gallery.

## Project layout

```
.
├── index.html          App shell
├── src/
│   ├── main.js         Upload, grid, viewer, download
│   ├── db.js           IndexedDB helpers
│   └── styles.css      Layout and visual system
├── vite.config.js
└── package.json
```

## Deploy

This project is a static Vite app. Vercel, Netlify, or any static host works.

**Vercel**

1. Import the GitHub repository.
2. Framework preset: Vite (auto-detected).
3. Build command: `npm run build`
4. Output directory: `dist`

## License

MIT. See [LICENSE](LICENSE).
