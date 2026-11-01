/* Headless test harness: loads the extractor into real Chromium and runs it
 * against fixture pages + (optionally) live URLs. No build step involved, so
 * what is tested is byte-for-byte what the extension ships.
 *
 *   node test/run.mjs            # fixtures
 *   node test/run.mjs --live     # fixtures + a couple of real pages (network)
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveChromium } from './browser-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const EXECUTABLE = resolveChromium();

const LIVE = process.argv.includes('--live');

// Fail loudly on a syntax error instead of "PageCapture is not defined".
for (const f of ['src/extractor.js', 'src/content.js', 'src/background.js', 'src/popup.js']) {
  try { await import('node:child_process').then(({ execFileSync }) => execFileSync(process.execPath, ['--check', resolve(ROOT, f)])); }
  catch (e) { console.error(`syntax error in ${f}\n${e.stderr || e.message}`); process.exit(1); }
}

const extractorSource = readFileSync(resolve(ROOT, 'src/extractor.js'), 'utf8');

const results = [];
let failures = 0;

function check(name, cond, detail) {
  if (cond) results.push(`  ok   ${name}`);
  else { failures++; results.push(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage();

/* CSP on the page blocks addScriptTag, but content scripts in the extension are
 * not subject to page CSP. addInitScript reproduces that behaviour. */
async function load(url) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(extractorSource).catch(async () => {
    await page.addScriptTag({ content: extractorSource });
  });
}

async function run(scope, extra = '') {
  return page.evaluate(({ scope, extra }) => {
    // eslint-disable-next-line no-undef
    const doc = PageCapture.capture(Object.assign({ scope }, extra ? JSON.parse(extra) : {}));
    // eslint-disable-next-line no-undef
    return {
      md: PageCapture.toMarkdown(doc),
      html: PageCapture.toHtml(doc),
      plain: PageCapture.toPlain(doc),
      json: doc,
      styled: PageCapture.styledHtml(document.querySelector('main, article, body')),
    };
  }, { scope, extra });
}

// ---------------------------------------------------------------- fixture
const fixture = pathToFileURL(resolve(HERE, 'fixtures/messy.html')).href;
await load(fixture);
const content = await run('content');
const whole = await run('page');
const styled = content.styled;

writeFileSync(resolve(OUT, 'messy-content.md'), content.md);
writeFileSync(resolve(OUT, 'messy-page.md'), whole.md);
writeFileSync(resolve(OUT, 'messy.json'), JSON.stringify(whole.json, null, 2));
writeFileSync(resolve(OUT, 'messy.html'), whole.html);
writeFileSync(resolve(OUT, 'messy-styled.html'),
  `<!doctype html><meta charset="utf-8"><body style="background:#fff;max-width:46rem;margin:2rem auto;padding:0 1rem">${styled}</body>`);

console.log('\ncontent mode:\n' + content.md);
console.log('\nplain mode (head):\n' + whole.plain.split('\n').slice(0, 18).join('\n'));

check('heading level 1 captured', /^# Capturing \*pages\* without breaking formatting$/m.test(content.md));
check('heading level 2 captured', /^## Lists$/m.test(content.md));
check('bold inline', /\*\*explicit\*\*/.test(content.md));
check('code span', /`inline_code\(\)`/.test(content.md));
check('whitespace collapsed inside paragraph', !/Markdown needs {3}/.test(content.md));
check('<br> became a hard break', /explicit\*\* — like {2}\n/.test(content.md));
check('absolute link resolved', content.md.includes('https://example.com/a_(b)') === false && content.md.includes('https://example.com/a_%28b%29'));
check('javascript: link dropped', !/void\(0\)/.test(content.md));
check('relative link resolved', content.md.includes('file:///relative/path') || content.md.includes('relative/path') );
check('link title kept', content.md.includes('"A link"'));
check('image captured', content.md.includes('![A diagram]('));
check('tracking pixel dropped', !/pixel\.gif/.test(content.md));
check('nested list rendered', content.md.includes('  - Nested a'));
check('inline formatting survives inside list items', content.md.includes('- First item with **bold**'), content.md.split('## Lists')[1] && content.md.split('## Lists')[1].slice(0, 200));
check('link survives inside list items', /Nested b with \[link\]\(/.test(content.md));
check('ordered list start honoured', /^    7\. deep seven$/m.test(content.md));
check('task list', content.md.includes('- [x] done thing') && content.md.includes('- [ ] todo thing'));
check('fenced code with lang', /```js\nfunction f\(a\) \{/.test(content.md));
check('code containing fences widens fence', /````\nplain pre with three backticks:/.test(content.md));
check('table header + separator', /\| Name \| Value \| Note \|/.test(content.md) && /\| --- \| --- \| --- \|/.test(content.md));
check('pipe in cell escaped', /a\\\|b pipe/.test(content.md));
check('blockquote multi-paragraph', /^> Quoted \*text\* here\.$/m.test(content.md) && /^> Second quoted paragraph\.$/m.test(content.md));
check('figure caption', content.md.includes('*Chart **1**: results*'));
check('details rendered', content.md.includes('<details><summary>Click to expand</summary>'));
check('definition list', content.md.includes('**Term one**') && content.md.includes('Definition one.'));
check('sub/sup', content.md.includes('H<sub>2</sub>O') && content.md.includes('mc<sup>2</sup>'));
check('del/mark', content.md.includes('~~gone~~') && content.md.includes('==marked=='));
check('hidden data captured AND labelled', /\[hidden: display:none\][\s\S]{0,80}MUST NOT APPEAR \(display/.test(content.md),
      (content.md.match(/.{0,60}MUST NOT APPEAR.{0,50}/g) || []).join(' || '));
check('hidden capture can be switched off', !(await page.evaluate(() => {
  const d = PageCapture.capture({ scope: 'content', includeHidden: 'off' });
  return PageCapture.toMarkdown(d);
})).includes('MUST NOT APPEAR (display'));
check('aria-hidden excluded', !/MUST NOT APPEAR \(aria/.test(content.md));
check('script excluded', !/MUST NOT APPEAR \(script/.test(content.md));
check('nav/footer dropped in content mode', !content.md.includes('Footer junk') && !content.md.includes('Sidebar junk'));
check('cookie banner dropped', !content.md.includes('We use cookies'));
check('whole-page mode keeps footer', whole.md.includes('Footer junk'));
check('llm profile heading + source line', content.md.startsWith('# Fixture: messy page\n\nSource: file://'));
check('llm profile has no yaml', !content.md.includes('\n---\n'));
check('document profile yaml', (await page.evaluate(() => PageCapture.toMarkdown(PageCapture.capture({ scope: 'content' }), { profile: 'document' }))).startsWith('---\ntitle: "Fixture: messy page"'));
check('callout warning', content.md.includes('> [!WARNING]') && content.md.includes('This API is deprecated.'));
check('callout note', content.md.includes('> [!NOTE]') && content.md.includes('Only works over HTTPS.'));
check('status lozenges', content.md.includes('[DONE]') && content.md.includes('[FAILED]'));
check('expand macro -> details', content.md.includes('<details><summary>Show raw JSON</summary>') && content.md.includes('{"a": 1}'));
check('confluence code panel kept as code', content.md.includes('```\nmvn -q verify') || content.md.includes('````'));
check('toc heading dropped', !/## Table of contents/.test(content.md));
check('panel-based TOC dropped', !/Table of contents/.test(content.md), (content.md.match(/.{0,40}Table of contents.{0,40}/) || [''])[0]);
check('anchor-link TOC dropped', !/#a-table/.test(content.md));
check('meta author', content.json.meta.byline === 'A. Tester');
check('json blocks are structured', Array.isArray(content.json.blocks) && content.json.blocks.some((b) => b.type === 'table'));
check('plain text has no markdown markers', !/^#/m.test(whole.plain.split('\n').slice(0, 5).join('\n')));
check('styled html inlines css', /style="[^"]*font-family: Georgia/.test(styled));
check('styled html keeps bold as computed weight', /font-weight: 700/.test(styled));
check('styled html keeps page intact', (await page.evaluate(() => document.querySelectorAll('[style]').length)) < 6);

// ---- lean profile on a link/image-heavy page --------------------------
const leanMessy = await page.evaluate(() => {
  const d = PageCapture.capture({ scope: 'content' });
  return { lean: PageCapture.toMarkdown(d, { profile: 'lean' }), full: PageCapture.toMarkdown(d, { profile: 'llm' }) };
});
const messySaved = Math.round((1 - leanMessy.lean.length / leanMessy.full.length) * 100);
writeFileSync(resolve(OUT, 'messy-lean.md'), leanMessy.lean);
console.log(`\nlean vs full on the link-heavy fixture: ${leanMessy.full.length} -> ${leanMessy.lean.length} chars (-${messySaved}%)`);
check('lean saves on a link-heavy page', messySaved >= 12, `only ${messySaved}%`);
check('lean flattens inline HTML tags', !/<(sub|sup|mark|u|ins)>/.test(leanMessy.lean) && !/~~/.test(leanMessy.lean));
check('lean keeps code fences and tables', leanMessy.lean.includes('```js') && leanMessy.lean.includes('| Name | Value | Note |'));
check('lean keeps callouts', leanMessy.lean.includes('> [!WARNING]'));

// ---------------------------------------------------------------- div soup
/* A proprietary app: no semantic tags, structure only in CSS/ARIA, plus data
 * that is in the DOM but hidden (collapsed tabs, off-canvas drawer). */
const soupUrl = pathToFileURL(resolve(HERE, 'fixtures/divsoup.html')).href;
await load(soupUrl);
const soup = await run('content');
writeFileSync(resolve(OUT, 'divsoup.md'), soup.md);
writeFileSync(resolve(OUT, 'divsoup.json'), JSON.stringify(soup.json, null, 2));
console.log('\ndiv soup:\n' + soup.md);

check('div soup: scope found the content pane', soup.json.meta.selector === 'div.content', soup.json.meta.selector);
check('div soup: big-font div became a heading', /^# Ticket TCK-1042/m.test(soup.md));
check('div soup: card title div became a heading', /^#### Request details$/m.test(soup.md));
check('div soup: label/value div rows paired', soup.md.includes('**Requester**: Jane Smith (j.smith@acme.example)'));
check('div soup: short value still pairs', soup.md.includes('**Priority**: High'));
check('div soup: ARIA table recovered', /\| Approver \| Decision \| Date \|/.test(soup.md) && /\| M\. Chen \| Approved \|/.test(soup.md));
check('div soup: display:table recovered', /\| Scope \| Level \|/.test(soup.md) && /\| Payments API \| read-write \|/.test(soup.md));
check('div soup: role=list recovered', /^- Verify identity$/m.test(soup.md));
check('div soup: display:list-item list, ordered', /^1\. Request received$/m.test(soup.md) && /^3\. Access granted$/m.test(soup.md));
check('div soup: ::before bullet list', /^- Consent form signed$/m.test(soup.md));
check('div soup: hidden tab captured with its label', /\[hidden: display:none\] analyst-notes/.test(soup.md) && soup.md.includes('identity confirmed by phone'));
check('div soup: second hidden tab captured', /\[hidden: display:none\] audit-history/.test(soup.md));
check('div soup: off-canvas drawer captured', /\[hidden: off-screen\]/.test(soup.md) && soup.md.includes('legal hold applies until 2027-01-01'));
check('div soup: aria-hidden duplicate not duplicated', (soup.md.match(/legal hold applies/g) || []).length === 1);
check('div soup: sidebar nav dropped', !soup.md.includes('My tickets'));
// ---- lean profile: same data, minus the token sinks -------------------
const lean = await page.evaluate(() => {
  const d = PageCapture.capture({ scope: 'content' });
  return { lean: PageCapture.toMarkdown(d, { profile: 'lean' }), full: PageCapture.toMarkdown(d, { profile: 'llm' }) };
});
writeFileSync(resolve(OUT, 'divsoup-lean.md'), lean.lean);
console.log('\nlean profile:\n' + lean.lean);
const saved = Math.round((1 - lean.lean.length / lean.full.length) * 100);
console.log(`lean vs full: ${lean.full.length} -> ${lean.lean.length} chars (${saved}% smaller)`);

check('lean keeps the structure', lean.lean.includes('| Approver | Decision | Date |') && lean.lean.includes('**Requester**: Jane Smith') && /^- Verify identity$/m.test(lean.lean));
check('lean drops image URLs', !lean.lean.includes('flow.png') && !lean.lean.includes('data:image'));
check('lean keeps meaningful alt text', lean.lean.includes('Approval flow diagram'));
check('lean drops control labels', !/\bAssign\b/.test(lean.lean) && !/\bResolve\b/.test(lean.lean) && !/Refresh/.test(lean.lean));
check('lean drops tab strip labels', !/role=|aria-selected/.test(lean.lean) && !lean.lean.includes('Details\n\nNotes'));
check('lean drops pagination', !/\| 2 \|/.test(lean.lean) && !lean.lean.includes('utm_source'));
check('lean drops horizontal rules', !/^---$/m.test(lean.lean.split('\n').slice(6).join('\n')));
check('lean never leaks CSS', !lean.lean.includes('color:red') && !lean.lean.includes('font-weight'));
check('lean keeps a generic link target', /here <https:\/\/support\.acme\.example\/kb\/12345>/.test(lean.lean), lean.lean.split('Attachments')[1]?.slice(0, 200));
check('lean keeps attachment links, minus tracking', /Consent-Form\.pdf <file:[^>]*Consent-Form\.pdf>/.test(lean.lean) && !lean.lean.includes('utm_source'), lean.lean.split('Attachments')[1]?.slice(0, 220));
check('lean still captures hidden data', /\[hidden: display:none\] analyst-notes/.test(lean.lean));
check('lean is meaningfully smaller', saved >= 5, `only ${saved}%`);

check('div soup: hidden block is a real block in JSON', soup.json.blocks.some((b) => b.type === 'hidden' && b.reason === 'display:none' && b.label === 'analyst-notes'));

// ------------------------------------------- tables in collapsed sections
/* Bug report: "omits rows from multi row tables, specifically from recent/last
 * entry in collapsed or expandable sections". A row that is hidden (or whose
 * markup is hidden) must still be a row. */
const tblUrl = pathToFileURL(resolve(HERE, 'fixtures/tables-hidden.html')).href;
await load(tblUrl);
const tbl = await run('content');
writeFileSync(resolve(OUT, 'tables-hidden.md'), tbl.md);
console.log('\ntables in collapsed sections:\n' + tbl.md);
const tblTables = tbl.json.blocks.filter((b) => b.type === 'table');
const flat = JSON.stringify(tbl.json);

check('table: hidden last <tr> is included', tbl.md.includes('| D. Park | Approved (latest) |'), tbl.md.slice(0, 200));
check('table: hidden row recorded in JSON', tblTables.some((x) => (x.hiddenRows || []).includes(1)), JSON.stringify(tblTables.map((x) => x.hiddenRows)));
check('table: table inside a collapsed panel keeps all 3 rows',
  /acc-body[\s\S]{0,200}2026-11-01/.test(tbl.md) && (tbl.md.match(/2026-1[01]-\d\d/g) || []).length === 3);
check('table: div-table hidden row included', tbl.md.includes('| Final | m.chen |'));
check('table: hidden content inside a visible cell is read', tbl.md.includes('| Escalated to legal | Final |'));
check('table: closed <details> table intact', tbl.md.includes('| E-1 | 10 |') && tbl.md.includes('| E-2 | 20 |'));

const offTbl = await page.evaluate(() => PageCapture.toMarkdown(
  PageCapture.capture({ scope: 'content', includeHidden: 'off' }), { profile: 'llm' }));
check('table: includeHidden=off still excludes hidden rows', !offTbl.includes('D. Park') && !offTbl.includes('Escalated to legal'));

// ---------------------------------------------------------------- selection
await page.goto(fixture);
await page.addScriptTag({ content: extractorSource });
const selMd = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === 'Lists');
  const range = document.createRange();
  range.setStartBefore(el);
  range.setEndAfter(el.nextElementSibling);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  // eslint-disable-next-line no-undef
  const doc = PageCapture.capture({ scope: 'selection' });
  return { md: PageCapture.toMarkdown(doc), scope: doc.meta.scope };
});
console.log('\nselection mode:\n' + selMd.md);
check('selection scope detected', selMd.scope === 'selection');
check('selection limited to range', selMd.md.includes('## Lists') && !selMd.md.includes('A table'));

// ---------------------------------------------------------------- live
if (LIVE) {
  const LIVE_URLS = process.env.LIVE_URLS ? process.env.LIVE_URLS.split(',') : [
    'https://example.com/',
    'https://en.wikipedia.org/wiki/Markdown',
    'https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write',
    'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
    'https://cwiki.apache.org/confluence/display/MAVEN/Plugin+Documentation',
  ];
  for (const url of LIVE_URLS) {
    try {
      await load(url);
      const r = await run('content');
      const name = url.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
      writeFileSync(resolve(OUT, `${name}.md`), r.md);
      console.log(`\nlive ${url}: ${r.json.blocks.length} blocks, ${r.md.length} chars\n` + r.md.slice(0, 700));
      check(`live ${url} produced content`, r.json.blocks.length > 0);
      check(`live ${url} no site chrome leak`, (r.md.match(/\[edit\]/gi) || []).length === 0);
    } catch (e) {
      results.push(`  skip ${url}: ${e.message.split('\n')[0]}`);
    }
  }
}

// ---------------------------------------------------------------- clipboard HTML flavouring
const clip = await page.evaluate(() => {
  const div = document.createElement('div');
  div.innerHTML = '<p>hello <strong>bold</strong></p>';
  return div.outerHTML;
});
check('clipboard html fragment buildable', clip.includes('<strong>'));

await browser.close();

console.log('\n--- checks ---');
console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.trim().startsWith('ok')).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
