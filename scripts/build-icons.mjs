#!/usr/bin/env node
/**
 * Generate platform app icons from design/logo/paperplane-icon.svg.
 *
 * Produces:
 *   - build/icon.png  (1024×1024, Linux + cross-platform fallback)
 *   - build/icon.ico  (Windows multi-resolution: 16, 32, 48, 64, 128, 256)
 *   - build/icon.icns (macOS multi-resolution: 128, 256, 512, 1024 + retina 32, 64)
 *
 * Run manually before `npm run dist:win` / `npm run dist:mac` on brand updates.
 * Outputs are committed (see .gitignore) so contributors don't need to run
 * this on every build.
 *
 * Stack: @resvg/resvg-js (pure-WASM SVG renderer, no native deps) + png-to-ico
 * (pure-JS ICO encoder). ICNS is encoded inline (~30 lines) — the format is a
 * straightforward 8-byte header + a list of <OSType, length, PNG> entries.
 */

import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = dirname(__dirname);

const SRC_SVG = join(ROOT, 'design/logo/paperplane-icon.svg');
const BUILD_DIR = join(ROOT, 'build');

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

// OSType codes per Apple's ICNS spec. ic07..ic10 are the standard PNG entries;
// ic11/ic12 carry retina variants for the small sizes (macOS treats ic11's
// 32-px PNG as the 16@2x form, ic12's 64-px PNG as the 32@2x form).
const ICNS_ENTRIES = [
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
  { type: 'ic11', size: 32 },
  { type: 'ic12', size: 64 },
];

function renderPng(svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return Buffer.from(resvg.render().asPng());
}

function encodeIcns(entries) {
  const bodies = entries.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(bodies);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([fileHeader, body]);
}

async function main() {
  const svg = await readFile(SRC_SVG, 'utf-8');
  await mkdir(BUILD_DIR, { recursive: true });

  const uniqueSizes = [
    ...new Set([...ICO_SIZES, ...ICNS_ENTRIES.map((e) => e.size), 1024]),
  ].sort((a, b) => a - b);
  console.log(`Rendering PNGs at: ${uniqueSizes.join(', ')}`);
  const pngs = new Map();
  for (const size of uniqueSizes) {
    pngs.set(size, renderPng(svg, size));
  }

  const pngOut = join(BUILD_DIR, 'icon.png');
  await writeFile(pngOut, pngs.get(1024));
  console.log(`wrote ${pngOut} (1024×1024)`);

  const icoBuf = await pngToIco(ICO_SIZES.map((s) => pngs.get(s)));
  const icoOut = join(BUILD_DIR, 'icon.ico');
  await writeFile(icoOut, icoBuf);
  console.log(`wrote ${icoOut} (${ICO_SIZES.join('/')})`);

  const icnsBuf = encodeIcns(
    ICNS_ENTRIES.map(({ type, size }) => ({ type, png: pngs.get(size) })),
  );
  const icnsOut = join(BUILD_DIR, 'icon.icns');
  await writeFile(icnsOut, icnsBuf);
  console.log(
    `wrote ${icnsOut} (${ICNS_ENTRIES.map((e) => `${e.type}=${e.size}`).join(' ')})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
