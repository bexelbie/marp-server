// ABOUTME: Self-check for bundleEntries: the tar staging plan must include local
// ABOUTME: assets, theme CSS, and skip remote refs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDirs = [];

function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function loadSyncModule() {
  delete require.cache[require.resolve('../sync.js')];
  return require('../sync.js');
}

function makeFixture(markdown) {
  const dataDir = mkTempDir('marp-bundle-data-');
  const uploadsDir = mkTempDir('marp-bundle-uploads-');
  const themesDir = mkTempDir('marp-bundle-themes-');

  process.env.DATA_DIR = dataDir;
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.THEMES_DIR = themesDir;

  fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'example.com'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'n1.md'), markdown, 'utf8');
  fs.writeFileSync(path.join(uploadsDir, 'pic.png'), 'png', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'assets', 'logo.svg'), '<svg />', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'example.com', 'x.png'), 'png', 'utf8');
  fs.writeFileSync(path.join(themesDir, 'bex.css'), '/* @theme bex */\n', 'utf8');

  const sync = loadSyncModule();
  return { dataDir, uploadsDir, themesDir, bundleEntries: sync.bundleEntries, resolveUpload: sync.resolveUpload };
}

function isWithinRoot(fullPath, rootDir) {
  const root = path.resolve(rootDir);
  const full = path.resolve(fullPath);
  return full === root || full.startsWith(root + path.sep);
}

const fixture = makeFixture('---\ntheme: bex\n---\n\n![](uploads/pic.png)\n![](assets/logo.svg)\n![](//example.com/x.png)\n![](https://example.com/x.png)\n');
const entries = fixture.bundleEntries('n1');
const names = entries.map(entry => entry.name).sort();
assert.deepStrictEqual(names, ['assets/logo.svg', 'n1.md', 'themes/bex.css', 'uploads/pic.png'].sort(), 'bundleEntries should include the local note, assets, and theme CSS');
assert.ok(!names.includes('https://example.com/x.png'), 'remote refs must be skipped');
assert.ok(!names.includes('example.com/x.png'), 'protocol-relative refs must not produce normalized entries');
for (const entry of entries) {
  assert.ok(fs.existsSync(entry.source), `${entry.name} source must exist`);
}
assert.strictEqual(fixture.resolveUpload('/uploads/pic.png'), path.join(fixture.uploadsDir, 'pic.png'), 'resolveUpload should map to the real upload path');
assert.strictEqual(fixture.resolveUpload('/uploads/../../etc/passwd'), null, 'resolveUpload should reject traversal');
assert.strictEqual(fixture.resolveUpload('/uploads/%2e%2e/%2e%2e/etc/passwd'), null, 'resolveUpload should reject encoded traversal');

const traversalFixture = makeFixture('![](../../etc/passwd)\n');
const traversalEntries = traversalFixture.bundleEntries('n1');
const traversalNames = traversalEntries.map(entry => entry.name);
assert.ok(!traversalNames.some(name => name.includes('etc/passwd')), 'non-upload traversal refs must not appear in bundle entries');
assert.ok(traversalEntries.every(entry => isWithinRoot(path.resolve(traversalFixture.dataDir, entry.name), traversalFixture.dataDir)), 'bundle entries must stay under DATA_DIR');

const backslashFixture = makeFixture('![](uploads/..\\..\\etc\\passwd)\n');
fs.writeFileSync(path.join(backslashFixture.uploadsDir, '..\\..\\etc\\passwd'), 'literal backslash file', 'utf8');
const backslashEntries = backslashFixture.bundleEntries('n1');
assert.ok(!backslashEntries.some(entry => entry.name.includes('..\\..\\etc\\passwd')), 'backslash traversal refs must not be bundled');
assert.strictEqual(backslashFixture.resolveUpload('/uploads/..%5C..%5Cetc%5Cpasswd'), null, 'backslash traversal must be rejected after URL decoding');

const themeFixture = makeFixture('---\ntheme: a..b\n---\n');
assert.ok(!themeFixture.bundleEntries('n1').some(entry => entry.name.startsWith('themes/')), 'theme names containing .. must not produce theme entries');

const evilFixture = makeFixture('---\ntheme: ../../evil\n---\n\n![](uploads/../../../etc/passwd)\n');
const evilEntries = evilFixture.bundleEntries('n1');
const evilNames = evilEntries.map(entry => entry.name);
assert.ok(!evilNames.some(name => name.startsWith('themes/')), 'invalid theme refs must be skipped');
assert.ok(!evilNames.includes('uploads/../../../etc/passwd'), 'path traversal refs must be skipped');

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log('bundle.test.js: all assertions passed');
process.exit(0);
