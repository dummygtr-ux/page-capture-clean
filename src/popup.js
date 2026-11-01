/* Popup: preview, format/scope switches, copy, save. */
const DEFAULTS = { format: 'md-lean', scope: 'content', includeHidden: 'mark' };
const PREVIEW_LIMIT = 200_000;

const $ = (id) => document.getElementById(id);
let tabId = null;
let last = null;

async function settings() {
  try { return Object.assign({}, DEFAULTS, await chrome.storage.sync.get(DEFAULTS)); }
  catch (e) { return { ...DEFAULTS }; }
}

async function save(partial) {
  try { await chrome.storage.sync.set(partial); } catch (e) { /* ignore */ }
}

async function bg(type, opts) {
  try {
    return await chrome.runtime.sendMessage({ type: 'bg:' + type, opts, tabId });
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text || '';
  el.style.color = isError ? '#dc2626' : '';
}

function showPreview(res) {
  const ta = $('preview');
  const text = res.text || '';
  ta.value = text.length > PREVIEW_LIMIT
    ? text.slice(0, PREVIEW_LIMIT) + '\n\n… preview truncated (copy still gets everything)'
    : text;
  ta.scrollTop = 0;

  $('stats').textContent =
    `${res.kind.toUpperCase()} · ${res.chars.toLocaleString()} chars · ~${res.tokens.toLocaleString()} tokens · ${res.blocks} blocks`;
  const note = $('scope-note');
  if (res.meta && res.meta.scope) {
    note.classList.remove('hidden');
    note.textContent = res.meta.scope === 'main'
      ? 'scope: ' + (res.meta.selector || 'main content')
      : res.meta.scope === 'selection' ? 'scope: selection' : 'scope: whole page';
  }
}

function optsNow() {
  return { format: $('format').value, scope: $('scope').value, includeHidden: $('include-hidden').value };
}

async function refresh() {
  setStatus('');
  $('stats').textContent = 'capturing…';
  const opts = { format: $('format').value, scope: $('scope').value, includeHidden: $('include-hidden').value };
  const res = await bg('capture', opts);
  if (!res || res.ok === false) {
    $('stats').textContent = 'capture failed';
    $('preview').value = '';
    setStatus(res && res.error ? res.error : 'Could not read this page', true);
    $('copy').disabled = true;
    $('download').disabled = true;
    return;
  }
  last = res;
  $('copy').disabled = false;
  $('download').disabled = false;
  showPreview(res);
}

async function copyRich(res) {
  const parts = { 'text/plain': new Blob([res.text], { type: 'text/plain' }) };
  if (res.html) parts['text/html'] = new Blob([res.html], { type: 'text/html' });
  if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem(parts)]);
    return 'multi';
  }
  await navigator.clipboard.writeText(res.text);
  return 'text';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  try {
    const url = new URL(tab.url);
    $('page-domain').textContent = url.hostname + url.pathname.slice(0, 60);
  } catch (e) {
    $('page-domain').textContent = tab && tab.title ? tab.title : '';
  }

  const s = await settings();
  $('format').value = s.format;
  $('scope').value = s.scope;
  $('include-hidden').value = s.includeHidden;

  $('format').addEventListener('change', async () => {
    await save({ format: $('format').value });
    refresh();
  });
  $('scope').addEventListener('change', async () => {
    await save({ scope: $('scope').value });
    refresh();
  });
  $('include-hidden').addEventListener('change', async () => {
    await save({ includeHidden: $('include-hidden').value });
    refresh();
  });

  $('copy').addEventListener('click', async () => {
    if (!last) return;
    $('copy').disabled = true;
    try {
      // The popup holds the user gesture, so the rich clipboard API works here
      // even when the page's own clipboard access would be blocked.
      const how = await copyRich(last);
      setStatus(how === 'multi' ? 'Copied (text + formatting)' : 'Copied');
      setTimeout(() => setStatus(''), 2200);
    } catch (err) {
      const res = await bg('copy', optsNow());
      setStatus(res && res.ok ? 'Copied' : 'Copy blocked — open the page and press Ctrl+Shift+Y', !res || !res.ok);
    }
    $('copy').disabled = false;
  });

  $('download').addEventListener('click', async () => {
    const res = await bg('download', optsNow());
    setStatus(res && res.ok ? 'Saved' : (res && res.error) || 'Save failed', !res || !res.ok);
    setTimeout(() => setStatus(''), 2500);
  });

  $('open-shortcuts').addEventListener('click', () => {
    const url = 'chrome://extensions/shortcuts';
    chrome.tabs.create({ url }).catch(() => {});
  });

  refresh();
}

document.addEventListener('DOMContentLoaded', init);
