/* Content script: owns capture, clipboard, download and the toast.
 * Everything that needs the page's DOM happens here; the background script only
 * routes messages and injects this file into tabs that predate the install. */
(() => {
  if (globalThis.__pageCaptureLoaded) return;
  globalThis.__pageCaptureLoaded = true;

  const DEFAULTS = { format: 'md-lean', scope: 'content', includeHidden: 'mark' };

  async function settings() {
    try {
      const s = await chrome.storage.sync.get(DEFAULTS);
      return Object.assign({}, DEFAULTS, s);
    } catch (e) {
      return DEFAULTS;
    }
  }

  /* ------------------------------------------------------------ rendering */
  function render(doc, format, opts) {
    switch (format) {
      case 'md-doc':
        return { kind: 'md', text: PageCapture.toMarkdown(doc, { profile: 'document' }), mime: 'text/markdown' };
      case 'md-llm':
        return { kind: 'md', text: PageCapture.toMarkdown(doc, { profile: 'llm' }), mime: 'text/markdown' };
      case 'md-lean':
        return { kind: 'md', text: PageCapture.toMarkdown(doc, { profile: 'lean' }), mime: 'text/markdown' };
      case 'json':
        return { kind: 'json', text: JSON.stringify(doc, null, 2), mime: 'application/json' };
      case 'text':
        return { kind: 'txt', text: PageCapture.toPlain(doc), mime: 'text/plain' };
      case 'html':
        return { kind: 'html', text: PageCapture.toHtml(doc), mime: 'text/html' };
      case 'report':
        return {
          kind: 'md',
          text: PageCapture.report({ scope: opts.scope, includeHidden: opts.includeHidden }),
          mime: 'text/markdown',
        };
      case 'styled': {
        const scope = selectScopeEl(doc, opts);
        return { kind: 'html', text: wrapStyled(PageCapture.styledHtml(scope)), mime: 'text/html' };
      }
      default:
        return { kind: 'md', text: PageCapture.toMarkdown(doc, { profile: 'lean' }), mime: 'text/markdown' };
    }
  }

  function selectScopeEl(doc, opts) {
    if (doc.meta.selector && doc.meta.scope === 'main') {
      const el = document.querySelector(doc.meta.selector);
      if (el) return el;
    }
    return document.querySelector('main, article, [role="main"]') || document.body;
  }

  function wrapStyled(html) {
    return '<!doctype html><meta charset="utf-8">' +
      '<body style="max-width:46rem;margin:2rem auto;padding:0 1rem;font:16px/1.55 system-ui,sans-serif">' +
      html + '</body>';
  }

  function runCapture(opts) {
    const doc = PageCapture.capture({
      scope: opts.scope,
      includeHidden: opts.includeHidden || 'mark',
    });
    const out = render(doc, opts.format, opts);
    return {
      ...out,
      html: out.kind === 'html' ? out.text : undefined,
      meta: doc.meta,
      diagnostics: doc.diagnostics ? doc.diagnostics : null,
      chars: out.text.length,
      tokens: Math.round(out.text.length / 3.8),
      blocks: doc.blocks.length,
      truncated: !!doc.truncated,
    };
  }

  /* ------------------------------------------------------------ clipboard */
  async function copyToClipboard({ text, html, mime }) {
    // 1. Rich clipboard: gives Word/Docs/Notion the formatted version and
    //    everything else the plain text, in one gesture.
    if (html && navigator.clipboard && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
        return 'multi';
      } catch (e) { /* fall through */ }
    }
    if (!html && navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return 'text'; } catch (e) { /* fall through */ }
    }
    // 2. execCommand fallback (works without a user gesture when the extension
    //    holds clipboardWrite, and keeps the HTML flavour when we have one).
    const holder = document.createElement('div');
    holder.setAttribute('style', 'position:fixed;left:-100000px;top:0;white-space:pre-wrap');
    if (html) { holder.contentEditable = 'true'; holder.innerHTML = html; }
    else holder.textContent = text;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    holder.remove();
    if (!ok) throw new Error('Clipboard write blocked by the browser');
    return 'exec';
  }

  /* -------------------------------------------------------------- download */
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }

  function slug(s) {
    return (s || 'page').trim().slice(0, 80)
      .replace(/[^\w\s.-]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '') || 'page';
  }

  /* ----------------------------------------------------------------- toast */
  let toastEl = null, toastTimer = null;
  function toast(message, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('style', [
        'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px',
        'max-width:min(420px,80vw)', 'padding:10px 14px', 'border-radius:10px',
        'font:13px/1.45 system-ui,-apple-system,sans-serif', 'color:#fff',
        'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'pointer-events:none',
        'transition:opacity .18s ease', 'opacity:0',
      ].join(';'));
      document.documentElement.appendChild(toastEl);
    }
    toastEl.style.background = isError ? '#7f1d1d' : '#111827';
    toastEl.textContent = message;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, isError ? 5000 : 2200);
  }

  /* ------------------------------------------------------------- messages */
  async function handle(msg) {
    const opts = Object.assign({}, await settings(), msg.opts || {});
    if (msg.type === 'capture') return runCapture(opts);

    if (msg.type === 'copy') {
      const r = runCapture(opts);
      await copyToClipboard({ text: r.text, html: r.html });
      const warn = r.diagnostics && !r.diagnostics.complete
        ? ` ⚠ ${r.diagnostics.warnings.length} warning${r.diagnostics.warnings.length === 1 ? '' : 's'}`
        : '';
      toast(`Copied ${r.kind.toUpperCase()} · ${r.chars.toLocaleString()} chars (~${r.tokens.toLocaleString()} tokens)${warn}`);
      return { ok: true, chars: r.chars, kind: r.kind };
    }

    if (msg.type === 'download') {
      const r = runCapture(opts);
      const ext = r.kind === 'md' ? 'md' : r.kind === 'json' ? 'json' : r.kind === 'html' ? 'html' : 'txt';
      download(`${slug(document.title)}-${new Date().toISOString().slice(0, 10)}.${ext}`, r.text, r.mime);
      toast(`Saved .${ext} · ${r.chars.toLocaleString()} chars`);
      return { ok: true };
    }

    if (msg.type === 'ping') return { ok: true, href: location.href };
    return { ok: false, error: 'unknown message ' + msg.type };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;   // async response
  });
})();
