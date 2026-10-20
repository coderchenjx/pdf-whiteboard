// Copyright (C) 2026 PDF Whiteboard contributors
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const built = spawnSync(process.execPath, [path.join(root, 'build.mjs'), ...process.argv.slice(2)], {stdio: 'inherit'});
if (built.status !== 0) throw new Error('Build failed; no release folder was created.');
const files = [
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', '发布到GitHub.md',
  '.gitignore', 'package.json', 'app.mjs', 'viewer.template.html', 'build.mjs', 'release.mjs',
  'PDF课堂白板.html', 'PDFjs-LICENSE.txt', '使用说明.txt',
  'tests/verify-whiteboard-interactions.mjs', '.github/workflows/check.yml',
];
for (const file of files) if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing release file: ${file}`);
const releaseRoot = path.join(root, 'release');
fs.mkdirSync(releaseRoot, {recursive: true});
const output = fs.mkdtempSync(path.join(releaseRoot, 'github-upload-'));
for (const file of files) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(path.join(root, file), target);
}
console.log(`Clean GitHub upload folder: ${output}`);
