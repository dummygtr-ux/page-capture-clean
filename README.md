# Page Capture → Markdown / JSON

A browser extension that turns the page you are looking at into **text that keeps its
structure**, so you can paste it into an LLM (Rovo, Claude, ChatGPT…) and the model can
still tell a heading from a bullet, a warning from body copy, and a table cell from the
next column.

- **Hotkey**: `Ctrl+Shift+Y` → copies the page, as Markdown, to the clipboard.
- `Ctrl+Shift+U` → copies only the selection.
- **Toolbar popup**: preview with char/token count, format + scope switching, copy, save file.
- **Right-click**: *Copy page as Markdown*, *Copy page structure as JSON*, *Copy with formatting*.

## Why Markdown and not CSS

CSS is styling, not content: it says *how* something looks, not *what* it is. Pasting CSS
into a chat window gives the model nothing to read. The useful formats are:

| Format | What it is | Use it when |
| --- | --- | --- |
| **Markdown (lean)** | the same structure with every browser-only detail stripped (see below) | **default** — fewest tokens for the same data |
| Markdown (paste-ready) | structure plus link targets, image sources, inline HTML tags | when the model must follow links or see assets |
| Markdown + front matter | same body, plus a YAML header (title/url/author/captured) | saving to a notes vault |
| **JSON structure** | the block tree itself: `{type:"heading",level:2}`, `{type:"table",head,rows}`, inline nodes with `bold`/`link`/`code` | piping into your own tooling, or when you need lossless structure |
| Plain text | no markup, indentation preserved | dumb targets (spreadsheets, grep) |
| Clean HTML | semantic HTML, sanitised | pasting into a CMS/wiki |
| **Styled HTML** | the *original* page HTML with computed CSS **inlined** (font, weight, colour, borders, spacing) | pasting into Word / Google Docs / Notion and keeping the look |

"Without breaking formatting" therefore means: the *structure* is preserved exactly, and if
you also want the *visual* formatting, the styled-HTML mode bakes the computed CSS into the
markup (external stylesheets never survive a paste, inlined ones do).

## Install

It is a plain (unpacked) browser extension — no store, no build step needed to run it.

### Chrome / Chromium / Brave / Edge
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select either:
   - this folder (it is already a valid extension), or
   - `dist/chrome/` if you want the packaged copy
4. `Ctrl+Shift+Y` captures and copies. Change it at `chrome://extensions/shortcuts` (Windows treats `Alt+Shift` as the keyboard-layout switch, hence `Ctrl+Shift`).

Or drag `dist/chrome.zip` into `chrome://extensions` — Chrome unpacks it for you.

### Firefox
Firefox does not run MV3 background service workers, so use the adapted build:
1. Run `npm run build` (already done — see `dist/firefox/`)
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`

Temporary add-ons are dropped when Firefox restarts; for a permanent install the
folder can be submitted to AMO or self-signed. This build is syntax-checked and its
manifest is adapted for Firefox, but the test suite only executes the Chromium target.

### Install from GitHub (another machine)

There is **no one-click install** for a sideloaded Chromium extension — Edge only
one-clicks from its store. What the repo gives you is a repeatable download:

1. **Releases** carry `page-capture-chrome.zip` (and `-firefox.zip`), built and
   tested by CI. Download → extract → Load unpacked.
2. Or one command, which downloads the latest release into a stable folder:

   ```bash
   # Linux/macOS
   curl -fsSL https://raw.githubusercontent.com/dummygtr-ux/page-capture-clean/main/scripts/install.sh | bash

   # Windows PowerShell
   iwr https://raw.githubusercontent.com/dummygtr-ux/page-capture-clean/main/scripts/install.ps1 -useb | iex
   ```

   Both still end with the same one-time browser step (Developer mode → Load
   unpacked), because the browser refuses to let anything automate that.

Pushing a tag publishes a release:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

True one-click would mean the [Edge Add-ons store](https://partner.microsoft.com/dashboard/microsoftedge/)
(free individual account, a few days of review) or an enterprise
`ExtensionSettings` force-install policy — both are possible from this repo later.

### What you get

Click the pinned icon and you get a small menu — the same gesture as any other extension:

```
┌──────────────────────────────────┐
│  Copy page                       │  ← copies immediately, shows a toast on the page
│  Markdown · lean · main content  │      and closes the menu      Ctrl+Shift+Y
├──────────────────────────────────┤
│  Change shortcut…              › │  ← opens the browser's shortcut settings
├──────────────────────────────────┤
│  Preview & format…             ▾ │  ← format / scope / hidden switches + preview
└──────────────────────────────────┘
```

- **Copy page** uses whatever format/scope you last chose and closes the menu; `Enter` does the same.
- **Change shortcut…** deep-links to `chrome://extensions/shortcuts` (`edge://` on Edge,
  `about:addons` on Firefox) — browsers do not let an extension rebind its own hotkey by API.
- **Preview & format…** is collapsed by default and only captures when opened, so the menu
  stays instant. It shows the char/token count, which scope won, and lets you save a file.
- Hotkeys: `Ctrl+Shift+Y` (page), `Ctrl+Shift+U` (selection).
- Right-click menu: Markdown, JSON structure, copy-with-formatting.

## What it does with a page

- Picks the **main content** by scoring candidates (text length, punctuation, paragraph count,
  link density, class/id hints) instead of guessing "the first `<main>`"; falls back to the
  whole page when nothing scores high enough. Scope is shown in the popup.
- Drops site chrome: nav, footers, sidebars, cookie banners, share/related blocks, breadcrumbs,
  page metadata, table-of-contents stubs, decorative icons, 1×1 tracking pixels.
- Maps semantics, not just text:

| On the page | In the output |
| --- | --- |
| `h1`–`h6`, `p` | `#`…`######`, paragraphs |
| `ul`/`ol` (nested, `start=`, task lists) | nested `-`/`1.`/`- [x]` with correct indentation |
| `pre > code.language-x` | fenced block with the language tag; fence widens if the code contains ``` |
| `table` with `th`/`thead` | GFM table, `\|` escaped inside cells, empty rows/columns pruned |
| `blockquote`, `figure`/`figcaption`, `dl`, `details` | `>`, italic caption, term/definition list, `<details>` |
| Confluence `aui-message` / `confluence-information-macro` / `.note` / `.warning` | `> [!WARNING]` … `> [!NOTE]` |
| TOC macros, page trees, anchor-link lists, "Table of contents" panels | dropped (an LLM gets the headings themselves) |
| Confluence status lozenge | `[DONE]` |
| Confluence expand macro | `<details><summary>…</summary>` |
| Confluence code macro | a code block, not a quote |
| `<strong> <em> <del> <mark> <sub> <sup> <code> <a> <img>` | `**b**` `*i*` `~~del~~` `<mark>` `H<sub>2</sub>` `` `code` `` `[text](url "title")` `![alt](src)` |

Links are rewritten to absolute URLs (`javascript:` and `#anchor` links are dropped) because a
model cannot click, but it can fetch. `<br>` becomes a hard line break; runs of spaces collapse.

## Token budget: what "lean" removes

Everything below is thrown away *before* the text is built — the extractor works on a block tree, so
scripts, styles and attributes are never candidates in the first place. `lean` is the default.

| Your category | What is dropped | Where it happens |
| --- | --- | --- |
| markup / presentational codes | all HTML tags and attributes; inline `<sub>/<sup>/<mark>/<u>/<ins>` become plain text; `<details>` flattens; `---` rules vanish | never serialised — a block tree is rendered to Markdown |
| asset / resource references | `<img>` sources (alt text survives when meaningful), `data:` URIs, spacer/tracking pixels, stylesheets, fonts, `srcset` | images render as text or nothing |
| boilerplate markup | nav, sidebars, footers, cookie banners, breadcrumbs, page metadata, TOC panels, page trees, `.sr-only`/visually-hidden dupes | scope + boilerplate rules |
| embedded JS / inline styling | `<script>`, `<style>`, `onclick`/`ng-click`/`data-action` handlers, `style="…"` attributes | never serialised |
| UI interaction scaffolding | `role=button|tab|tablist|toolbar|menu|menuitem|switch|checkbox|…`, action bars, kebab menus, pagination, close/dismiss controls, icon buttons | `isInteractiveChrome` |
| navigation / action chrome | nav clusters, toolbars, app bars, tab strips (their *panes* are kept), sort/pager controls | same gate + boilerplate rules |
| repeated noise | identical paragraphs collapse (deduped), hidden regions deduped by text, URLs lose `utm_*`/`fbclid`/`ref`/… | render + capture |

Link targets: `lean` keeps a link as its text, and keeps the URL only when the text does not carry it —
a file (`.pdf`, `.xlsx`, …) or a generic label ("here", "download"). That is where the savings are,
since link syntax is often the single biggest cost in a captured page:

| Page | full | lean | saving |
| --- | --- | --- | --- |
| Wikipedia article (link-heavy) | 41,202 chars ≈ 10,843 tok | 21,089 ≈ 5,550 tok | **−49%** |
| Confluence page | 5,838 ≈ 1,536 tok | 4,560 ≈ 1,200 tok | −22% |
| MDN API reference | 18,412 ≈ 4,845 tok | 15,096 ≈ 3,973 tok | −18% |
| ticket page, `<div>` soup with tables/lists | 1,418 ≈ 373 tok | 1,340 ≈ 352 tok | −6% |

Structure-dense pages save least — there the win is the chrome that surrounded the data, not the links.

## Proprietary pages: `<div>` soup and hidden data

Internal apps rarely use `<h1>`, `<table>` or `<ul>`; everything is a `<div>`, and
Ctrl+A → Ctrl+C flattens it. Two things matter there, and both are handled:

**1. Structure is inferred from behaviour, not from tag names.**

| Signal | Recovered as |
| --- | --- |
| `role="heading"` + `aria-level`, or font-size ≥ 1.18× body text, or a bold `title`/`heading`-ish class | heading (`#`…`####`) |
| `role="table"` / `role="grid"`, or `display:table` + `table-row` + `table-cell` | GFM table (header row from `columnheader` cells or a bold first row) |
| `role="list"` + `listitem`, `display:list-item`, a `::before` bullet (`content:"• "`), or literal `•`/`1.` text | nested list, ordered when `list-style-type` says so |
| a two-child row (flex/grid or `.row`/`.field`/`.kv`/`.detail` class) whose first child is bold or `label`-ish | `**Label**: value` |
| everything else with inline content only | paragraph |

**2. Hidden content is captured, not dropped.** Data in a collapsed tab, an
accordion, a slide-over drawer or off canvas is usually the data you want. Every
invisible region is tested for *why* it is invisible (`display:none`, `visibility`,
`opacity:0`, `content-visibility`, `details-closed`, `off-screen`, `clipped`,
`aria-hidden`, `hidden` attribute) and is then emitted, quoted and labelled:

```markdown
> [hidden: display:none] analyst-notes
> Analyst note: identity confirmed by phone on 2026-10-30.
```

Popup → *Hidden content in the DOM*: `Include and label it` (default),
`Ignore it`, or `Include everything` (also `aria-hidden`, which is normally
decorative duplicates). Regions are de-duplicated by text and capped at 80.

**When the output looks wrong**, choose format **Structure report**. It prints the
candidate list with scores, a DOM census (`<div>` share, display histogram), every
hidden region with reason + label + CSS path, which structures were inferred, and a
"Suspects" section that flags long unstructured divs, single-column tables,
`user-select:none` elements (the reason Ctrl+A/C misses text), iframes, canvases and
shadow roots. That report is the input needed to add a rule for a site I cannot see.

## Output shape

```markdown
# Page title

Source: https://example.com/docs/page
Author: A. Tester

## Section

- item with **bold** and a [link](https://example.com/x)
  1. nested, numbered from `start`

| Name | Value |
| --- | --- |
| alpha | 1 |

> [!WARNING]
> This API is deprecated.

```js
function f() {}
```
```

JSON is the same tree the Markdown was rendered from:

```json
{ "meta": { "url": "…", "title": "…", "scope": "main", "selector": "div#content", "capturedAt": "…" },
  "blocks": [ { "type": "heading", "level": 2, "inline": [ { "t": "text", "v": "Section" } ] },
              { "type": "list", "ordered": false, "items": [ … ] },
              { "type": "table", "head": [[{ "t": "text", "v": "Name" }]], "rows": [ … ] },
              { "type": "callout", "kind": "WARNING", "blocks": [ … ] } ] }
```

One block tree, four renderers (`toMarkdown`, `toHtml`, `toPlain`, `styledHtml`), so the JSON
can never disagree with the Markdown.

## Tests

```bash
npm install          # playwright-core only (dev)
npm run build        # -> dist/chrome, dist/firefox, both zipped
npm test             # 86 checks: formatting, div soup, hidden data, lean profile — no network
npm run test:e2e     # loads the real unpacked extension in Chromium and drives it
npm run test:dist    # builds, then runs the same e2e against dist/chrome
npm run shot         # renders the popup UI to test/out/popup.png and smoke-tests it
npm run test:live    # also captures wikipedia / MDN / Confluence into test/out/
```

`test/run.mjs` runs the shipping `src/extractor.js` byte-for-byte inside real Chromium — no
build step to drift. `test/e2e.mjs` launches Chromium with `--load-extension`, sends the same
messages the hotkey and popup send, and reads the clipboard back to prove the paste is correct.
Samples of every run land in `test/out/`.

## Known limits

- Browser-internal pages (`chrome://…`, the Web Store, extension pages) cannot be injected into.
- PDFs: whatever the built-in PDF viewer exposes, which is very little — not a real extractor.
- Content inside iframes, shadow DOM, or canvases is not captured (the report counts them).
- **Virtualised lists** (only the visible rows exist in the DOM) cannot be captured by any
  extractor — scroll through the list first so the rows are rendered.
- Lazy-loaded content that has not been scrolled into view is not there yet.
- `user-select: none` does not block this extension (it reads the DOM), but it is why Ctrl+A
  produces so little; the report counts those elements.
- Login-walled sites work fine (it reads the DOM you already have); the extension makes no
  network requests of its own.
- Very long pages are capped at ~2M characters of blocks.
