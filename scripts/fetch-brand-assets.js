#!/usr/bin/env node
'use strict';
/**
 * Downloads the official Ronchi logo and machine photos from the Ronchi
 * website into the brand folder at full resolution, and updates brand.json
 * to point at them.
 *
 *   node scripts/fetch-brand-assets.js
 *
 * Run it on any computer with normal internet access (it also runs in the
 * GitHub build). The files committed in brand/ are small previews so the app
 * always has something to show.
 */
const fs = require('fs');
const path = require('path');

const SOURCE = 'https://www.ronchipackaging.it/wp-content/uploads/';
const BRAND_DIR = path.join(__dirname, '..', 'brand');

const LOGO = { from: 'logo-ronchi-light.png', to: 'logo.png' }; // white-text version for dark backgrounds
const BACKGROUNDS = [
  { from: 'filling-machines.png', to: 'filling-machines.png' },
  { from: 'capping-systems.png', to: 'capping-systems.png' },
  { from: 'bottle-handling-systems.png', to: 'bottle-handling-systems.png' },
];

async function download(name, target) {
  const response = await fetch(SOURCE + name, { headers: { 'User-Agent': 'Mozilla/5.0 (brand asset fetch)' } });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  console.log(`saved ${path.relative(process.cwd(), target)} (${Math.round(bytes.length / 1024)} KB)`);
}

async function main() {
  const brandFile = path.join(BRAND_DIR, 'brand.json');
  const brand = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
  const fetched = [];

  try {
    await download(LOGO.from, path.join(BRAND_DIR, LOGO.to));
    brand.logoFile = LOGO.to;
  } catch (err) {
    console.warn(`Logo not updated: ${err.message}`);
  }
  for (const item of BACKGROUNDS) {
    try {
      await download(item.from, path.join(BRAND_DIR, 'backgrounds', item.to));
      fetched.push(item.to);
    } catch (err) {
      console.warn(`Photo skipped: ${err.message}`);
    }
  }
  if (fetched.length) brand.backgrounds = fetched;
  fs.writeFileSync(brandFile, JSON.stringify(brand, null, 2) + '\n');
  console.log('brand.json updated.');
}

main().catch((err) => { console.error(err); process.exit(1); });
