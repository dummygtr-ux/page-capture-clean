/* Renders the real popup.html with the chrome.* APIs mocked, so the UI can be
 * screenshotted and smoke-tested outside a browser profile. */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveChromium } from './browser-path.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sample = readFileSync(resolve(ROOT, 'test/out/divsoup-lean.md'), 'utf8');

const browser = await chromium.launch({ executablePath: resolveChromium() });
const page = await browser.newPage({ viewport: { width: 340, height: 260 }, deviceScaleFactor: 2 });

await page.addInitScript(({ md }) => {
  const meta = { scope: 'main', selector: 'div.content', url: 'https://tickets.internal.acme.example/TCK-1042', title: 'TCK-1042 — Access request' };
  const payload = { ok: true, kind: 'md', text: md, meta, chars: md.length, tokens: Math.round(md.length / 3.8), blocks: 23, mime: 'text/markdown' };
  window.__created = [];
  window.chrome = {
    tabs: {
      query: async () => [{ id: 1, url: meta.url, title: meta.title }],
      create: async (o) => { window.__created.push(o.url); },
    },
    storage: {
      sync: {
        get: async (defaults) => Object.assign({}, defaults, { format: 'md-lean', scope: 'content', includeHidden: 'mark' }),
        set: async () => {},
      },
    },
    commands: {
      getAll: async () => [
        { name: 'capture-and-copy', shortcut: 'Ctrl+Shift+Y', description: 'Capture the page and copy it' },
        { name: 'capture-selection', shortcut: 'Ctrl+Shift+U', description: 'Capture only the selection' },
      ],
    },
    runtime: { sendMessage: async () => payload },
  };
}, { md: sample });

await page.goto(pathToFileURL(resolve(ROOT, 'src/popup.html')).href, { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('copy-sub').textContent !== '…', { timeout: 5000 });

const menu = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.menu .item'));
  return {
    order: items.map((b) => b.id),
    titles: items.map((b) => b.querySelector('.item-title').textContent),
    copySub: document.getElementById('copy-sub').textContent,
    key: document.getElementById('copy-key').textContent,
    keyVisible: getComputedStyle(document.getElementById('copy-key')).display !== 'none',
    shortcutSub: document.getElementById('shortcut-sub').textContent,
    moreHidden: document.getElementById('more').classList.contains('hidden'),
    popupHeight: document.body.getBoundingClientRect().height,
  };
});
console.log(menu);

const shotMenu = resolve(ROOT, 'test/out/popup.png');
await page.screenshot({ path: shotMenu });
console.log('screenshot:', shotMenu);

// disclosure: expand and let it render the preview
await page.click('#more-toggle');
await page.waitForFunction(() => document.getElementById('preview').value.length > 100, { timeout: 5000 });
const expanded = await page.evaluate(() => ({
  hidden: document.getElementById('more').classList.contains('hidden'),
  stats: document.getElementById('stats').textContent,
  note: document.getElementById('scope-note').textContent,
  chars: document.getElementById('preview').value.length,
}));
console.log(expanded);
await page.setViewportSize({ width: 340, height: 560 });
const shotMore = resolve(ROOT, 'test/out/popup-expanded.png');
await page.screenshot({ path: shotMore });
console.log('screenshot:', shotMore);

// the shortcut row must open the browser's own shortcut settings page
await page.click('#shortcut');
const created = await page.evaluate(() => window.__created);
console.log('opened:', created);

await browser.close();

const problems = [];
if (menu.order[0] !== 'copy' || menu.order[1] !== 'shortcut') problems.push('menu order is not [copy, shortcut]');
if (menu.titles[0] !== 'Copy page') problems.push('first item is not the copy function');
if (!/Markdown · lean/.test(menu.copySub)) problems.push('copy subtitle missing format');
if (!menu.keyVisible || menu.key !== 'Ctrl+Shift+Y') problems.push('shortcut hint not rendered');
if (!/Currently Ctrl\+Shift\+Y/.test(menu.shortcutSub)) problems.push('shortcut row does not show the current key');
if (!menu.moreHidden) problems.push('preview disclosure should start collapsed');
if (menu.popupHeight > 220) problems.push(`menu should stay compact, height=${Math.round(menu.popupHeight)}`);
if (expanded.hidden || expanded.chars < 100) problems.push('preview did not load when expanded');
if (!/tokens/.test(expanded.stats)) problems.push('stats missing');
if (!created.some((u) => /extensions\/shortcuts/.test(u))) problems.push('shortcut row did not open the shortcut settings');

if (problems.length) {
  console.error('popup smoke test failed:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('popup smoke test passed');
