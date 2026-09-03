# Gallery

A shared photo gallery. Anyone with the site can browse the collection, upload new photographs, and download any image on its own.

Uploads are stored in Vercel Blob, so every visitor sees the same gallery.

**Live demo:** [gallery-nine-sigma-24.vercel.app](https://gallery-nine-sigma-24.vercel.app)

[![Live demo](https://img.shields.io/badge/demo-Vercel-000000?logo=vercel&logoColor=white)](https://gallery-nine-sigma-24.vercel.app)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_modules-F7DF1E?logo=javascript&logoColor=black)
![License: MIT](https://img.shields.io/badge/License-MIT-1C1916)

## Features

- **Shared uploads** — a photo added by one visitor appears for everyone
- **Starter photos** — six sample images from [Unsplash](https://unsplash.com) ship with the gallery
- **Browse** — a clear grid with the name on every card
- **View** — click a photo to open it larger; use arrow keys to move between images
- **Download** — save any photo individually
- **Remove** — delete an uploaded photo for every visitor (starter photos stay)

## Stack

| Piece | Choice |
| --- | --- |
| Build | [Vite](https://vite.dev) 6 |
| UI | Semantic HTML, CSS, vanilla JavaScript |
| API | Vercel Edge Function (`/api/photos`) |
| Storage | [Vercel Blob](https://vercel.com/storage/blob) (public) |

## Quick start

Requirements: Node.js 18 or newer.

```bash
npm install
npx vercel env pull .env.local
npm run dev
```

`vercel env pull` copies `BLOB_READ_WRITE_TOKEN` so local uploads go to the same shared store as production.

Open the URL Vite prints (usually `http://localhost:5173`).

| Script | What it does |
| --- | --- |
| `npm run dev` | Local development server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |

## How it works

1. Starter photographs live in `public/samples/` and always appear in the grid.
2. New uploads are posted to `/api/photos` and stored in Vercel Blob with public URLs.
3. Every browser loads the same blob list, so the gallery is shared.
4. Download fetches the image file and saves it on the visitor's device.

This is an open gallery: anyone with the link can add or remove uploaded photos.

## Project layout

```
.
├── api/photos.js           List, upload, and delete shared photos
├── public/samples/         Starter photographs
├── index.html              App shell
├── src/
│   ├── main.js             Upload, grid, viewer, download
│   └── styles.css          Layout and visual system
├── vite.config.js
└── package.json
```

## Sample photographs

Six starter images from [Unsplash](https://unsplash.com) live in `public/samples/`: alpine lake, forest light, fog over the hills, sunlit valley, a quiet interior, and a studio still.

## Deploy

The app is built for Vercel. Create a public Blob store and link it to the project so `BLOB_READ_WRITE_TOKEN` is available in Production.

1. Framework preset: Vite
2. Build command: `npm run build`
3. Output directory: `dist`

## License

MIT. See [LICENSE](LICENSE).
