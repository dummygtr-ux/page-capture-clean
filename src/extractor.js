/* PageCapture extractor — classic script, no dependencies.
 *
 * Exposes `globalThis.PageCapture`:
 *   PageCapture.capture(options)     -> { meta, blocks }   (+ opts.document)
 *   PageCapture.toMarkdown(doc)       -> string
 *   PageCapture.toHtml(doc)           -> string  (semantic, sanitised)
 *   PageCapture.toPlain(doc)          -> string
 *   PageCapture.styledHtml(scopeEl)   -> string  (clean HTML + inlined computed CSS)
 *
 * The block tree is the single source of truth; every format is a renderer
 * over it, so the JSON says exactly what the Markdown says.
 */
(function (root) {
  'use strict';

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CENTER', 'DD', 'DETAILS',
    'DIALOG', 'DIR', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
    'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN',
    'MENU', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD',
    'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ]);

  const DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED',
    'CANVAS', 'VIDEO', 'AUDIO', 'TRACK', 'SOURCE', 'MAP', 'AREA', 'LINK', 'META',
    'BASE', 'TITLE', 'HEAD', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OPTGROUP',
    'OPTION', 'DATALIST', 'PROGRESS', 'METER', 'PARAM', 'SLOT', 'SVG',
  ]);

  const BOILERPLATE_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'FORM']);
  const BOILERPLATE_ROLES = new Set(['navigation', 'banner', 'complementary', 'contentinfo', 'search', 'dialog']);
  const BOILERPLATE_RE =
    /(^|[-_\s])(cookie|consent|gdpr|newsletter|subscribe|signup|popup|modal|overlay|drawer|sidebar|advert|sponsor|ads?|banner|breadcrumbs?|social|share|related|recommend|comments?|promo|paywall|skip-link|sr-only|screen-reader|visually-hidden|toc|toc-macro|editsection|navbox|printfooter|catlinks|mw-jump|pagetree|page-metadata|aui-skip-link|search-macro|byline|timestamp)($|[-_\s])/i;

  const INLINE_WRAP = {
    STRONG: 'b', B: 'b',
    EM: 'i', I: 'i', CITE: 'i', DFN: 'i', VAR: 'i',
    CODE: 'code', KBD: 'code', SAMP: 'code', TT: 'code',
    DEL: 'del', S: 'del', STRIKE: 'del',
    MARK: 'mark',
    SUB: 'sub', SUP: 'sup',
    INS: 'ins', U: 'u',
  };

  // ---------------------------------------------------------------- helpers

  /* Why is this element invisible? The reason matters twice over: hidden
   * content is often the data you actually want (a collapsed tab, an
   * accordion, a virtualised row), and the reason is what tells you where it
   * came from. Returns null when the element is visible. */
  function hiddenReason(el, win) {
    if (el.hidden) return 'hidden-attr';
    if (el.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    const cs = win.getComputedStyle(el);
    if (!cs) return null;
    if (cs.display === 'none') return 'display:none';
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility';
    if (cs.contentVisibility === 'hidden') return 'content-visibility';
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) return 'opacity:0';
    // pulled off-canvas: common for pre-rendered panels and slide-over drawers
    if ((cs.position === 'absolute' || cs.position === 'fixed')) {
      const left = parseFloat(cs.left), top = parseFloat(cs.top);
      if ((Number.isFinite(left) && left < -2000) || (Number.isFinite(top) && top < -2000)) return 'off-screen';
      if (cs.clip && /rect\(0(px)?, 0(px)?, 0(px)?, 0(px)?\)/.test(cs.clip)) return 'clipped';
    }
    if (cs.clipPath && /inset\(50%|circle\(0/.test(cs.clipPath)) return 'clipped';
    const d = el.ownerDocument;
    // the <details> element itself is visible; only its content is not
    const details = el.parentElement && el.parentElement.closest && el.parentElement.closest('details');
    if (details && !details.open) {
      const firstSum = details.querySelector(':scope > summary');
      if (!firstSum || !firstSum.contains(el)) return 'details-closed';
    }
    return null;
  }

  function isHidden(el, win) {
    return !!hiddenReason(el, win);
  }

  /* A row is rarely hidden itself; its wrapper, rowgroup or panel is. */
  function hiddenReasonDeep(el, ctx) {
    let n = el, hops = 0;
    while (n && n.nodeType === 1 && hops++ < 40) {
      const r = hiddenReason(n, ctx.win);
      if (r) return r;
      n = n.parentElement;
    }
    return null;
  }

  function isIcon(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!/aui-icon|(^|[-_\s])(icon|iconfont|emoji|glyph|spinner|skeleton|ripple|badge-dot)([-_\s]|$)/i.test(cls)) return false;
    return (el.textContent || '').trim().length <= 2 && !el.querySelector('img,svg');
  }

  /* The one gate every element passes through before it contributes content. */
  function skipEl(el, ctx) {
    if (DROP_TAGS.has(el.tagName)) return true;
    if (isIcon(el)) return true;
    if (ctx.forceVisible) return false;          // inside captured-hidden regions
    if (!el.isConnected) return false;           // detached subtree: no layout to trust
    return !!hiddenReason(el, ctx.win);
  }

  function classHint(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    const tokens = cls.split(/\s+/).filter((t) => t && t.length > 2 &&
      !/^(css|sc|jsx|emotion|svelte|ng)-|^[a-z]{1,3}\d{3,}$/i.test(t));
    return tokens.slice(0, 3).join(' ');
  }

  /* Capture an invisible region anyway, but label it so the reader knows it was
   * not on the screen. Deduplicated, size-gated and capped, because naive
   * "capture everything hidden" in a modern app yields menus and tooltips. */
  function maybePushHidden(el, reason, push, ctx, opts) {
    if (opts.includeHidden === 'off') return;
    if (ctx.hiddenCount >= 80) return;
    if (/^(aria-hidden|hidden-attr)$/.test(reason) && opts.includeHidden !== 'all') return;
    if (isIcon(el)) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 12) return;
    const key = text.slice(0, 240).toLowerCase();
    if (ctx.seenHidden.has(key)) return;
    ctx.seenHidden.add(key);

    const label = (el.getAttribute('aria-label') || el.getAttribute('data-label') ||
      el.getAttribute('data-testid') || el.getAttribute('data-test') ||
      el.getAttribute('title') || classHint(el) || '').trim();

    const prev = ctx.forceVisible;
    ctx.forceVisible = true;
    const inner = [];
    try {
      walkBlocks(el, inner, ctx, Object.assign({}, opts, { dropBoilerplate: false }));
    } finally {
      ctx.forceVisible = prev;
    }
    if (!inner.length) return;
    ctx.hiddenCount++;
    push({ type: 'hidden', reason, label, blocks: inner });
  }

  function isPreformatted(win, el) {
    const d = win.getComputedStyle(el).whiteSpace || '';
    return d.startsWith('pre');
  }

  function isBlockish(win, el) {
    if (BLOCK_TAGS.has(el.tagName)) return true;
    const d = win.getComputedStyle(el).display || '';
    return d.startsWith('block') || d.startsWith('table') || d.startsWith('flex') ||
      d.startsWith('grid') || d === 'list-item' || d.startsWith('flow-root');
  }

  // Analytics/attribution parameters: pure token cost, zero information.
  const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|mkt_tok|_ga|_gl|igshid|spm|trk|s_kwcid|wt_mc|pk_campaign|pk_source|pk_medium|ref|referrer|ref_src|source|at_medium|at_campaign)$/i;

  function cleanUrl(href) {
    if (!href) return href;
    try {
      const u = new URL(href);
      if (!/^(https?|file):$/i.test(u.protocol)) return href;
      let changed = false;
      for (const k of Array.from(u.searchParams.keys())) {
        if (TRACKING_PARAM.test(k)) { u.searchParams.delete(k); changed = true; }
      }
      if (!u.search) u.search = '';
      return changed ? u.href : href;
    } catch (e) { return href; }
  }

  function absUrl(url, base) {
    if (!url) return '';
    const u = String(url).trim();
    if (!u) return '';
    if (/^(javascript|vbscript):/i.test(u)) return '';
    if (/^data:/i.test(u) && !/^data:image\//i.test(u)) return '';
    if (u.startsWith('#')) return u;
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function textLen(el) {
    const t = el.innerText || el.textContent || '';
    return t.trim().length;
  }

  /* --------------------------------------------------------- scope picking
   * Readability-style scoring. The goal is not "extract the article" for a
   * reader, it is "hand an LLM everything that belongs to the document, and
   * nothing that belongs to the site chrome around it".
   * ------------------------------------------------------------------- */

  const CANDIDATE_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'TD', 'BLOCKQUOTE', 'PRE', 'FORM', 'UL', 'OL', 'DL']);
  const NEGATIVE_RE = /(^|[-_\s])(nav|menu|footer|header|sidebar|comment|meta|social|share|breadcrumb|banner|advert|sponsor|promo|popup|modal|newsletter|subscribe|cookie|consent|paywall|related|recommend|masthead|toolbar|pagination|pager|skip|sr-only|screen-reader|visually-hidden|edit|editsection|toc|toc-macro|navbox|printfooter|catlinks|mw-jump|indicators|jump|pagetree|page-metadata|skip-link)($|[-_\s])/i;
  const POSITIVE_RE = /(^|[-_\s])(article|body|content|entry|main|markdown|post|text|blog|story|prose|documentation|md-content|page-content)($|[-_\s])/i;

  function classWeight(el) {
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    let w = 0;
    if (NEGATIVE_RE.test(id) || NEGATIVE_RE.test(cls)) w -= 25;
    if (POSITIVE_RE.test(id) || POSITIVE_RE.test(cls)) w += 25;
    return w;
  }

  function linkDensity(el) {
    const total = (el.textContent || '').length;
    if (!total) return 0;
    let links = 0;
    for (const a of el.querySelectorAll('a')) links += (a.textContent || '').length;
    return Math.min(1, links / total);
  }

  function scoreCandidate(el) {
    const text = el.textContent || '';
    const len = text.replace(/\s+/g, ' ').trim().length;
    if (len < 140) return -Infinity;
    const commas = (text.match(/[,،、]/g) || []).length;
    const paragraphs = el.querySelectorAll('p, li, pre, h1, h2, h3, h4, td').length;
    let score = 1 + commas + Math.min(3, Math.floor(len / 100)) + Math.min(10, paragraphs);
    score += classWeight(el);
    const density = linkDensity(el);
    if (density > 0.5) score *= 1 - density;      // link farms, nav blocks
    if (el.tagName === 'ARTICLE') score += 8;
    if (el.tagName === 'MAIN') score += 4;
    if (el.tagName === 'BODY') score -= 12;
    return score;
  }

  function pickByScore(doc) {
    const win = doc.defaultView;
    const scored = [];
    for (const el of doc.body.querySelectorAll('*')) {
      if (!CANDIDATE_TAGS.has(el.tagName)) continue;
      if (!el.isConnected) continue;
      const score = scoreCandidate(el);
      if (score === -Infinity) continue;
      scored.push({ el, score });
    }
    if (!scored.length) return null;

    // Propagate to ancestors so a wrapper that holds one good child wins over
    // the child itself when the child is only a slice (multi-column layouts).
    const byEl = new Map(scored.map((s) => [s.el, s]));
    for (const { el, score } of scored.slice()) {
      let p = el.parentElement, div = 1;
      while (p && div <= 2 && p !== doc.body) {
        const hit = byEl.get(p);
        if (hit) hit.score += score / (div * 4);
        p = p.parentElement; div++;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];
    if (!winner) return null;

    // If the winner is a sliver of its parent, the parent is the document.
    let el = winner.el;
    const parent = el.parentElement;
    if (parent && parent !== doc.body) {
      const childLen = (el.textContent || '').length;
      const parentLen = (parent.textContent || '').length;
      if (parentLen > childLen * 1.35 && linkDensity(parent) < 0.3) el = parent;
    }
    const len = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (len < 300) return null;
    return el;
  }

  function describe(el) {
    if (!el) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    if (cls) s += '.' + cls;
    return s;
  }

  function pickScope(doc, opts) {
    const win = doc.defaultView;
    if (opts.scope === 'selection') {
      const sel = win.getSelection && win.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        return { kind: 'selection', range: sel.getRangeAt(0), el: doc.body };
      }
    }
    if (opts.scope === 'page') return { kind: 'page', el: doc.body || doc.documentElement, selector: 'body' };

    const el = pickByScore(doc);
    if (el) return { kind: 'main', el, selector: describe(el) };
    return { kind: 'page', el: doc.body || doc.documentElement, selector: 'body' };
  }

  // ---------------------------------------------------------------- inline

  function mergeText(nodes) {
    const out = [];
    for (const n of nodes) {
      const prev = out[out.length - 1];
      if (n.t === 'text') {
        if (!n.v) continue;
        if (prev && prev.t === 'text') { prev.v += n.v; continue; }
        if (prev && prev.t === 'br') n.v = n.v.replace(/^[ \t\n]+/, '');
        if (!n.v) continue;
      }
      if (n.t === 'br' && prev && prev.t === 'text') prev.v = prev.v.replace(/[ \t\n]+$/, '');
      out.push(n);
    }
    return out;
  }

  function trimInline(nodes) {
    const out = nodes.slice();
    while (out.length) {
      const n = out[0];
      if (n.t === 'text') {
        n.v = n.v.replace(/^[ \t\n]+/, '');
        if (!n.v) { out.shift(); continue; }
      } else if (n.t === 'br') { out.shift(); continue; } else break;
      break;
    }
    while (out.length) {
      const n = out[out.length - 1];
      if (n.t === 'text') {
        n.v = n.v.replace(/[ \t\n]+$/, '');
        if (!n.v) { out.pop(); continue; }
      } else if (n.t === 'br') { out.pop(); continue; } else break;
      break;
    }
    return mergeText(out);
  }

  /* Turn a node's children into inline nodes. `preserveWs` keeps text verbatim
   * (inside white-space:pre elements). */
  /* Inline nodes for ONE element, including the element's own formatting.
   * This is the single place that decides how an element becomes inline
   * markup; both the block walker and the inline collector go through it. */
  function inlineForElement(el, ctx, pre) {
    const win = ctx.win, base = ctx.base;
    const tag = el.tagName;
    if (skipEl(el, ctx)) return [];
    const pre2 = pre || isPreformatted(win, el);

    switch (tag) {
      case 'BR':
        return [{ t: 'br' }];
      case 'IMG': {
        const src = absUrl(el.getAttribute('src') || el.getAttribute('data-src') || el.currentSrc || '', base);
        if (!src) return [];
        const w = el.naturalWidth || el.width || 0;
        const h = el.naturalHeight || el.height || 0;
        if (w && h && w <= 2 && h <= 2) return [];            // spacer / tracker pixel
        return [{ t: 'img', src, alt: (el.getAttribute('alt') || '').trim(), title: el.getAttribute('title') || '' }];
      }
      case 'PICTURE': {
        const img = el.querySelector('img');
        return img ? inlineForElement(img, ctx, pre2) : [];
      }
      case 'A': {
        const href = absUrl(el.getAttribute('href'), base);
        const kids = collectChildren(el, ctx, pre2);
        if (!href || href.startsWith('#')) return kids;        // in-page anchor: text only
        if (!kids.length) return [];
        return [{ t: 'a', href, title: el.getAttribute('title') || '', c: kids }];
      }
      case 'ABBR':
        return collectChildren(el, ctx, pre2);
      case 'MARK_STUB':
        return [];
      default: {
        if (isStatus(el)) {
          const t = (el.textContent || '').trim();
          if (t) return [{ t: 'text', v: '[' + t + ']' }];
          return [];
        }
        const wrap = INLINE_WRAP[tag];
        if (wrap) {
          const kids = collectChildren(el, ctx, pre2);
          return kids.length ? [{ t: wrap, c: kids }] : [];
        }
        return collectChildren(el, ctx, pre2);
      }
    }
  }

  function collectChildren(container, ctx, pre) {
    const out = [];
    for (const n of container.childNodes) {
      if (n.nodeType === 3) {
        const raw = n.nodeValue;
        if (!raw) continue;
        const v = pre ? raw : raw.replace(/[\t\r\n ]+/g, ' ');
        if (v) out.push({ t: 'text', v });
      } else if (n.nodeType === 1) {
        out.push(...inlineForElement(n, ctx, pre));
      }
    }
    return out;
  }

  /* Trimmed inline content of a container element (its children, not itself). */
  function collectInline(container, ctx, preserveWs) {
    const out = container.nodeType === 3
      ? [{ t: 'text', v: container.nodeValue }]
      : collectChildren(container, ctx, !!preserveWs);
    return trimInline(mergeText(out));
  }

  function inlineOf(el, ctx) {
    return collectInline(el, ctx, false);
  }

  // -------------------------------------------------- wiki / macro semantics
  /* Confluence, wiki and doc-site conventions for things that are NOT plain
   * paragraphs. Without this, panels and statuses read as stray sentences and
   * an LLM cannot tell a warning from body copy. */
  // Exact class tokens / macro names that mean "this is a callout", not a
  // substring match: `main.aui-page-panel` is a layout container, not a note.
  const CALLOUT_TOKENS = {
    'aui-message': 1, 'confluence-information-macro': 1, admonition: 1, callout: 1, notification: 1,
    note: 1, tip: 1, warning: 1, important: 1, caution: 1, info: 1, alert: 1, danger: 1, error: 1, success: 1,
    'md-note': 1, 'md-warning': 1, 'md-tip': 1, 'md-important': 1,
  };
  const MACRO_CALLOUTS = { info: 1, note: 1, warning: 1, tip: 1, panel: 1 };
  const KIND_MAP = {
    info: 'NOTE', information: 'NOTE', information_macro: 'NOTE', note: 'NOTE', message: 'NOTE', panel: 'NOTE',
    tip: 'TIP', success: 'TIP',
    warning: 'WARNING', caution: 'WARNING', alert: 'WARNING', error: 'WARNING',
    important: 'IMPORTANT', danger: 'DANGER',
  };
  const LAYOUT_RE = /(page-panel|splitter|wrapper|layout|container|content-body|page-body|ia-)/i;

  function calloutKind(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/\bcode\b/.test(cls)) return null;                       // code panel: handled as code
    if (LAYOUT_RE.test(cls)) return null;                          // page scaffold
    if (/^(MAIN|BODY|ARTICLE|HTML)$/.test(el.tagName)) return null;

    const macro = (el.getAttribute && (el.getAttribute('data-macro-name') || '')) || '';
    const tokens = cls.split(/\s+/).filter(Boolean);

    let kindWord = null, isCallout = false;
    for (const t of tokens) {
      const parts = t.split('-');
      for (const x of parts) if (KIND_MAP[x]) kindWord = x;        // aui-message-warning -> warning
      if (CALLOUT_TOKENS[t]) isCallout = true;
      else if (CALLOUT_TOKENS[parts[0]] && parts.length > 1) isCallout = true;
      else if (/^(aui-message|confluence-information-macro|admonition|callout|alert)(-|$)/.test(t)) isCallout = true;
    }
    if (MACRO_CALLOUTS[macro]) { isCallout = true; kindWord = kindWord || macro; }
    if (!isCallout) return null;

    const len = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (len > 5000) return null;                                   // too big to be a callout
    return KIND_MAP[kindWord] || 'NOTE';
  }

  function isStatus(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    return /aui-lozenge|status-macro|aui-badge|\blabel\b|\bbadge\b|\btag\b/i.test(cls);
  }

  function expandParts(el) {
    const ctrl = el.querySelector('[class*="expand-control"], [class*="expand-control-text"], summary');
    const content = el.querySelector('[class*="expand-content"], .expand-content');
    if (!content) return null;
    return { control: ctrl, content };
  }

  function headingIsChrome(text) {
    return /^(table of contents|contents|on this page|in this article|jump to|navigation|breadcrumb)\s*[:(]?\s*$/i.test((text || '').trim());
  }

  // Macros that are pure navigation. Their content is a link list to the page's
  // own headings, which an LLM gets as headings anyway.
  const NAV_MACROS = { toc: 1, pagetree: 1, children: 1, labels: 1, spaces: 1, 'recently-updated': 1, navmap: 1, breadcrumbs: 1 };

  function macroName(el) {
    return (el.getAttribute && (el.getAttribute('data-macro-name') || '')) || '';
  }

  /* A block that is nothing but in-page anchor links is a table of contents. */
  function isAnchorToc(el) {
    const links = el.querySelectorAll('a[href^="#"]');
    if (links.length < 3) return false;
    const linkText = Array.from(links).reduce((n, a) => n + (a.textContent || '').trim().length, 0);
    const allText = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    return linkText / Math.max(1, allText) > 0.6;
  }

  /* Strip redundant emphasis from inside a heading ("## **Guide**"). */
  function plainifyInline(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.t === 'b') {
        out.push(...plainifyInline(n.c || []));
      } else if (n.c) out.push(Object.assign({}, n, { c: plainifyInline(n.c) }));
      else out.push(n);
    }
    return out;
  }

  // ---------------------------------------------------------------- blocks

  function makeCtx(doc) {
    const win = doc.defaultView || root;
    let baseFont = 16;
    try { baseFont = parseFloat(win.getComputedStyle(doc.body).fontSize) || 16; } catch (e) { /* detached */ }
    return {
      win, base: doc.baseURI || '', doc, baseFont,
      forceVisible: false, hiddenCount: 0, seenHidden: new Set(),
    };
  }

  // UI interaction scaffolding: controls, not content. Roles and handler
  // attributes say "this is a verb", so their label is chrome, not data.
  const INTERACTIVE_ROLE = /^(button|menuitem|menuitemcheckbox|menuitemradio|menubar|tab|tablist|toolbar|menu|switch|checkbox|radio|option|combobox|listbox|slider|spinbutton|scrollbar|searchbox|textbox|search|progressbar)$/;
  const CONTROL_CLASS_RE = /(^|[-_\s])(btn|button|buttons|toolbar|actions?|kebab|pagination|pager|stepper|close|dismiss|toggle|switch|chip-button|icon-btn|nav-?bar|topbar|app-?bar|fab)($|[-_\s])/i;

  function isInteractiveChrome(el) {
    const text = (el.textContent || '').trim();
    if (text.length > 120) return false;                    // too much text to be a control
    if (el.querySelector('p, table, pre, [role="table"], ul, ol, dl')) return false;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role && INTERACTIVE_ROLE.test(role)) return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('ng-click') || el.hasAttribute('data-action')) return true;
    const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
    if (cls.trim() && CONTROL_CLASS_RE.test(cls)) return true;
    // A container of nothing but *controls* is an action bar. Plain <a> children
    // do not count: a paragraph or citation line made of links is content.
    if (!/^(DIV|SECTION|SPAN|HEADER|FOOTER|NAV|ASIDE|TD|FORM|LI|P|H[1-6])$/.test(el.tagName)) return false;
    if (/^(P|H[1-6]|LI|TD)$/.test(el.tagName)) return false;
    const kids = Array.from(el.children).filter((c) => !isIcon(c));
    if (kids.length >= 2) {
      const allControls = kids.every((c) => {
        const r = (c.getAttribute('role') || '').toLowerCase();
        return INTERACTIVE_ROLE.test(r) || c.tagName === 'BUTTON' ||
          c.hasAttribute('onclick') || c.hasAttribute('data-action');
      });
      if (allControls && (el.textContent || '').trim().length < 120) return true;
    }
    return false;
  }

  function isBoilerplate(el) {
    if (BOILERPLATE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && BOILERPLATE_ROLES.has(role)) return true;
    const id = el.id || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    return !!(id && BOILERPLATE_RE.test(id)) || !!(cls && BOILERPLATE_RE.test(cls));
  }

  function intersects(el, range) {
    try { return range.intersectsNode(el); } catch (e) { return true; }
  }

  function codeFrom(pre, ctx) {
    const codeEl = pre.querySelector('code') || pre;
    let text = (codeEl.textContent || '').replace(/^\n/, '').replace(/[ \t]+$/, '');
    const cls = (codeEl.className || '') + ' ' + (pre.className || '');
    let lang = '';
    const m = /(?:^|\s)(?:language|lang|brush:|highlight-source)-?([a-z0-9+#]+)\b/i.exec(cls);
    if (m) lang = m[1].toLowerCase();
    if (!lang) {
      const d = pre.getAttribute('data-lang') || codeEl.getAttribute('data-lang');
      if (d) lang = d.toLowerCase();
    }
    // strip a common indent so pasted code isn't ragged
    const lines = text.split('\n');
    const ind = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
    const cut = ind.length ? Math.min(...ind) : 0;
    if (cut) text = lines.map((l) => l.slice(cut)).join('\n');
    return { text, lang };
  }

  function listFrom(list, ctx, opts) {
    const ordered = list.tagName === 'OL';
    const start = ordered ? Number(list.getAttribute('start') || 1) || 1 : 1;
    const items = [];
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI' || skipEl(li, ctx)) continue;
      let checked = null;
      const box = li.querySelector(':scope > input[type="checkbox"]');
      if (box) checked = !!box.checked;
      const blocks = [];
      walkBlocks(li, blocks, ctx, Object.assign({}, opts, { dropBoilerplate: false }));
      if (!blocks.length) continue;
      items.push({ checked, blocks });
    }
    if (!items.length) return null;
    return { type: 'list', ordered, start, items };
  }

  function dlFrom(dl, ctx, opts, push) {
    const items = [];
    let cur = null;
    for (const c of Array.from(dl.children)) {
      if (c.tagName === 'DT') {
        cur = { term: inlineOf(c, ctx), blocks: [] };
        items.push(cur);
      } else if (c.tagName === 'DD' && cur) {
        walkBlocks(c, cur.blocks, ctx, Object.assign({}, opts, { dropBoilerplate: false }));
      }
    }
    const out = items.map((i) => ({
      checked: null,
      blocks: [{ type: 'para', inline: i.term.length ? [{ t: 'b', c: i.term }] : [] }].concat(i.blocks),
    })).filter((i) => i.blocks[0].inline.length || i.blocks.length > 1);
    if (out.length) push({ type: 'list', ordered: false, start: 1, items: out, deflist: true });
  }

  function tableFrom(table, ctx, opts) {
    const includeHidden = !opts || opts.includeHidden !== 'off';

    const rows = Array.from(table.querySelectorAll('tr')).filter((tr) => {
      let p = tr.parentElement;
      while (p && p !== table) {
        if (p.tagName === 'TABLE') return false;          // a nested table's row
        p = p.parentElement;
      }
      return true;
    });
    if (!rows.length) return null;

    /* Cells must be read even when the row is invisible: a collapsed section
     * still holds that row's data, which is exactly what this tool is for.
     * `includeHidden: 'off'` is the one setting that excludes them. */
    const kept = [];
    for (const tr of rows) {
      const reason = hiddenReasonDeep(tr, ctx);
      if (reason && !includeHidden) continue;
      const prev = ctx.forceVisible;
      // Inside a data cell, always read through hidden wrappers: the cell is a
      // record, and a hidden span inside it is usually the value's own markup.
      if (reason || includeHidden) ctx.forceVisible = true;
      let cells;
      try {
        cells = Array.from(tr.children)
          .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
          .map((c) => inlineOf(c, ctx));
      } finally {
        ctx.forceVisible = prev;
      }
      if (!cells.length) continue;
      kept.push({ tr, cells, hidden: !!reason });
    }
    if (!kept.length) return null;

    const cellEmpty = (c) => !c || !c.some((n) => (n.v || '').trim() || n.t !== 'text');
    // A spacer row is only a spacer if the DOM row is empty too.
    let kept2 = kept.filter((r) => !r.cells.every(cellEmpty) || (r.tr.textContent || '').trim().length > 0);
    if (!kept2.length) kept2 = kept;

    // Drop columns that are empty in every row (infobox spacers).
    const width0 = Math.max(1, ...kept2.map((r) => r.cells.length));
    const keepCol = [];
    for (let i = 0; i < width0; i++) keepCol.push(kept2.some((r) => !cellEmpty(r.cells[i])));
    let finalRows = kept2
      .map((r) => ({ ...r, cells: r.cells.filter((_, i) => keepCol[i]) }))
      .filter((r) => r.cells.length);
    if (!finalRows.length) finalRows = kept2;

    const first = finalRows[0].tr;
    const firstCells = Array.from(first.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    const isHead = firstCells.some((c) => c.tagName === 'TH') || !!first.closest('thead');
    const headCount = isHead ? 1 : 0;

    const width = Math.max(1, ...finalRows.map((r) => r.cells.length));
    const pad = (cells) => cells.concat(Array.from({ length: Math.max(0, width - cells.length) }, () => []));
    const rendered = finalRows.map((r) => pad(r.cells));
    const hiddenRows = finalRows.map((r, i) => (r.hidden ? i - headCount : -1)).filter((i) => i >= 0);

    return {
      type: 'table',
      head: isHead ? [rendered[0]] : [],
      rows: isHead ? rendered.slice(1) : rendered,
      ...(hiddenRows.length ? { hiddenRows } : {}),
    };
  }

  // ------------------------------------------------------- generic structure
  /* Proprietary apps use <div> for everything: the tag says nothing, the
   * computed style and the ARIA role say everything. These helpers recover
   * headings, tables, lists and label/value pairs from div soup so the reader
   * still gets structure instead of one wall of text. */

  const HEADING_CLASS_RE = /(^|[-_\s])(title|heading|headline|section-?title|card-?title|page-?title|panel-?title|group-?title|field-?group-?label)($|[-_\s])/i;
  const LABEL_CLASS_RE = /(^|[-_\s])(label|key|lbl|field-?name|field-?label|term|caption|prop-?name|attribute)([$|[-_\s]])/i;

  function blockishDisplay(win, el) {
    const d = win.getComputedStyle(el).display || '';
    return d.startsWith('block') || d.startsWith('flex') || d.startsWith('grid') ||
      d.startsWith('table') || d === 'list-item' || d.startsWith('flow-root');
  }

  function hasBlockChild(win, el) {
    for (const c of el.children) {
      if (isIcon(c)) continue;
      if (blockishDisplay(win, c)) return true;
    }
    return false;
  }

  function pseudoMarker(win, el) {
    try {
      const c = win.getComputedStyle(el, '::before').content || '';
      const m = /^["']?(•|·|▪|◦|‣|⁃|-|\*|\d+[.)])/.exec(c.trim());
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function headingLevelFor(el, ctx) {
    const win = ctx.win;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 180) return 0;
    if (/^[\d.,:%$€£+\-/\s]+$/.test(text)) return 0;        // KPI numbers are not headings
    const cs = win.getComputedStyle(el);
    const ratio = (parseFloat(cs.fontSize) || ctx.baseFont) / (ctx.baseFont || 16);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const role = (el.getAttribute('role') || '').toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' +
      (el.getAttribute('data-testid') || '');

    if (role === 'heading') {
      const lvl = parseInt(el.getAttribute('aria-level'), 10) || (ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3);
      return Math.min(6, Math.max(1, lvl));
    }
    if (ratio >= 1.75) return 1;
    if (ratio >= 1.45) return 2;
    if (ratio >= 1.18) return 3;
    if (HEADING_CLASS_RE.test(cls) && weight >= 600) return 4;
    return 0;
  }

  /* <div role="table"> / display:table — recover the grid. */
  function divTable(el, ctx, opts) {
    const win = ctx.win;
    const includeHidden = !opts || opts.includeHidden !== 'off';
    const role = (el.getAttribute('role') || '').toLowerCase();
    const disp = win.getComputedStyle(el).display;
    if (!(role === 'table' || role === 'grid' || disp === 'table' || disp === 'inline-table')) return null;

    const rows = [];
    (function collect(node) {
      for (const c of node.children) {
        const r = (c.getAttribute('role') || '').toLowerCase();
        const d = win.getComputedStyle(c).display;
        if (r === 'row' || d === 'table-row') rows.push(c);
        else if (r === 'rowgroup' || r === 'grid' || d === 'table-row-group') collect(c);
      }
    })(el);
    if (!rows.length) return null;

    const kept = [];
    for (const row of rows) {
      const reason = hiddenReasonDeep(row, ctx);
      if (reason && !includeHidden) continue;
      const prev = ctx.forceVisible;
      if (reason || includeHidden) ctx.forceVisible = true;
      const cells = [];
      try {
        for (const c of row.children) {
          const r = (c.getAttribute('role') || '').toLowerCase();
          const d = win.getComputedStyle(c).display;
          const isCell = /^(cell|gridcell|columnheader|rowheader)$/.test(r) ||
            d === 'table-cell' || d === 'grid-cell' || r === '';
          if (isCell) cells.push({ el: c, header: r === 'columnheader' || r === 'rowheader', inline: inlineOf(c, ctx) });
        }
      } finally {
        ctx.forceVisible = prev;
      }
      if (cells.length) kept.push({ cells, hidden: !!reason });
    }
    if (!kept.length) return null;

    const width = Math.max(...kept.map((r) => r.cells.length));
    if (width < 2) return null;                            // a stack, not a table

    const pad = (r) => r.concat(Array.from({ length: width - r.length }, () => ({ el: null, inline: [] })));
    const rendered = kept.map((r) => pad(r.cells).map((c) => (c.el ? c.inline : [])));

    const firstRow = kept[0];
    const headerish = firstRow.cells.some((c) => c.header) || firstRow.cells.every((c) => {
      if (!c.el) return false;
      const target = c.el.querySelector('b,strong') || c.el;
      return (parseInt(win.getComputedStyle(target).fontWeight, 10) || 400) >= 600;
    });
    const headCount = headerish ? 1 : 0;
    const hiddenRows = kept.map((r, i) => (r.hidden ? i - headCount : -1)).filter((i) => i >= 0);

    return {
      type: 'table',
      head: headerish ? [rendered[0]] : [],
      rows: headerish ? rendered.slice(1) : rendered,
      ...(hiddenRows.length ? { hiddenRows } : {}),
    };
  }

  /* role="list" / display:list-item / ::before bullets — recover the list. */
  function divList(el, ctx) {
    const win = ctx.win;
    const kids = Array.from(el.children).filter((c) => !isIcon(c));
    if (kids.length < 2) return null;
    const role = (el.getAttribute('role') || '').toLowerCase();

    const info = kids.map((c) => {
      const r = (c.getAttribute('role') || '').toLowerCase();
      const cs = win.getComputedStyle(c);
      return { el: c, role: r, display: cs.display, listStyle: cs.listStyleType || '', marker: pseudoMarker(win, c) };
    });
    const byRole = info.filter((i) => i.role === 'listitem').length >= Math.max(2, kids.length * 0.8);
    const byDisplay = info.filter((i) => i.display === 'list-item').length >= Math.max(2, kids.length * 0.8);
    const byMarker = info.filter((i) => i.marker).length >= Math.max(2, kids.length * 0.8);
    const byBulletText = info.filter((i) => /^[•·▪◦‣⁃*-]\s/.test((i.el.textContent || '').trim())).length >= Math.max(2, kids.length * 0.8);
    if (!(role === 'list' || byRole || byDisplay || byMarker || byBulletText)) return null;

    const ordered = info.some((i) => /^(decimal|lower-alpha|upper-alpha|lower-roman|upper-roman)/.test(i.listStyle)) ||
      byBulletText && info.every((i) => /^\d+[.)]\s/.test((i.el.textContent || '').trim())) ||
      info.some((i) => /^\d+[.)]$/.test(i.marker));

    const items = [];
    for (const i of info) {
      const blocks = [];
      if (hasBlockChild(win, i.el)) {
        walkBlocks(i.el, blocks, ctx, { dropBoilerplate: false, includeHidden: 'off' });
      } else {
        let inline = inlineOf(i.el, ctx);
        // the bullet may be literal text inside the item
        const first = inline[0];
        if (first && first.t === 'text') first.v = first.v.replace(/^[•·▪◦‣⁃]\s+/, '');
        if (inline.length) blocks.push({ type: 'para', inline });
      }
      if (blocks.length) items.push({ checked: null, blocks });
    }
    if (items.length < 2) return null;
    return { type: 'list', ordered, start: 1, items };
  }

  /* "Customer: ACME" rows built out of two divs. */
  function labelPair(el, ctx) {
    const win = ctx.win;
    const kids = Array.from(el.children).filter((c) => !isIcon(c));
    if (kids.length !== 2) return null;
    const [a, b] = kids;
    const aText = (a.textContent || '').trim();
    const bText = (b.textContent || '').trim();
    if (!aText || !bText) return null;
    if (aText.length > 48) return null;

    const cs = win.getComputedStyle(a);
    const rowish = /flex|grid/.test(win.getComputedStyle(el).display) ||
      /(row|field|detail|kv|pair|prop|attribute|meta|item)/i.test(
        (typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute('role') || ''));
    if (!rowish) return null;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const cls = (typeof a.className === 'string' ? a.className : '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    const bold = weight >= 600 || !!a.querySelector('b,strong');
    const hinted = LABEL_CLASS_RE.test(cls);
    if (!bold && !hinted) return null;
    // both sides bold = a two-cell header, not a label/value pair
    const valueBold = (parseInt(win.getComputedStyle(b).fontWeight, 10) || 400) >= 600;
    if (bold && valueBold && !hinted) return null;
    if (hasBlockChild(win, a) || hasBlockChild(win, b)) return null;

    const left = inlineOf(a, ctx), right = inlineOf(b, ctx);
    if (!left.length || !right.length) return null;
    const sep = /[:：]$/.test(aText) ? ' ' : ': ';
    return [{ t: 'b', c: plainifyInline(left) }, { t: 'text', v: sep }].concat(right);
  }

  /* One decision per element: does the div soup hide a known shape in here? */
  function inferBlock(el, ctx, opts) {
    if (opts.inferStructure === false) return null;
    const win = ctx.win;

    const table = divTable(el, ctx, opts);
    if (table) return table;

    const list = divList(el, ctx);
    if (list) return list;

    // "label | value" rows are built from two *block* divs, so this has to be
    // tested before the container guard.
    const pair = labelPair(el, ctx);
    if (pair) return { type: 'para', inline: pair };

    if (hasBlockChild(win, el)) return null;                 // a container: recurse

    const inline = inlineOf(el, ctx);
    if (!inline.length) return null;

    const level = headingLevelFor(el, ctx);
    if (level) return { type: 'heading', level, inline: plainifyInline(inline) };

    return { type: 'para', inline };
  }

  function walkBlocks(node, out, ctx, opts) {
    let pending = [];
    const flush = () => {
      const inl = trimInline(pending);
      pending = [];
      if (inl.length) out.push({ type: 'para', inline: inl });
    };
    const push = (b) => { flush(); out.push(b); };

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const v = child.nodeValue;
        if (/\S/.test(v)) pending.push({ t: 'text', v: v.replace(/[\t\r\n ]+/g, ' ') });
        continue;
      }
      if (child.nodeType !== 1) continue;

      const el = child, tag = el.tagName;
      if (DROP_TAGS.has(tag) || isIcon(el)) continue;

      // Invisible but present: capture it, labelled, instead of dropping it.
      if (!ctx.forceVisible && el.isConnected) {
        const reason = hiddenReason(el, ctx.win);
        if (reason) { maybePushHidden(el, reason, push, ctx, opts); continue; }
      }

      if (opts.dropBoilerplate && isBoilerplate(el)) continue;
      if (opts.dropChrome !== false && isInteractiveChrome(el)) continue;
      if (opts.range && !intersects(el, opts.range)) continue;

      if (NAV_MACROS[macroName(el)] || isAnchorToc(el)) continue;

      // Corporate/wiki macros that carry meaning beyond their text.
      const kind = calloutKind(el);
      if (kind) {
        // A panel titled "Table of contents" is navigation wearing a panel.
        const headEl = el.querySelector('.panelHeader, [class*="expand-control"], summary, h1, h2, h3, h4');
        if (headEl && headingIsChrome(headEl.textContent)) continue;
        const inner = [];
        walkBlocks(el, inner, ctx, Object.assign({}, opts, { dropBoilerplate: false }));
        // A panel whose whole body is one code block is a code sample, not a note.
        const codeOnly = inner.length === 1 && inner[0].type === 'code';
        if (codeOnly) push(inner[0]);
        else if (inner.length) push({ type: 'callout', kind, blocks: inner });
        continue;
      }
      if (/expand/i.test(typeof el.className === 'string' ? el.className : '') && !el.closest('details')) {
        const parts = expandParts(el);
        if (parts) {
          const title = parts.control ? inlineOf(parts.control, ctx) : [];
          const inner = [];
          walkBlocks(parts.content, inner, ctx, Object.assign({}, opts, { dropBoilerplate: false }));
          if (inner.length || title.length) {
            push({ type: 'callout', kind: 'EXPAND', title, blocks: inner });
            continue;
          }
        }
      }

      if (!isBlockish(ctx.win, el)) {
        const inl = inlineForElement(el, ctx, false);
        if (inl.length) pending.push(...inl);
        continue;
      }

      switch (tag) {
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
          const inline = plainifyInline(inlineOf(el, ctx));
          const flat = inline.map((n) => n.v || '').join(' ').trim();
          if (inline.length && !headingIsChrome(flat)) push({ type: 'heading', level: Number(tag[1]), inline });
          break;
        }
        case 'P': {
          const inline = inlineOf(el, ctx);
          if (inline.length) push({ type: 'para', inline });
          break;
        }
        case 'HR':
          push({ type: 'hr' });
          break;
        case 'PRE': {
          const c = codeFrom(el, ctx);
          if (c.text.trim()) push({ type: 'code', lang: c.lang, text: c.text });
          break;
        }
        case 'UL': case 'OL': case 'MENU': case 'DIR': {
          const l = listFrom(el, ctx, opts);
          if (l) push(l);
          break;
        }
        case 'DL':
          dlFrom(el, ctx, opts, push);
          break;
        case 'TABLE': {
          const t = tableFrom(el, ctx, opts);
          if (t) push(t);
          break;
        }
        case 'BLOCKQUOTE': {
          const inner = [];
          walkBlocks(el, inner, ctx, Object.assign({}, opts, { dropBoilerplate: false }));
          if (inner.length) push({ type: 'quote', blocks: inner });
          break;
        }
        case 'FIGURE': {
          const inner = [];
          const cap = el.querySelector(':scope > figcaption');
          for (const c of Array.from(el.childNodes)) {
            if (c === cap) continue;
            walkNodes([c], inner, ctx, Object.assign({}, opts, { dropBoilerplate: false }));
          }
          const caption = cap ? inlineOf(cap, ctx) : [];
          if (inner.length || caption.length) push({ type: 'figure', caption, blocks: inner });
          break;
        }
        case 'DETAILS': {
          const sum = el.querySelector(':scope > summary');
          const summary = sum ? inlineOf(sum, ctx) : [];
          const inner = [];
          // Collapsed content is real content: capture it despite being unrendered.
          const prevForce = ctx.forceVisible;
          ctx.forceVisible = true;
          try {
            for (const c of Array.from(el.childNodes)) {
              if (c === sum) continue;
              walkNodes([c], inner, ctx, opts);
            }
          } finally {
            ctx.forceVisible = prevForce;
          }
          if (inner.length) push({ type: 'details', summary, blocks: inner, open: el.hasAttribute('open') });
          break;
        }
        default: {
          // Not a known tag: let the style/ARIA heuristics look for structure
          // first — a flex row of two divs is a label/value pair, not a
          // container of two paragraphs.
          const inferred = inferBlock(el, ctx, opts);
          if (inferred) push(inferred);
          else walkBlocks(el, out, ctx, opts);
        }
      }
    }
    flush();
  }

  function walkNodes(list, out, ctx, opts) {
    walkBlocks({ childNodes: list }, out, ctx, opts);
  }

  // ---------------------------------------------------------------- capture

  function capture(options) {
    const opts = Object.assign(
      { scope: 'content', maxChars: 2_000_000, includeHidden: 'mark' },
      options || {},
    );
    const doc = opts.document || root.document;
    const ctx = makeCtx(doc);
    const pick = pickScope(doc, opts);
    const blocks = [];

    if (pick.kind === 'selection' && pick.range) {
      // Detached copy of the selection: exactly the selected content, no more.
      const holder = doc.createElement('div');
      holder.appendChild(pick.range.cloneContents());
      const selCtx = makeCtx(doc);
      walkBlocks(holder, blocks, selCtx, { dropBoilerplate: false, range: null, includeHidden: opts.includeHidden });
    } else {
      walkBlocks(pick.el, blocks, ctx, {
        dropBoilerplate: pick.kind !== 'page',
        range: pick.range || null,
        includeHidden: opts.includeHidden,
      });
    }

    const q = (sel, attr) => {
      const el = doc.querySelector(sel);
      return el ? (el.getAttribute(attr || 'content') || '') : '';
    };

    const meta = {
      url: doc.location ? doc.location.href : '',
      title: (doc.title || '').trim() || (q('meta[property="og:title"]') || ''),
      siteName: q('meta[property="og:site_name"]') || (doc.location ? doc.location.hostname : ''),
      byline: q('meta[name="author"]') || q('meta[property="article:author"]'),
      description: q('meta[name="description"]') || q('meta[property="og:description"]'),
      lang: doc.documentElement ? doc.documentElement.lang || '' : '',
      capturedAt: new Date().toISOString(),
      scope: pick.kind,
      selector: pick.selector || '',
    };

    return { meta, blocks };
  }

  // ------------------------------------------------------------- renderers

  /* ---------------------------------------------------------- render modes
   * full  : keeps every link target, image source and inline HTML tag.
   * lean  : what an LLM needs to read the data, and nothing that only a
   *         browser needs — no asset URLs, no inline markup, no control labels.
   * --------------------------------------------------------------------- */
  const MD_MODES = {
    full: { links: 'full', images: 'full', tags: 'html', details: 'keep', hr: true, hidden: 'quote' },
    lean: { links: 'text', images: 'alt', tags: 'flat', details: 'flatten', hr: false, hidden: 'plain', dedupe: true },
  };
  let MODE = MD_MODES.full;
  function withMode(name, fn) {
    const prev = MODE;
    MODE = Object.assign({}, MD_MODES[name] || MODE, { seen: new Set() });
    try { return fn(); } finally { MODE = prev; }
  }

  /* Apps repeat themselves: the same tooltip, the same hint, the same status
   * sentence in three panels. In lean mode identical paragraphs collapse. */
  function dedupePara(text) {
    if (!MODE.dedupe || text.length < 24) return text;
    const key = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (MODE.seen.has(key)) return '';
    MODE.seen.add(key);
    return text;
  }

  const GENERIC_LINK_TEXT = /^(here|link|this|that|click here|click|more|read more|see more|learn more|details|open|view|download|source|docs?|url|website|page)$/i;
  const GENERIC_ALT = /^(image|img|icon|logo|photo|picture|thumbnail|thumb|avatar|diagram|screenshot|figure|banner|spacer|untitled)$/i;
  const DATA_FILE_RE = /\.(pdf|zip|rar|csv|xlsx?|docx?|pptx?|txt|md|json|xml|log|png|jpe?g|gif|svg|webp|mp4|mov)$/i;

  /* In lean mode a link survives as its text; the target is kept only when it
   * carries information the text does not (a file, a generic "here"). */
  function leanLink(label, href, title) {
    const text = (label || '').replace(/\*\*/g, '').trim();
    if (!text) return '';
    const cleaned = cleanUrl(href);
    // judge the file type on the path, not the (possibly parameterised) URL
    let pathname = cleaned;
    try { pathname = new URL(cleaned).pathname; } catch (e) { /* keep as-is */ }
    if (DATA_FILE_RE.test(pathname) || GENERIC_LINK_TEXT.test(text)) {
      return text + ' <' + cleaned + '>';
    }
    if (title && text.length < 10) return text;
    return text;
  }

  function escapeMd(text) {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/(^|\n)(#{1,6} )/g, '$1\\$2')
      .replace(/(^|\n)([-+>] )/g, '$1\\$2')
      .replace(/(^|\n)(\d+)([.)] )/g, '$1$2\\$3')
      .replace(/(^|\s)([*_])(?=[^\s*_])/g, '$1\\$2');
  }

  function mdCodeSpan(s) {
    const ticks = /`+/.exec(s);
    const fence = ticks ? '`'.repeat(ticks[0].length + 1) : '`';
    const padStr = /^`|`$/.test(s) ? ' ' : '';
    return fence + padStr + s + padStr + fence;
  }

  function plainOf(nodes) {
    let s = '';
    for (const n of nodes || []) {
      if (n.t === 'text') s += n.v;
      else if (n.t === 'br') s += ' ';
      else if (n.t === 'img') s += n.alt ? n.alt : '';
      else s += plainOf(n.c);
    }
    return s;
  }

  function mdInline(nodes) {
    let s = '';
    for (const n of nodes) {
      switch (n.t) {
        case 'text': s += escapeMd(n.v); break;
        case 'br': s += MODE.tags === 'flat' ? '\n' : '  \n'; break;
        case 'b': s += '**' + mdInline(n.c) + '**'; break;
        case 'i': s += '*' + mdInline(n.c) + '*'; break;
        case 'code': s += mdCodeSpan(mdInline(n.c)); break;
        case 'del': s += MODE.tags === 'flat' ? mdInline(n.c) : '~~' + mdInline(n.c) + '~~'; break;
        case 'mark': s += MODE.tags === 'flat' ? mdInline(n.c) : '==' + mdInline(n.c) + '=='; break;
        case 'u': case 'ins':
          s += MODE.tags === 'flat' ? mdInline(n.c) : '<' + (n.t === 'u' ? 'u' : 'ins') + '>' + mdInline(n.c) + '</' + (n.t === 'u' ? 'u' : 'ins') + '>';
          break;
        case 'sub': s += MODE.tags === 'flat' ? mdInline(n.c) : '<sub>' + mdInline(n.c) + '</sub>'; break;
        case 'sup': s += MODE.tags === 'flat' ? mdInline(n.c) : '<sup>' + mdInline(n.c) + '</sup>'; break;
        case 'a': {
          const label = mdInline(n.c) || '';
          if (MODE.links === 'text') { s += leanLink(label, n.href, n.title); break; }
          const title = n.title ? ` "${n.title.replace(/"/g, '\\"')}"` : '';
          const href = cleanUrl(n.href).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
          s += `[${label || escapeMd(cleanUrl(n.href))}](${href}${title})`;
          break;
        }
        case 'img': {
          const alt = (n.alt || '').trim();
          if (MODE.images === 'full') {
            const title = n.title ? ` "${n.title.replace(/"/g, '\\"')}"` : '';
            s += `![${escapeMd(alt)}](${cleanUrl(n.src)}${title})`;
            break;
          }
          if (MODE.images === 'alt' && alt && !GENERIC_ALT.test(alt)) s += escapeMd(alt);
          break;
        }
        default: s += n.c ? mdInline(n.c) : '';
      }
    }
    return s;
  }

  function mdBlocks(blocks, tight) {
    const parts = [];
    for (const b of blocks) {
      const s = mdBlock(b);
      if (s) parts.push(s);
    }
    return parts.join(tight ? '\n' : '\n\n');
  }

  function mdBlock(b) {
    switch (b.type) {
      case 'heading':
        return '#'.repeat(Math.min(6, Math.max(1, b.level))) + ' ' + mdInline(b.inline);
      case 'para':
        return dedupePara(mdInline(b.inline));
      case 'hr':
        return MODE.hr ? '---' : '';
      case 'code': {
        const ticks = /`{3,}/.exec(b.text);
        const fence = ticks ? '`'.repeat(ticks[0].length + 1) : '```';
        return fence + (b.lang || '') + '\n' + b.text + '\n' + fence;
      }
      case 'quote': {
        const inner = mdBlocks(b.blocks, false);
        return inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
      }
      case 'list': {
        return b.items.map((item, i) => {
          const marker = b.ordered
            ? `${(b.start || 1) + i}. `
            : (item.checked === true ? '- [x] ' : item.checked === false ? '- [ ] ' : '- ');
          const body = mdBlocks(item.blocks, true);
          const lines = body.split('\n');
          const cont = ' '.repeat(marker.length);
          return lines.map((l, idx) => (idx === 0 ? marker + l : l ? cont + l : '')).join('\n');
        }).join('\n');
      }
      case 'table': {
        const cell = (c) => (mdInline(c) || ' ').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const width = Math.max(1, ...b.head.map((r) => r.length), ...b.rows.map((r) => r.length));
        const row = (r) => '| ' + Array.from({ length: width }, (_, i) => cell(r[i] || [])).join(' | ') + ' |';
        const sep = '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |';
        if (!b.head.length && !b.rows.length) return '';
        const lines = [row(b.head.length ? b.head[0] : Array.from({ length: width }, () => []))];
        lines.push(sep);
        const bodyRows = b.head.length ? b.rows : b.rows.slice(1);
        for (const r of bodyRows) lines.push(row(r));
        return lines.join('\n');
      }
      case 'figure': {
        const out = mdBlocks(b.blocks, false);
        const cap = b.caption.length ? '*' + mdInline(b.caption) + '*' : '';
        return [out, cap].filter(Boolean).join('\n\n');
      }
      case 'hidden': {
        const tagLine = '[hidden: ' + b.reason + ']' + (b.label ? ' ' + b.label : '');
        const inner = mdBlocks(b.blocks, false);
        if (MODE.hidden === 'plain') return tagLine + '\n\n' + inner;
        return tagLine.split('\n').concat(inner.split('\n')).map((l) => (l ? '> ' + l : '>')).join('\n');
      }
      case 'callout': {
        const label = b.title && b.title.length ? mdInline(b.title) : null;
        if (b.kind === 'EXPAND') {
          const head = label || 'Expand';
          if (MODE.details === 'flatten') return '**' + head + '**\n\n' + mdBlocks(b.blocks, false);
          return '<details><summary>' + head + '</summary>\n\n' + mdBlocks(b.blocks, false) + '\n\n</details>';
        }
        const inner = mdBlocks(b.blocks, false);
        const first = label ? ['**' + label + '**', ''] : [];
        const body = (first.join('\n') + inner).split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
        return '> [!' + b.kind + ']\n' + body;
      }
      case 'details': {
        const sum = b.summary.length ? mdInline(b.summary) : 'Details';
        const inner = mdBlocks(b.blocks, false);
        if (MODE.details === 'flatten') return '**' + sum + '**\n\n' + inner;
        return `<details${b.open ? ' open' : ''}><summary>${sum}</summary>\n\n${inner}\n\n</details>`;
      }
      default:
        return b.blocks ? mdBlocks(b.blocks, false) : '';
    }
  }

  function toMarkdown(doc, opts) {
    const o = opts || {};
    const profile = o.profile || 'llm';         // 'lean' | 'llm' | 'document'
    const m = doc.meta;
    const render = () => mdBlocks(doc.blocks, false).trim();
    const body = profile === 'lean' ? withMode('lean', render) : render();

    if (profile === 'document') {
      return [
        '---',
        `title: ${JSON.stringify(m.title || '')}`,
        `url: ${m.url}`,
        ...(m.byline ? [`author: ${JSON.stringify(m.byline)}`] : []),
        ...(m.siteName ? [`source: ${JSON.stringify(m.siteName)}`] : []),
        `captured: ${m.capturedAt}`,
        '---',
        '',
      ].join('\n') + '\n' + body + '\n';
    }

    const out = [];
    if (m.title) out.push('# ' + m.title.replace(/\s+/g, ' ').trim(), '');
    out.push(`Source: ${m.url}`);
    if (m.byline && profile !== 'lean') out.push(`Author: ${m.byline}`);
    out.push('', '');
    return out.join('\n') + body + '\n';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function htmlInline(nodes) {
    let s = '';
    for (const n of nodes) {
      switch (n.t) {
        case 'text': s += esc(n.v); break;
        case 'br': s += '<br>'; break;
        case 'b': s += '<strong>' + htmlInline(n.c) + '</strong>'; break;
        case 'i': s += '<em>' + htmlInline(n.c) + '</em>'; break;
        case 'del': s += '<del>' + htmlInline(n.c) + '</del>'; break;
        case 'mark': s += '<mark>' + htmlInline(n.c) + '</mark>'; break;
        case 'u': s += '<u>' + htmlInline(n.c) + '</u>'; break;
        case 'ins': s += '<ins>' + htmlInline(n.c) + '</ins>'; break;
        case 'sub': s += '<sub>' + htmlInline(n.c) + '</sub>'; break;
        case 'sup': s += '<sup>' + htmlInline(n.c) + '</sup>'; break;
        case 'code': s += '<code>' + htmlInline(n.c) + '</code>'; break;
        case 'a': s += `<a href="${esc(n.href)}"${n.title ? ` title="${esc(n.title)}"` : ''}>${htmlInline(n.c)}</a>`; break;
        case 'img': s += `<img src="${esc(n.src)}" alt="${esc(n.alt || '')}"${n.title ? ` title="${esc(n.title)}"` : ''}>`; break;
        default: s += n.c ? htmlInline(n.c) : '';
      }
    }
    return s;
  }

  function htmlBlocks(blocks) {
    return blocks.map(htmlBlock).filter(Boolean).join('\n');
  }

  function htmlBlock(b) {
    switch (b.type) {
      case 'heading': return `<h${b.level}>${htmlInline(b.inline)}</h${b.level}>`;
      case 'para': return `<p>${htmlInline(b.inline)}</p>`;
      case 'hr': return '<hr>';
      case 'code': return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ''}>${esc(b.text)}</code></pre>`;
      case 'quote': return `<blockquote>\n${htmlBlocks(b.blocks)}\n</blockquote>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        const items = b.items.map((i) => `<li>${htmlBlocks(i.blocks)}</li>`).join('\n');
        return `<${tag}${start}>\n${items}\n</${tag}>`;
      }
      case 'table': {
        const head = b.head.length
          ? `<thead>${b.head.map((r) => `<tr>${r.map((c) => `<th>${htmlInline(c)}</th>`).join('')}</tr>`).join('')}</thead>` : '';
        const body = b.rows.length
          ? `<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${htmlInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>` : '';
        return `<table>${head}${body}</table>`;
      }
      case 'figure': {
        const cap = b.caption.length ? `<figcaption>${htmlInline(b.caption)}</figcaption>` : '';
        return `<figure>${htmlBlocks(b.blocks)}${cap}</figure>`;
      }
      case 'hidden':
        return `<section class="hidden-region" data-hidden="${esc(b.reason)}"${b.label ? ` data-label="${esc(b.label)}"` : ''}>\n${htmlBlocks(b.blocks)}\n</section>`;
      case 'callout': {
        const label = b.title && b.title.length ? `<p><strong>${htmlInline(b.title)}</strong></p>` : '';
        return `<aside class="callout callout-${esc(String(b.kind).toLowerCase())}">\n${label}${htmlBlocks(b.blocks)}\n</aside>`;
      }
      case 'details': {
        const sum = `<summary>${b.summary.length ? htmlInline(b.summary) : 'Details'}</summary>`;
        return `<details${b.open ? ' open' : ''}>${sum}\n${htmlBlocks(b.blocks)}\n</details>`;
      }
      default: return b.blocks ? htmlBlocks(b.blocks) : '';
    }
  }

  function toHtml(doc) {
    const m = doc.meta;
    return `<!doctype html>
<html${m.lang ? ` lang="${esc(m.lang)}"` : ''}>
<head>
<meta charset="utf-8">
<title>${esc(m.title || '')}</title>
<meta name="source-url" content="${esc(m.url)}">
<meta name="captured-at" content="${esc(m.capturedAt)}">
</head>
<body>
<article>
${htmlBlocks(doc.blocks)}
</article>
</body>
</html>
`;
  }

  function plainInline(nodes) {
    let s = '';
    for (const n of nodes) {
      if (n.t === 'text') s += n.v;
      else if (n.t === 'br') s += '\n';
      else if (n.t === 'img') s += n.alt ? `[${n.alt}]` : '';
      else s += plainInline(n.c || []);
    }
    return s;
  }

  function toPlain(doc) {
    const out = [];
    const walk = (blocks, prefix) => {
      for (const b of blocks) {
        switch (b.type) {
          case 'heading': case 'para': out.push(prefix + plainInline(b.inline)); break;
          case 'code': out.push(prefix + b.text.split('\n').join('\n' + prefix)); break;
          case 'hr': out.push(prefix + '-----'); break;
          case 'quote': walk(b.blocks, prefix + '> '); break;
          case 'list':
            b.items.forEach((item, i) => {
              const mk = b.ordered ? `${(b.start || 1) + i}. ` : '- ';
              const first = item.blocks[0];
              const cont = prefix + ' '.repeat(mk.length);
              if (first && first.type === 'para') {
                out.push('');
                const txt = plainInline(first.inline);
                const lines = txt.split('\n');
                out.push([prefix + mk + lines[0]].concat(lines.slice(1).map((l) => cont + l)).join('\n') );
                walk(item.blocks.slice(1), cont);
              } else walk(item.blocks, cont);
            });
            break;
          case 'table': {
            const rowOf = (r) => r.map((c) => plainInline(c)).join('  |  ');
            if (b.head.length) out.push(prefix + rowOf(b.head[0]));
            b.rows.forEach((r) => out.push(prefix + rowOf(r)));
            break;
          }
          case 'figure':
            walk(b.blocks, prefix);
            if (b.caption.length) out.push(prefix + plainInline(b.caption));
            break;
          case 'hidden':
            out.push(prefix + '[hidden: ' + b.reason + ']' + (b.label ? ' ' + b.label : ''));
            walk(b.blocks, prefix + '  ');
            break;
          case 'callout':
            if (b.title && b.title.length) out.push(prefix + plainInline(b.title));
            walk(b.blocks, prefix);
            break;
          case 'details':
            out.push(prefix + plainInline(b.summary));
            walk(b.blocks, prefix + '  ');
            break;
          default: if (b.blocks) walk(b.blocks, prefix);
        }
      }
    };
    walk(doc.blocks, '');
    return out.filter((s, i, a) => s !== '' || a[i - 1] !== '').join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  /* ---------------------------------------------------------------------
   * Styled HTML: clean semantic HTML with the *computed* CSS inlined, so the
   * formatting survives a paste into Word / Docs / Notion / e-mail.
   * Works by temporarily inlining on the live DOM, serialising, then restoring.
   * ------------------------------------------------------------------- */
  const STYLE_PROPS = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'line-height', 'color', 'background-color', 'text-align', 'text-decoration-line',
    'text-transform', 'letter-spacing', 'white-space', 'list-style-type', 'vertical-align',
    'border-top', 'border-right', 'border-bottom', 'border-left', 'border-collapse',
    'border-spacing', 'border-radius', 'padding', 'margin', 'display', 'width',
  ];

  function styledHtml(el) {
    if (!el) return '';
    const win = el.ownerDocument.defaultView;
    const targets = [el].concat(Array.from(el.querySelectorAll('*')));
    const saved = [];
    try {
      for (const node of targets) {
        const tag = node.tagName;
        if (DROP_TAGS.has(tag)) continue;
        if (isHidden(node, win)) { saved.push([node, node.getAttribute('style'), true]); continue; }
        const cs = win.getComputedStyle(node);
        const decl = [];
        for (const p of STYLE_PROPS) {
          const v = cs.getPropertyValue(p);
          if (!v) continue;
          // drop the noisy defaults
          if (p === 'display' && (v === 'block' || v === 'inline')) continue;
          if (p === 'margin' && /^(0px)( 0px){0,3}$/.test(v)) continue;
          if (p === 'padding' && /^(0px)( 0px){0,3}$/.test(v)) continue;
          if (p === 'background-color' && /rgba\(0, 0, 0, 0\)|transparent/.test(v)) continue;
          if (p === 'width' && tag !== 'IMG' && tag !== 'TABLE') continue;
          decl.push(`${p}: ${v}`);
        }
        saved.push([node, node.getAttribute('style'), false]);
        node.setAttribute('style', decl.join('; '));
      }
      return el.outerHTML;
    } finally {
      for (const [node, style, hide] of saved) {
        if (hide) node.setAttribute('style', 'display: none !important');
        else if (style === null) node.removeAttribute('style');
        else node.setAttribute('style', style);
      }
    }
  }

  /* ---------------------------------------------------------------------
   * Structure report: what does the extractor believe about this page, and
   * where are the assumptions wrong? Designed to be pasted to the person who
   * can fix the extraction rules — it is the debug view for pages whose markup
   * nobody can see.
   * ------------------------------------------------------------------- */
  function cssPath(el, depth) {
    const parts = [];
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d < (depth || 4)) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += '#' + n.id; parts.unshift(s); break; }
      const cls = typeof n.className === 'string'
        ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      if (cls) s += '.' + cls;
      const siblings = n.parentElement ? Array.from(n.parentElement.children).filter((x) => x.tagName === n.tagName) : [];
      if (siblings.length > 1) s += `:nth-of-type(${siblings.indexOf(n) + 1})`;
      parts.unshift(s);
      n = n.parentElement; d++;
    }
    return parts.join(' > ');
  }

  const preview = (text, n) => {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  function report(options) {
    const opts = Object.assign({ document: root.document, scope: 'content', includeHidden: 'mark' }, options || {});
    const doc = opts.document;
    const win = doc.defaultView;
    const L = [];
    const push = (...xs) => L.push(...xs);

    push('# Page capture report', '');
    push('- URL: ' + (doc.location ? doc.location.href : ''));
    push('- Title: ' + preview(doc.title, 120));
    push('- Viewport: ' + win.innerWidth + '×' + win.innerHeight + ' · dpr ' + (win.devicePixelRatio || 1));
    push('- Document height: ' + Math.round(doc.documentElement.scrollHeight) + 'px');
    push('');

    // ---- scope ------------------------------------------------------------
    const scored = [];
    for (const el of doc.body.querySelectorAll('*')) {
      if (!CANDIDATE_TAGS.has(el.tagName) || !el.isConnected) continue;
      const sc = scoreCandidate(el);
      if (sc === -Infinity) continue;
      scored.push({ el, score: Math.round(sc) });
    }
    scored.sort((a, b) => b.score - a.score);
    const pick = pickScope(doc, opts);
    push('## 1. Scope decision', '');
    push('Chosen: `' + (pick.selector || 'body') + '` (kind: ' + pick.kind + ')', '');
    push('| # | candidate | score | text | link density | hidden |');
    push('| --- | --- | --- | --- | --- | --- |');
    scored.slice(0, 8).forEach((c, i) => {
      push(`| ${i + 1} | \`${describe(c.el)}\` | ${c.score} | ${Math.round((c.el.textContent || '').length / 1000)}k | ${linkDensity(c.el).toFixed(2)} | ${hiddenReason(c.el, win) || '—'} |`);
    });
    push('');

    // ---- census + hidden -------------------------------------------------
    const byTag = new Map();
    const byDisplay = new Map();
    const hidden = [];
    const hostile = [];
    let total = 0, divs = 0, divOnly = 0, shadowHosts = 0, iframes = 0, canvases = 0;
    const longLeaves = [];

    for (const el of doc.body.querySelectorAll('*')) {
      total++;
      byTag.set(el.tagName, (byTag.get(el.tagName) || 0) + 1);
      if (el.tagName === 'DIV') divs++;
      if (el.shadowRoot) shadowHosts++;
      if (el.tagName === 'IFRAME') iframes++;
      if (el.tagName === 'CANVAS') canvases++;

      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { continue; }
      if (!cs) continue;
      const disp = cs.display || '';
      byDisplay.set(disp, (byDisplay.get(disp) || 0) + 1);
      if (cs.userSelect === 'none' || cs.webkitUserSelect === 'none') hostile.push(el);

      if (el.children.length && Array.from(el.children).every((c) => c.tagName === 'DIV')) divOnly++;

      const reason = hiddenReason(el, win);
      if (reason) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 12) hidden.push({ el, reason, text });
      } else if (!hasBlockChild(win, el) && el.children.length === 0) {
        const text = (el.textContent || '').trim();
        if (text.length > 300) longLeaves.push({ el, text });
      }
    }

    push('## 2. DOM census', '');
    push('- Elements: **' + total + '** · `<div>`: **' + divs + '** (' + Math.round((divs / Math.max(1, total)) * 100) + '%)');
    push('- Elements whose children are all `<div>`: ' + divOnly + ' (a sign the layout, not the content, is doing the structuring)');
    const topTags = Array.from(byTag).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(', ');
    push('- Tags: ' + topTags);
    const topDisp = Array.from(byDisplay).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k || '?'} ${v}`).join(', ');
    push('- Display: ' + topDisp);
    push('');

    push('## 3. Hidden content (' + hidden.length + ' regions)', '');
    push('Data that exists in the DOM but is not on screen. `includeHidden: mark` (the default) captures these and labels them; `off` drops them; `all` also takes `aria-hidden`.', '');
    const byReason = new Map();
    for (const h of hidden) byReason.set(h.reason, (byReason.get(h.reason) || 0) + 1);
    push('By reason: ' + (Array.from(byReason).map(([k, v]) => `${k} ×${v}`).join(', ') || '—'), '');
    if (hidden.length) {
      push('| reason | label | text | where |');
      push('| --- | --- | --- | --- |');
      for (const h of hidden.slice(0, 25)) {
        const label = h.el.getAttribute('aria-label') || h.el.getAttribute('data-label') ||
          h.el.getAttribute('data-testid') || h.el.getAttribute('title') || classHint(h.el) || '';
        push(`| ${h.reason} | ${label || '—'} | ${preview(h.text, 90)} | \`${cssPath(h.el, 3)}\` |`);
      }
      if (hidden.length > 25) push('', '_(' + (hidden.length - 25) + ' more not shown)_');
    }
    push('');

    // ---- what the heuristics inferred ------------------------------------
    const doc2 = capture({ scope: opts.scope, includeHidden: opts.includeHidden, document: doc });
    const counts = {};
    const walk = (blocks) => blocks.forEach((b) => {
      counts[b.type] = (counts[b.type] || 0) + 1;
      if (b.blocks) walk(b.blocks);
      if (b.items) b.items.forEach((i) => walk(i.blocks));
    });
    walk(doc2.blocks);
    const pairs = doc2.blocks.filter((b) => b.type === 'para' && b.inline[0] && b.inline[0].t === 'b' &&
      b.inline[1] && b.inline[1].t === 'text' && /^:?\s*$/.test(b.inline[1].v)).length;

    push('## 4. Structure recovered from the markup', '');
    push(Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(' · '), '');
    push('- label/value pairs detected: ' + pairs + ' (two-child rows where the first is bold or label-ish)');
    push('- headings detected: ' + (counts.heading || 0) + ' (h1–h6 tags, `role=heading`, font-size ratio, or a title-ish class that is bold)');
    const hiddenRowTotal = (function walkHidden(blocks) {
      let n = 0;
      for (const b of blocks) {
        if (b.type === 'table' && b.hiddenRows) n += b.hiddenRows.length;
        if (b.blocks) n += walkHidden(b.blocks);
        if (b.items) b.items.forEach((i) => { n += walkHidden(i.blocks); });
      }
      return n;
    })(doc2.blocks);
    push('- tables detected: ' + (counts.table || 0) + ' (`role=table/grid`, `display:table`, or `<table>`)' +
      (hiddenRowTotal ? `, of which **${hiddenRowTotal} row(s) came from hidden or collapsed areas** and were included` : ''));
    push('- lists detected: ' + (counts.list || 0) + ' (`role=list`, `display:list-item`, a `::before` bullet, or literal bullet text)');
    push('');

    // ---- suspects --------------------------------------------------------
    push('## 5. Suspects — where the heuristics probably got it wrong', '');
    if (longLeaves.length) {
      push('**Long text inside a div with no block children** — captured as one paragraph. If these are really lists or tables, the pattern needs a rule:', '');
      for (const x of longLeaves.slice(0, 5)) push(`- \`${cssPath(x.el, 3)}\` (${x.text.length} chars): ${preview(x.text, 120)}`);
      push('');
    }
    const oneColTables = (doc2.blocks || []).filter((b) => b.type === 'table' && (!b.rows.length || b.rows[0].length < 2));
    if (oneColTables.length) push('- ' + oneColTables.length + ' table(s) with a single column — usually a list in disguise', '');
    if (hostile.length) push('- **' + hostile.length + ' elements with `user-select: none`** (why Ctrl+A/C misses them): e.g. `' + cssPath(hostile[0], 3) + '`', '');
    if (iframes) push('- **' + iframes + ' iframe(s)** — their content is not captured at all', '');
    if (canvases) push('- **' + canvases + ' canvas element(s)** — pixels, not text', '');
    if (shadowHosts) push('- **' + shadowHosts + ' open shadow root(s)** — not walked by this version', '');
    if (!longLeaves.length && !hostile.length && !iframes && !canvases && !shadowHosts) push('Nothing obvious.', '');
    push('');

    // ---- result ----------------------------------------------------------
    const md = toMarkdown(doc2, { profile: 'llm' });
    push('## 6. Capture result', '');
    push('- Scope: `' + (doc2.meta.selector || doc2.meta.scope) + '`');
    push('- Blocks: ' + doc2.blocks.length + ' · characters: ' + md.length.toLocaleString() + ' · ~tokens: ' + Math.round(md.length / 3.8).toLocaleString());
    push('');
    push('```text');
    push(md.slice(0, 600));
    push('```');

    return L.join('\n') + '\n';
  }

  root.PageCapture = { capture, toMarkdown, toHtml, toPlain, styledHtml, report, version: 1 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
