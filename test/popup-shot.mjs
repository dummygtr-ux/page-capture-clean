/* Renders the real popup.html with the chrome.* APIs mocked, so the UI can be
 * screenshotted and smoke-tested outside a browser profile. */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveChromium } from './browser-path.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = resolveChromium();
const sample = readFileSync(resolve(ROOT, 'test/out/divsoup-lean.md'), 'utf8');

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 460, height: 600 }, deviceScaleFactor: 2 });

await page.addInitScript(({ md }) => {
  const meta = { scope: 'main', selector: 'div.content', url: 'https://tickets.internal.acme.example/TCK-1042', title: 'TCK-1042 — Access request' };
  const payload = { ok: true, kind: 'md', text: md, meta, chars: md.length, tokens: Math.round(md.length / 3.8), blocks: 23, mime: 'text/markdown' };
  window.chrome = {
    tabs: {
      query: async () => [{ id: 1, url: meta.url, title: meta.title }],
      create: async () => {},
    },
    storage: {
      sync: {
        get: async (defaults) => Object.assign({}, defaults, { format: 'md-lean', scope: 'content', includeHidden: 'mark' }),
        set: async () => {},
      },
    },
    runtime: { sendMessage: async () => payload },
  };
}, { md: sample });

await page.goto(pathToFileURL(resolve(ROOT, 'src/popup.html')).href, { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('preview').value.length > 100, { timeout: 5000 });

const state = await page.evaluate(() => ({
  format: document.getElementById('format').value,
  scope: document.getElementById('scope').value,
  hidden: document.getElementById('include-hidden').value,
  stats: document.getElementById('stats').textContent,
  note: document.getElementById('scope-note').textContent,
  chars: document.getElementById('preview').value.length,
}));
console.log(state);

const out = resolve(ROOT, 'test/out/popup.png');
await page.screenshot({ path: out });
console.log('screenshot:', out);

await browser.close();
if (!state.chars || !/tokens/.test(state.stats) || state.format !== 'md-lean') {
  console.error('popup smoke test failed');
  process.exit(1);
}
console.log('popup smoke test passed');
