/* Popup: a two-item menu (copy, shortcut) with the preview behind a disclosure. */
const DEFAULTS = { format: 'md-lean', scope: 'content', includeHidden: 'mark' };
const PREVIEW_LIMIT = 200_000;

const FORMAT_LABEL = {
  'md-lean': 'Markdown · lean',
  'md-llm': 'Markdown · with URLs',
  'md-doc': 'Markdown · front matter',
  json: 'JSON structure',
  text: 'Plain text',
  html: 'Clean HTML',
  styled: 'Styled HTML',
  report: 'Structure report',
};
const SCOPE_LABEL = { content: 'main content', page: 'whole page', selection: 'selection' };

const $ = (id) => document.getElementById(id);
let tabId = null;
let last = null;
let moreLoaded = false;

const ua = navigator.userAgent;
const isEdge = /\bEdg\//.test(ua);
const isFirefox = /\bFirefox\//.test(ua);

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
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function optsNow() {
  return {
    format: $('format').value,
    scope: $('scope').value,
    includeHidden: $('include-hidden').value,
  };
}

function describeSettings() {
  const o = optsNow();
  return `${FORMAT_LABEL[o.format] || o.format} · ${SCOPE_LABEL[o.scope] || o.scope}`;
}

/* The browser owns the shortcuts; the extension can only read them back. */
async function shortcutLabel() {
  try {
    const all = await chrome.commands.getAll();
    const cmd = all.find((c) => c.name === 'capture-and-copy');
    return cmd && cmd.shortcut ? cmd.shortcut : 'not set';
  } catch (e) {
    return 'not set';
  }
}

function shortcutUrl() {
  if (isFirefox) return 'about:addons';
  return isEdge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
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
      : 'scope: ' + res.meta.scope;
  }
}

async function refresh() {
  $('stats').textContent = 'capturing…';
  const res = await bg('capture', optsNow());
  if (!res || res.ok === false) {
    $('stats').textContent = 'capture failed';
    $('preview').value = '';
    setStatus((res && res.error) || 'Could not read this page', true);
    $('copy').disabled = true;
    return;
  }
  last = res;
  $('copy').disabled = false;
  showPreview(res);
}

async function openMore() {
  const more = $('more');
  if (!more.classList.contains('hidden')) return;
  more.classList.remove('hidden');
  $('more-toggle').setAttribute('aria-expanded', 'true');
  $('chev').textContent = '▴';
  if (!moreLoaded) { moreLoaded = true; await refresh(); }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  try {
    const url = new URL(tab.url);
    $('page-domain').textContent = url.hostname + url.pathname.slice(0, 40);
  } catch (e) {
    $('page-domain').textContent = (tab && tab.title) || '';
  }

  const s = await settings();
  $('format').value = s.format;
  $('scope').value = s.scope;
  $('include-hidden').value = s.includeHidden;
  $('copy-sub').textContent = describeSettings();

  const key = await shortcutLabel();
  $('copy-key').textContent = key;
  $('copy-key').style.display = key === 'not set' ? 'none' : '';
  $('shortcut-sub').textContent = isFirefox
    ? 'about:addons → Manage Extension Shortcuts'
    : `Currently ${key === 'not set' ? 'unassigned' : key}`;

  // 1st item: the copy function
  $('copy').addEventListener('click', async () => {
    $('copy').disabled = true;
    setStatus('copying…');
    const res = await bg('copy', optsNow());
    if (res && res.ok) {
      // the content script shows the toast on the page, so closing is seamless
      setStatus('copied');
      window.close();
      return;
    }
    $('copy').disabled = false;
    setStatus((res && res.error) || 'Copy failed on this page', true);
  });

  // 2nd item: shortcut customisation
  $('shortcut').addEventListener('click', async () => {
    const url = shortcutUrl();
    try {
      await chrome.tabs.create({ url });
      window.close();
    } catch (e) {
      setStatus(`Open ${url} to change the shortcut`, true);
    }
  });

  $('more-toggle').addEventListener('click', openMore);

  for (const id of ['format', 'scope', 'include-hidden']) {
    $(id).addEventListener('change', async () => {
      await save({ [id === 'include-hidden' ? 'includeHidden' : id]: $(id).value });
      $('copy-sub').textContent = describeSettings();
      if (moreLoaded) await refresh();
    });
  }

  $('download').addEventListener('click', async () => {
    const res = await bg('download', optsNow());
    setStatus(res && res.ok ? 'saved' : ((res && res.error) || 'save failed'), !(res && res.ok));
  });

  $('copy-here').addEventListener('click', async () => {
    const res = await bg('copy', optsNow());
    setStatus(res && res.ok ? 'copied (menu stays open)' : ((res && res.error) || 'copy failed'), !(res && res.ok));
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); $('copy').click(); }
    if (ev.key === 'Escape') window.close();
  });
}

document.addEventListener('DOMContentLoaded', init);
