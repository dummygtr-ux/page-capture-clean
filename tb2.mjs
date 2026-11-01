import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { resolveChromium } from './test/browser-path.mjs';
const src = readFileSync('src/extractor.js','utf8');
const b = await chromium.launch({executablePath: resolveChromium()});
const p = await b.newPage();
await p.goto('file://' + process.cwd() + '/test/fixtures/tables-hidden.html');
await p.evaluate(src);
const out = await p.evaluate(() => {
  const off = PageCapture.toMarkdown(PageCapture.capture({scope:'content', includeHidden:'off'}), {profile:'llm'});
  const json = PageCapture.capture({scope:'content'});
  return { off, tables: json.blocks.filter(b=>b.type==='table').map(t=>({head:t.head.length, rows:t.rows.length, hidden:t.hiddenRows||[]})) };
});
console.log(out.off.split('\n').slice(5,20).join('\n'));
console.log('tables in JSON:', JSON.stringify(out.tables));
await b.close();
