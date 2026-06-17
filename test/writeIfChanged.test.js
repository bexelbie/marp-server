// ABOUTME: Self-check for writeIfChanged: identical content must not rewrite the
// ABOUTME: file (no mtime bump), so marp never fires a spurious fullscreen-dropping reload.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'marp-test-'));
const { writeIfChanged, watched, outFile } = require('../sync.js');

const id = 'note1';
watched.set(id, { lastHash: null });
const file = outFile(id);

assert.strictEqual(writeIfChanged(id, 'A'), true, 'first write should happen');
assert.strictEqual(fs.readFileSync(file, 'utf8'), 'A');
const mtime1 = fs.statSync(file).mtimeMs;

assert.strictEqual(writeIfChanged(id, 'A'), false, 'identical content must not rewrite');
assert.strictEqual(fs.statSync(file).mtimeMs, mtime1, 'mtime must not change on no-op');

assert.strictEqual(writeIfChanged(id, 'B'), true, 'changed content must rewrite');
assert.strictEqual(fs.readFileSync(file, 'utf8'), 'B');

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log('writeIfChanged.test.js: all assertions passed');
process.exit(0);
