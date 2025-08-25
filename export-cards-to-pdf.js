#!/usr/bin/env node
/**
 * export-cards-to-pdf.js
 *
 * Usage:
 *   node export-cards-to-pdf.js path/to/cards.html [output.pdf]
 *
 * Requires:
 *   npm i puppeteer
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const input = process.argv[2];
  const out = process.argv[3] || (path.basename(input, path.extname(input)) + '.pdf');
  if (!input) {
    console.error('Usage: node export-cards-to-pdf.js <input.html> [output.pdf]');
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error('Input not found:', input);
    process.exit(1);
  }

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const abs = 'file://' + path.resolve(input).replace(/\\/g, '/');
  await page.goto(abs, { waitUntil: 'load' });

  // Wait for images to load
  await page.evaluate(() => {
    const imgs = Array.from(document.images);
    return Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(res => { img.onload = img.onerror = res; })));
  });

  // Optional: adjust page style to avoid page breaks inside cards
  await page.addStyleTag({ content: `
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .card { break-inside: avoid; page-break-inside: avoid; }
  `});

  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
  });

  await browser.close();
  console.log('Saved PDF ->', out);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
