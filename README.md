# Indoxvx CDN — Cloudflare Pages + Backblaze B2 Private

Video hosting via private B2 bucket, diakses lewat Cloudflare Pages.

## Struktur
```
indoxvx-cdn/
├── functions/file/[[path]].js  ← proxy ke B2 dengan auth
├── 404.html
└── _redirects
```

## Deploy

### 1. Push ke GitHub
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/USERNAME/indoxvx-cdn.git
git push -u origin main
```

### 2. Buat Cloudflare Pages project
- Buka https://pages.cloudflare.com
- New project → Connect to Git → pilih repo ini
- Build command: (kosong)
- Output directory: (kosong)
- Klik Save and Deploy

### 3. Tambahkan Environment Variables (PENTING)
- Di dashboard Pages → project kamu → Settings → Environment Variables
- Tambahkan dua variabel:
  - `B2_KEY_ID`  → isi dengan keyID dari Backblaze
  - `B2_APP_KEY` → isi dengan applicationKey dari Backblaze
- Klik Save
- Lalu ke tab Deployments → klik Retry deployment

### 4. Upload video ke Backblaze
- Buka https://secure.backblaze.com
- B2 Cloud Storage → Buckets → Indoxvx-cdn
- Upload/Download → Upload Files

### 5. Akses video
```
https://indoxvx-cdn.pages.dev/file/nama-video.mp4
```

## Embed
```html
<video controls autoplay muted loop playsinline>
  <source src="https://indoxvx-cdn.pages.dev/file/nama-video.mp4" type="video/mp4">
</video>
```

## VideoSchema SEO
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "VideoObject",
  "name": "Judul Video",
  "contentUrl": "https://indoxvx-cdn.pages.dev/file/nama-video.mp4",
  "embedUrl": "https://indoxvx-cdn.pages.dev/file/nama-video.mp4",
  "uploadDate": "2026-04-22"
}
</script>
```
