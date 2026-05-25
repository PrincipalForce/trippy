PWA icons rendered from `apps/web/public/favicon.svg` via
`pnpm icons` (which runs `scripts/gen-icons.mjs`).

Regenerate any time the SVG changes:

```bash
pnpm icons
```

Files in this folder:

- `icon-192.png` — 192×192, manifest "any maskable"
- `icon-512.png` — 512×512, manifest "any maskable"
- `apple-touch-icon.png` — 180×180, iOS home-screen icon
- `favicon-32.png` — 32×32, classic browser tab favicon (SVG handles modern browsers)
