# Production face-service deployment (Hostinger VPS)

> **Prefer Render if you have no VPS:** see [FACE_SERVICE_RENDER.md](./FACE_SERVICE_RENDER.md).

Architecture:

```text
Browser / Cloudflare Pages Functions
        │
        ▼  HTTPS + X-API-Key
face.YOUR-DOMAIN.com  (Nginx)
        │
        ▼  proxy_pass
127.0.0.1:8090  (uvicorn / systemd)
        │
        ▼
InsightFace buffalo_l (SCRFD + ArcFace 512-d)
```

Gallery (Cloudflare Pages) keeps D1 + R2. This host only runs inference.

**Do not deploy until local `/health` and `/detect-embed` pass.**

---

## 1. VPS prerequisites

Ubuntu on Hostinger. Install:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nginx
# Optional GPU: install CUDA + set FACE_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider
```

Create a deploy user path (example):

```bash
sudo mkdir -p /opt/gallery-face-service
sudo chown $USER:$USER /opt/gallery-face-service
```

Copy the `face-service/` folder from this repo to `/opt/gallery-face-service`.

```bash
cd /opt/gallery-face-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Generate a long random API key (do not commit it):

```bash
openssl rand -hex 32
```

---

## 2. Environment file (systemd)

Create `/etc/gallery-face-service.env` (root-only):

```bash
sudo tee /etc/gallery-face-service.env >/dev/null <<'EOF'
FACE_SERVICE_API_KEY=REPLACE_WITH_OPENSSL_RAND_HEX
FACE_PROVIDERS=CPUExecutionProvider
FACE_MATCH_SIMILARITY=0.42
FACE_UNCERTAIN_SIMILARITY=0.32
FACE_MIN_DETECTION_SCORE=0.50
FACE_MIN_QUALITY_SCORE=0.25
EOF
sudo chmod 600 /etc/gallery-face-service.env
```

---

## 3. systemd unit

Create `/etc/systemd/system/gallery-face-service.service`:

```ini
[Unit]
Description=Abbsolute Legends Gallery face service (InsightFace buffalo_l)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/gallery-face-service
EnvironmentFile=/etc/gallery-face-service.env
ExecStart=/opt/gallery-face-service/.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8090 --workers 1
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Ensure `www-data` can read the app (adjust ownership):

```bash
sudo chown -R www-data:www-data /opt/gallery-face-service
sudo systemctl daemon-reload
sudo systemctl enable --now gallery-face-service
sudo systemctl status gallery-face-service
```

Local loopback check on the VPS:

```bash
curl -s -H "X-API-Key: YOUR_KEY" http://127.0.0.1:8090/health
```

---

## 4. Nginx HTTPS reverse proxy

Replace `face.YOUR-DOMAIN.com` with your real hostname. Point DNS A/AAAA to the VPS first.

```bash
sudo apt install -y certbot python3-certbot-nginx
```

Nginx site `/etc/nginx/sites-available/gallery-face-service`:

```nginx
server {
    listen 80;
    server_name face.YOUR-DOMAIN.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name face.YOUR-DOMAIN.com;

    # certbot will manage ssl_certificate lines

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/gallery-face-service /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d face.YOUR-DOMAIN.com
```

Public health check (from your PC):

```bash
curl.exe -s -H "X-API-Key: YOUR_KEY" https://face.YOUR-DOMAIN.com/health
```

Firewall: allow 80/443 only. Do **not** expose port 8090 publicly.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## 5. Cloudflare Pages secrets

After the HTTPS face URL works:

```powershell
cd C:\Users\Lakhan\Downloads\gallery-main

npx wrangler pages secret put FACE_SERVICE_URL --project-name gallery
# value: https://face.YOUR-DOMAIN.com

npx wrangler pages secret put FACE_SERVICE_API_KEY --project-name gallery
# same value as FACE_SERVICE_API_KEY on the VPS

npx wrangler pages secret put ADMIN_PASSWORD --project-name gallery
```

Optional:

```powershell
npx wrangler pages secret put FACE_SERVICE_TIMEOUT_MS --project-name gallery
# e.g. 60000
```

---

## 6. D1 migrations (remote) — run when you are ready

Do **not** run these until you intentionally update production D1:

```powershell
cd C:\Users\Lakhan\Downloads\gallery-main

npx wrangler d1 execute gallery-db --remote --file=./migrations/0007_face_buffalo_l.sql --yes
npx wrangler d1 execute gallery-db --remote --file=./migrations/0008_reindex_failures.sql --yes
```

If `0007` was already applied, SQLite may error on duplicate columns — that is expected; then only apply `0008`.

---

## 7. Deploy gallery + re-index

```powershell
cd C:\Users\Lakhan\Downloads\gallery-main
npm run build
npx wrangler pages deploy dist --project-name gallery
```

Then open `/admin.html` → Re-index faces → **Run until done** until `pending = 0`.
Use **Retry failed** for any failures.

---

## Security checklist

- [ ] uvicorn binds `127.0.0.1:8090` only
- [ ] Nginx terminates HTTPS
- [ ] Port 8090 not open on firewall
- [ ] `FACE_SERVICE_API_KEY` set on VPS and Pages (same value)
- [ ] Key never in git, frontend, or `wrangler.toml`
- [ ] Public `/api/faces/search` is multipart-only (no client embeddings)
- [ ] Admin routes still password-protected
