/* Background: hotkeys, context menu, injection fallback.
 * Deliberately thin — all page work happens in the content script. */
const DEFAULTS = { format: 'md-lean', scope: 'content', includeHidden: 'mark' };

async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return Object.assign({}, DEFAULTS, s);
}

function withTab(fn) {
  return (tab) => fn(tab).catch((err) => console.warn('[page-capture]', err));
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (res && res.ok) return true;
  } catch (e) { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/extractor.js', 'src/content.js'],
    });
    return true;
  } catch (err) {
    // chrome:// , the web store, PDF viewer and other privileged pages
    console.warn('[page-capture] cannot inject:', err.message);
    return false;
  }
}

async function send(tab, msg) {
  if (!tab || !tab.id) return { ok: false, error: 'no active tab' };
  const ready = await ensureContentScript(tab.id);
  if (!ready) return { ok: false, error: 'This page does not allow extensions (browser UI, web store, PDF viewer…)' };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

chrome.commands.onCommand.addListener(withTab(async (command) => {
  const tab = await activeTab();
  const opts = await getSettings();
  if (command === 'capture-selection') opts.scope = 'selection';
  const res = await send(tab, { type: 'copy', opts });
  if (!res.ok) console.warn('[page-capture]', res.error);
}));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'page-capture-md',
    title: 'Copy page as Markdown (for LLM)',
    contexts: ['page', 'selection', 'frame'],
  });
  chrome.contextMenus.create({
    id: 'page-capture-json',
    title: 'Copy page structure as JSON',
    contexts: ['page', 'selection', 'frame'],
  });
  chrome.contextMenus.create({
    id: 'page-capture-styled',
    title: 'Copy selection with formatting (styled HTML)',
    contexts: ['selection', 'page', 'frame'],
  });
});

chrome.contextMenus.onClicked.addListener(withTab(async (info, tab) => {
  const base = await getSettings();
  const opts = Object.assign({}, base);
  if (info.menuItemId === 'page-capture-json') opts.format = 'json';
  if (info.menuItemId === 'page-capture-styled') { opts.format = 'styled'; opts.scope = info.selectionText ? 'selection' : 'content'; }
  if (info.selectionText && opts.scope === 'content') opts.scope = 'selection';
  const res = await send(tab, { type: 'copy', opts });
  if (!res.ok) console.warn('[page-capture]', res.error);
}));

// Message bridge so the popup runs exactly the same code path as the hotkey.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || msg.type[0] === '$') return false;   // not ours
  if (msg.type === 'bg:capture' || msg.type === 'bg:copy' || msg.type === 'bg:download') {
    (async () => {
      const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : await activeTab();
      const type = msg.type.slice(3);
      sendResponse(await send(tab, { type, opts: msg.opts }));
    })();
    return true;
  }
  return false;
});
