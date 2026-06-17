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

const dataDir = mkTempDir('marp-theme-data-');
const themeDir = mkTempDir('marp-theme-notes-');

process.env.DATA_DIR = dataDir;
process.env.THEME_NOTES_DIR = themeDir;

const sync = loadSyncModule();
const {
  parseFrontMatterValue,
  parseThemeNoteId,
  parseThemeName,
  writeThemeIfChanged,
  themeWatched,
} = sync;

assert.strictEqual(parseFrontMatterValue('---\ntheme: deck\nmarpThemeNote: abc_1\n---\nbody\n', 'theme'), 'deck');
assert.strictEqual(parseFrontMatterValue('---\ntheme: deck\nmarpThemeNote: abc_1\n---\nbody\n', 'marpThemeNote'), 'abc_1');
assert.strictEqual(parseFrontMatterValue('---\nfoo: bar\n---\nbody\n', 'missing'), '');
assert.strictEqual(parseFrontMatterValue('---\ntheme: deck\n---\nmarpThemeNote: x\n', 'marpThemeNote'), '');

assert.strictEqual(parseThemeNoteId('---\nmarpThemeNote: abc_1\n---\n'), 'abc_1');
assert.strictEqual(parseThemeNoteId('---\nmarpThemeNote: bad/note\n---\n'), '');
assert.strictEqual(parseThemeNoteId('---\nmarpThemeNote: bad note\n---\n'), '');
assert.strictEqual(parseThemeNoteId('---\nmarpThemeNote: ..\n---\n'), '');
assert.strictEqual(parseThemeNoteId('---\nmarpThemeNote:\n---\n'), '');

assert.strictEqual(parseThemeName('/* @theme  Name With Spaces  */\nbody{}'), 'NameWithSpaces');
assert.strictEqual(parseThemeName('body{}'), '');

themeWatched.clear();
const state = { lastHash: null, themeName: null, cssPath: null };
themeWatched.set('t1', state);

const goodCss = '/* @theme good */\nbody{}';
assert.strictEqual(writeThemeIfChanged('t1', goodCss), true, 'first theme write should happen');
assert.strictEqual(fs.existsSync(path.join(themeDir, 'good.css')), true, 'good.css should be written');
assert.strictEqual(fs.readFileSync(path.join(themeDir, 'good.css'), 'utf8'), goodCss, 'good.css should contain the CSS');
assert.strictEqual(writeThemeIfChanged('t1', goodCss), false, 'identical theme CSS should not rewrite');

const changedCss = '/* @theme good2 */\nbody{}';
assert.strictEqual(writeThemeIfChanged('t1', changedCss), true, 'theme-name change should rewrite');
assert.strictEqual(fs.existsSync(path.join(themeDir, 'good.css')), false, 'old theme file should be removed');
assert.strictEqual(fs.existsSync(path.join(themeDir, 'good2.css')), true, 'new theme file should exist');

const noThemeCss = 'body{}';
themeWatched.set('t2', { lastHash: null, themeName: null, cssPath: null });
assert.strictEqual(writeThemeIfChanged('t2', noThemeCss), false, 'CSS without @theme should be skipped');
assert.strictEqual(fs.existsSync(path.join(themeDir, 'theme.css')), false, 'no theme file should be created');

const unsafeCss = '/* @theme ../evil */\nbody{}';
themeWatched.set('t3', { lastHash: null, themeName: null, cssPath: null });
assert.strictEqual(writeThemeIfChanged('t3', unsafeCss), false, 'unsafe theme names must be rejected');
assert.strictEqual(fs.existsSync(path.resolve(themeDir, '..', 'evil.css')), false, 'unsafe theme path must not escape THEME_NOTES_DIR');

// reconcileDeckTheme: dropping/changing a deck's theme detaches it and stops
// orphaned themes so they aren't kept alive forever.
const { watched, reconcileDeckTheme } = sync;

watched.set('deckA', { themeNoteId: 'tA' });
themeWatched.set('tA', { refDecks: new Set(['deckA']), socket: null, timer: null, cssPath: null, themeName: null, lastHash: null });
reconcileDeckTheme('deckA', 'tA');
assert.strictEqual(themeWatched.has('tA'), true, 'unchanged link keeps theme watched');
assert.strictEqual(watched.get('deckA').themeNoteId, 'tA', 'unchanged link keeps deck pointer');

reconcileDeckTheme('deckA', '');
assert.strictEqual(themeWatched.has('tA'), false, 'dropping the only deck stops the theme');
assert.strictEqual(watched.get('deckA').themeNoteId, null, 'dropped link clears deck pointer');

watched.set('deckB', { themeNoteId: 'tB' });
themeWatched.set('tB', { refDecks: new Set(['deckB', 'deckOther']), socket: null, timer: null, cssPath: null, themeName: null, lastHash: null });
reconcileDeckTheme('deckB', 'tC');
assert.strictEqual(themeWatched.has('tB'), true, 'theme with another referencing deck stays watched');
assert.strictEqual(themeWatched.get('tB').refDecks.has('deckB'), false, 'switched deck is detached from old theme');
assert.strictEqual(watched.get('deckB').themeNoteId, 'tC', 'switched deck points at new theme');

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log('theme.test.js: all assertions passed');
process.exit(0);
