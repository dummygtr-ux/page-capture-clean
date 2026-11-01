/* End-to-end: loads the real unpacked extension in Chromium, loads a page over
 * http, and drives the actual content script + background via tabs.sendMessage.
 * This is the path the hotkey and popup use — nothing here is a mock. */
import { chromium } from 'playwright-core';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from './browser-path.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// EXT_DIR lets the same suite verify the *built* artifacts in dist/
const EXT = process.env.EXT_DIR ? resolve(process.env.EXT_DIR) : ROOT;
const EXE = resolveChromium();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer((req, res) => {
  try {
    const path = resolve(ROOT, 'test', decodeURIComponent(req.url).replace(/^\/+/, ''));
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL_ = `http://127.0.0.1:${PORT}/fixtures/messy.html`;

const userDataDir = mkdtempSync(resolve(tmpdir(), 'pc-profile-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath: EXE,
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
  ],
});

// clipboard-read so the test can verify what actually landed on the clipboard
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL_.replace(/\/fixtures.*$/, '') });

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
console.log('extension dir:', EXT);
console.log('service worker:', sw.url());

const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(600);   // content script runs at document_idle

/* No "tabs" permission in the manifest (it would be a privacy ask the feature
 * does not need), so identify the tab the way the popup does: the active one. */
async function activeTabId(sw) {
  return sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t ? t.id : null;
  });
}
await page.bringToFront();
const tabId = await activeTabId(sw);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failures++;
};

check('fixture tab visible to extension', tabId != null, String(tabId));

const res = await sw.evaluate(async ({ tabId }) => {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'capture', opts: { format: 'md-llm', scope: 'content' } }); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}, { tabId });
console.log('\n--- capture via content script ---');
console.log((res.text || JSON.stringify(res)).slice(0, 700));

check('message round-trip works', !res.ok === false || !!res.text, JSON.stringify(res).slice(0, 200));
check('llm profile title', (res.text || '').startsWith('# Fixture: messy page'));
check('source line', (res.text || '').includes(`Source: ${URL_}`));
check('structure preserved (headings)', (res.text || '').includes('## Lists'));
check('structure preserved (table)', (res.text || '').includes('| Name | Value | Note |'));
check('structure preserved (code fence)', (res.text || '').includes('```js'));
check('callouts preserved', (res.text || '').includes('> [!WARNING]'));
check('stats reported', res.chars > 1000 && res.tokens > 100 && res.blocks > 10, JSON.stringify({ c: res.chars, t: res.tokens, b: res.blocks }));

// JSON format through the same path
const asJson = await sw.evaluate(async ({ tabId }) => {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'capture', opts: { format: 'json', scope: 'content' } });
  return { ok: r.ok !== false, head: r.text.slice(0, 120), blocks: JSON.parse(r.text).blocks.length };
}, { tabId });
check('json format valid', asJson.ok && asJson.blocks > 10, asJson.head);
check('json has meta block', asJson.head.includes('"meta"') && asJson.head.includes('"url"'));

// clipboard path (headless Chromium does support the clipboard APIs)
const copied = await sw.evaluate(async ({ tabId }) => {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'copy', opts: { format: 'md-llm', scope: 'content' } }); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}, { tabId });
check('copy path runs without throwing', copied.ok === true, JSON.stringify(copied));

const clip = await page.evaluate(async () => {
  try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR ' + e.message; }
});
check('clipboard actually holds the markdown', clip.startsWith('# Fixture: messy page'), clip.slice(0, 120));

// scope switch: selection
const sel = await page.evaluate(() => {
  const h2 = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === 'Lists');
  const r = document.createRange(); r.setStartBefore(h2); r.setEndAfter(h2.nextElementSibling);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  return s.toString().length;
});
const selRes = await sw.evaluate(async ({ tabId }) => {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'capture', opts: { format: 'md-llm', scope: 'selection' } });
  return { scope: r.meta.scope, text: r.text.slice(0, 200) };
}, { tabId });
check('selection captured', sel > 20 && selRes.scope === 'selection' && selRes.text.includes('## Lists'), JSON.stringify(selRes));

// injection fallback: a tab opened before the content script existed is not
// reproducible here, but a fresh navigation must work too.
const page2 = await ctx.newPage();
await page2.goto(URL_ + '?second', { waitUntil: 'load' });
await page2.bringToFront();
await page2.waitForTimeout(400);
const tab2 = await activeTabId(sw);
const res2 = await sw.evaluate(async ({ t }) => {
  const r = await chrome.tabs.sendMessage(t, { type: 'capture', opts: { format: 'md-doc', scope: 'content' } });
  return r.text.slice(0, 60);
}, { t: tab2 });
check('second tab works + document profile yaml', res2.startsWith('---\ntitle:'), res2);

// ---------------------------------------------------------------- div soup
const page3 = await ctx.newPage();
await page3.goto(`http://127.0.0.1:${PORT}/fixtures/divsoup.html`, { waitUntil: 'load' });
await page3.bringToFront();
await page3.waitForTimeout(500);
const tab3 = await activeTabId(sw);
const soupE2E = await sw.evaluate(async ({ t }) => {
  const cap = await chrome.tabs.sendMessage(t, { type: 'capture', opts: { format: 'md-llm', scope: 'content', includeHidden: 'mark' } });
  const off = await chrome.tabs.sendMessage(t, { type: 'capture', opts: { format: 'md-llm', scope: 'content', includeHidden: 'off' } });
  const rep = await chrome.tabs.sendMessage(t, { type: 'capture', opts: { format: 'report', scope: 'content' } });
  return { cap: cap.text, off: off.text, rep: rep.text };
}, { t: tab3 });

check('div soup via extension: tables + list + pairs', soupE2E.cap.includes('| Approver | Decision | Date |') && soupE2E.cap.includes('**Requester**: Jane Smith'), soupE2E.cap.slice(0, 200));
check('div soup via extension: hidden tab included and labelled', soupE2E.cap.includes('[hidden: display:none] analyst-notes'));
check('includeHidden=off drops it', !soupE2E.off.includes('analyst-notes'));
check('report format works', soupE2E.rep.startsWith('# Page capture report') && /## 3\. Hidden content/.test(soupE2E.rep), soupE2E.rep.slice(0, 160));
check('report lists hidden reasons', /display:none ×2/.test(soupE2E.rep));

// default format must be lean: no message opts at all, straight from DEFAULTS
const defaulted = await sw.evaluate(async ({ t }) => {
  const r = await chrome.tabs.sendMessage(t, { type: 'capture' });
  return r.text;
}, { t: tab3 });
check('default format is lean (no URL noise)', defaulted.includes('| Approver | Decision | Date |') &&
  !defaulted.includes('/img/open.png') && !/utm_source/.test(defaulted), defaulted.slice(0, 160));

// --------------------------------------------- completeness warning in the UI
const page4 = await ctx.newPage();
await page4.goto(`http://127.0.0.1:${PORT}/fixtures/incomplete.html`, { waitUntil: 'load' });
await page4.bringToFront();
await page4.waitForTimeout(500);
const tab4 = await activeTabId(sw);
const warnRes = await sw.evaluate(async ({ t }) => {
  const clean = await chrome.tabs.sendMessage(t, { type: 'capture', opts: { format: 'md-llm', scope: 'content', includeHidden: 'mark' } });
  const skipping = await chrome.tabs.sendMessage(t, { type: 'copy', opts: { format: 'md-llm', scope: 'content', includeHidden: 'off' } });
  return {
    cleanWarnings: clean.diagnostics ? clean.diagnostics.warnings.length : -1,
    enabled: !!clean.diagnostics,
    skippingOk: skipping.ok,
  };
}, { t: tab4 });
check('capture response carries diagnostics', warnRes.enabled, JSON.stringify(warnRes));
check('complete page reports no warnings', warnRes.cleanWarnings === 0, String(warnRes.cleanWarnings));
check('copy with skipped content still succeeds', warnRes.skippingOk === true);

await page4.waitForTimeout(300);
const toastText = await page4.evaluate(() => {
  const el = Array.from(document.documentElement.children).find((n) => /Copied|warning/.test(n.textContent || ''));
  return el ? el.textContent : '';
});
check('the page toast announces the warning', /⚠ 1 warning/.test(toastText), toastText);

await ctx.close();
server.close();
console.log(`\n${failures === 0 ? 'E2E PASS' : `E2E FAIL (${failures})`}`);
process.exit(failures ? 1 : 0);
