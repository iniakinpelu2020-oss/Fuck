#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return false;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return true;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

rmrf(dist);
ensureDir(dist);

const files = ['index.html', 'styles.css', 'manifest.json', 'sw.js', 'favicon.ico'];
const dirs = ['css', 'js', 'assets'];

let copied = 0;
for (const f of files) {
  if (copyRecursive(path.join(root, f), path.join(dist, f))) { console.log('copied file:', f); copied++; }
}
for (const d of dirs) {
  if (copyRecursive(path.join(root, d), path.join(dist, d))) { console.log('copied dir:', d + '/'); copied++; }
}

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('ERROR: dist/index.html missing');
  process.exit(1);
}

console.log(`build:web complete -> dist/ (${copied} items)`);
