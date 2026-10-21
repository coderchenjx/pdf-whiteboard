// Copyright (C) 2026 PDF Whiteboard contributors
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root = path.dirname(fileURLToPath(import.meta.url));
const {version} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid version in package.json');
let runtime = process.argv[2];
if (!runtime) {
  try { runtime = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')); }
  catch { throw new Error('Run npm install first, or use: node build.mjs <path-to-pdfjs-dist>'); }
}
const pdfjsLicense = fs.readFileSync(path.join(runtime, 'LICENSE'), 'utf8');
const projectLicense = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const bundle = JSON.stringify({
  main: fs.readFileSync(path.join(runtime, 'legacy/build/pdf.min.mjs')).toString('base64'),
  worker: fs.readFileSync(path.join(runtime, 'legacy/build/pdf.worker.min.mjs')).toString('base64'),
});
let html = fs.readFileSync(path.join(root, 'viewer.template.html'), 'utf8');
html = html.replaceAll('__APP_VERSION__', version);
html = html.replace('__PDFJS_DATA__', () => bundle).replace('__APP_SCRIPT__', () => fs.readFileSync(path.join(root, 'app.mjs'), 'utf8'));
html = html.replace('__PROJECT_LICENSE__', () => projectLicense).replace('__PDFJS_LICENSE__', () => pdfjsLicense);
fs.writeFileSync(path.join(root, 'PDF课堂白板.html'), html, 'utf8');
fs.writeFileSync(path.join(root, 'PDFjs-LICENSE.txt'), pdfjsLicense, 'utf8');
console.log(`Built self-contained PDF课堂白板.html v${version}. No network dependencies.`);
