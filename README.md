# Gallery

A shared photo gallery. Anyone with the site can browse the collection, upload new photographs, download any image, and find face matches across the gallery.

Uploads are stored in **Cloudflare R2**, metadata and face embeddings live in **Cloudflare D1**, and the UI is served from **Cloudflare Pages**.

## Features

- **Shared uploads** — a photo added by one visitor appears for everyone
- **Upload disclaimer** — visitors must agree that uploads are visible to all before proceeding
- **Starter dumps** — 151 portrait photos (including Indian faces) plus six Unsplash scenes ship with the gallery
- **Browse** — a clear grid with the name on every card
- **View** — click a photo to open it larger; use arrow keys to move between images
- **Download** — save any photo individually
- **Find a face** — upload a photo of someone and match them across every dump in the gallery
- **Manual admin review** — uncertain face matches go to `/admin.html` for Same / Different / Not sure
- **Admin upload** — logged-in admin can upload photos too
- **Remove** — delete an uploaded photo for every visitor (starter photos stay)

## Stack

| Piece | Choice |
| --- | --- |
| Build | [Vite](https://vite.dev) 6 |
| UI | Semantic HTML, CSS, vanilla JavaScript |
| Hosting | [Cloudflare Pages](https://pages.cloudflare.com) |
| API | Pages Functions (`/api/photos`, `/api/faces`, `/media/*`) |
| Storage | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| Metadata | [Cloudflare D1](https://developers.cloudflare.com/d1/) |
| Face search | [FaceAPI](https://github.com/vladmandic/face-api) in the browser |

## Quick start (local)

Requirements: Node.js 18 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

Local uploads are saved under `.data/` — no Cloudflare account needed for development.

| Script | What it does |
| --- | --- |
| `npm run dev` | Local development with file-based storage |
| `npm run build` | Production build into `dist/` |
| `npm run dev:cf` | Build + run with Wrangler (R2 + D1 locally) |
| `npm run deploy` | Build and deploy to Cloudflare Pages |

## Deploy to Cloudflare

### 1. Install and log in

```bash
npm install
npx wrangler login
```

### 2. Create resources

```bash
wrangler d1 create gallery-db
wrangler r2 bucket create gallery-photos
```

Copy the `database_id` from the D1 output into `wrangler.toml` (replace the placeholder id).

### 3. Run migrations

```bash
npm run db:migrate:remote
```

### 4. Create a Pages project and deploy

```bash
npm run deploy
```

In the Cloudflare dashboard, open your Pages project → **Settings** → **Functions** and confirm:

- D1 binding: `DB` → `gallery-db`
- R2 binding: `PHOTOS` → `gallery-photos`

If bindings are missing, add them under **Settings → Bindings**, then redeploy.

### 5. Migrate from Vercel (optional)

If you already have photos on Vercel Blob:

```bash
cp .env.example .env.local
# fill in BLOB_READ_WRITE_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID

npm run migrate:vercel -- --origin https://your-site.pages.dev
```

## How it works

1. One hundred fifty-one portrait dumps live in `public/dumps/`, plus six Unsplash scenes in `public/samples/`.
2. New uploads go to `/api/photos`, stored in R2, and served at `/media/gallery/...`.
3. Photo metadata and display names are stored in D1.
4. Face embeddings are stored in D1 and loaded via `/api/faces`.
5. Face detection and matching run in the browser; only embeddings are saved on the server.
6. Downloads fetch the image URL directly (R2 via `/media/` proxy).
7. Before upload, visitors must agree that photos will be visible to everyone.
8. Uncertain face matches (distance between 0.52 and 0.68) are sent to the admin approval queue.
9. Admins log in at `/admin.html`, review Same / Different / Not sure, and can upload photos.

## Admin panel

- URL: `/admin.html` (live: https://gallery-752.pages.dev/admin.html)
- Default password: `admin123` (change `ADMIN_PASSWORD` in `wrangler.toml` `[vars]`, then redeploy)

This is an open gallery: anyone with the link can add or remove uploaded photos.

## Project layout

```
.
├── functions/
│   ├── api/photos.js       Gallery API
│   ├── api/faces.js        Face index API
│   └── media/[[path]].js   R2 photo proxy
├── lib/
│   ├── store.js            D1 + R2 store (production)
│   └── local-store.js      Local dev store
├── migrations/0001_init.sql
├── public/dumps/           151 portrait dumps
├── public/models/          FaceAPI weights
├── public/samples/         Starter photographs
├── scripts/
│   ├── migrate-from-vercel.js
│   └── setup-cloudflare.js
├── src/
│   ├── main.js             Upload, grid, viewer, download, face search
│   ├── faces.js            Detect and match faces
│   └── styles.css
├── wrangler.toml
└── vite.config.js
```

## License

MIT. See [LICENSE](LICENSE).
