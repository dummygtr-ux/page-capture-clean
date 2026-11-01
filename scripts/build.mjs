/* Build both store-less targets: dist/chrome (MV3 service worker) and
 * dist/firefox (MV3 event page — Firefox does not run service workers). */
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const base = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));

rmSync(DIST, { recursive: true, force: true });

const INSTALL = `Page Capture — install from a folder (no store needed)

KEEP THIS FOLDER WHERE YOU UNZIPPED IT. Moving or deleting it breaks the
extension (the browser keeps referencing this exact path).

--- Microsoft Edge / Chrome / Chromium / Brave ---
1. Extract the zip to a permanent place, e.g.
     Windows:  %LOCALAPPDATA%\\PageCapture
     macOS:    ~/Library/Application Support/PageCapture
     Linux:    ~/.local/share/page-capture
2. Open  edge://extensions   (or chrome://extensions)
3. Turn ON "Developer mode" (left sidebar in Edge, top-right in Chrome)
4. Click "Load unpacked" and select THE FOLDER THAT CONTAINS manifest.json
   (if your extractor created a nested folder, go one level in)
5. The icon appears in the toolbar; pin it from the puzzle-piece menu.
6. Set the shortcut at  edge://extensions/shortcuts  (Alt+Shift is Windows' keyboard-layout switch, so the
   default is Ctrl+Shift+Y — rebind here if it clashes).

--- Firefox ---
Use the firefox/ build:  about:debugging#/runtime/this-firefox
-> Load Temporary Add-on -> pick manifest.json. Dropped on browser restart.

--- Verify it works ---
Open any page, press the shortcut, paste somewhere: you should see
"# Page title" and "Source: <url>" followed by the page content.
If the toolbar icon shows no popup data, open the page's console (F12) and
check edge://extensions for errors on this extension.

--- Why not a .crx ---
Chromium browsers refuse self-signed .crx installs unless an enterprise policy
allows it. Unpacked works everywhere; the store (Edge Add-ons, AMO) is the path
for a one-click install.
`;

function emit(name, manifest, note) {
  const dir = resolve(DIST, name);
  mkdirSync(dir, { recursive: true });
  for (const entry of ['src', 'icons']) {
    cpSync(resolve(ROOT, entry), resolve(dir, entry), { recursive: true });
  }
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(resolve(dir, 'INSTALL.txt'), INSTALL);
  if (note) writeFileSync(resolve(dir, 'BUILD.txt'), note + '\n');
  const zip = resolve(DIST, `${name}.zip`);
  execFileSync('zip', ['-qr', zip, '.'], { cwd: dir });
  console.log(`built ${name}: ${dir} (+ ${zip})`);
}

// Chrome / Chromium / Brave / Edge: MV3 with a background service worker.
emit('chrome', base, 'Load unpacked from this folder: chrome://extensions -> Developer mode -> Load unpacked.');

// Firefox: MV3 supports event pages, not service workers.
const ff = JSON.parse(JSON.stringify(base));
ff.background = { scripts: ['src/background.js'] };
ff.browser_specific_settings = { gecko: { id: 'page-capture@local', strict_min_version: '115.0' } };
emit('firefox', ff, 'Load as a temporary add-on: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> pick manifest.json.');
