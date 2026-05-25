// Render PWA + favicon assets from apps/web/public/favicon.svg.
// Invoked via `pnpm icons`.

import sharp from "sharp";
import { readFileSync, statSync } from "node:fs";

const svg = readFileSync("apps/web/public/favicon.svg");

const targets = [
  { size: 192, path: "apps/web/public/icons/icon-192.png" },
  { size: 512, path: "apps/web/public/icons/icon-512.png" },
  { size: 180, path: "apps/web/public/icons/apple-touch-icon.png" },
  { size: 32, path: "apps/web/public/icons/favicon-32.png" },
];

for (const { size, path } of targets) {
  await sharp(svg, { density: Math.max(72, size * 4) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path);
  // eslint-disable-next-line no-console
  console.log(`${path}  ${size}×${size}  ${statSync(path).size} bytes`);
}
