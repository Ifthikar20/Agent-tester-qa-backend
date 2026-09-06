/**
 * Recording state and routing.
 *
 * The service worker can be torn down at any moment in MV3, so the recording
 * lives in chrome.storage.session rather than a module variable. Losing a
 * half-hour demonstration to a worker restart is not a bug people forgive.
 */
const KEY = 'gc.recording';

const load = async () =>
  (await chrome.storage.session.get(KEY))[KEY] ?? { on: false, tabId: null, steps: [], lastUrl: null };
const save = (state) => chrome.storage.session.set({ [KEY]: state });
const tell = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.action.onClicked.addListener((tab) => chrome.sidePanel.open({ tabId: tab.id }));
chrome.runtime.onInstalled.addListener(() =>
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}));

const pathOf = (u) => { try { const x = new URL(u); return `${x.pathname}${x.hash}`; } catch { return null; } };

/** A route change is an assertion — it is what makes a recording self-checking. */
async function noteUrl(state, href) {
  if (!href || href === state.lastUrl) return false;
  const prev = state.lastUrl;
  state.lastUrl = href;
  if (!prev) return false;
  const path = pathOf(href);
  if (path && path !== pathOf(prev)) {
    state.steps.push({ op: 'expect', assert: 'urlContains', value: path });
    return true;
  }
  return false;
}

// Re-arm after a navigation: the content script is fresh and knows nothing.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const state = await load();
  if (!state.on || state.tabId !== tabId || info.status !== 'complete') return;
  await noteUrl(state, info.url ?? state.lastUrl);
  await save(state);
  tell({ t: 'state', state });
});

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    const state = await load();

    if (m.t === 'start') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const next = { on: true, tabId: tab.id, steps: [{ op: 'goto', url: tab.url }], lastUrl: tab.url };
      await save(next);
      tell({ t: 'state', state: next });
      return reply({ ok: true, state: next });
    }

    if (m.t === 'stop') {
      state.on = false;
      await save(state);
      if (state.tabId) chrome.tabs.sendMessage(state.tabId, { t: 'disarm' }).catch(() => {});
      tell({ t: 'state', state });
      return reply({ ok: true, state });
    }

    if (m.t === 'arm') {
      if (state.tabId) await chrome.tabs.sendMessage(state.tabId, { t: 'arm' }).catch(() => {});
      return reply({ ok: true });
    }

    if (m.t === 'picked') {
      // Straight through to the panel; nothing is recorded until you answer.
      tell({ t: 'picked', pick: m });
      return reply({ ok: true });
    }

    // The panel answered. Record it, then let the page have the click.
    if (m.t === 'answer') {
      await noteUrl(state, m.pick.href);
      const target = m.target;
      if (m.op === 'click') state.steps.push({ op: 'click', target });
      if (m.op === 'fill') {
        state.steps.push(m.secret
          ? { op: 'fill', target, valueRef: 'secrets.TODO' }
          : { op: 'fill', target, value: m.value ?? '' });
      }
      if (m.op === 'seeText') state.steps.push({ op: 'expect', assert: 'textVisible', value: m.value });
      if (m.op === 'seeUrl') state.steps.push({ op: 'expect', assert: 'urlContains', value: m.value });
      await save(state);
      tell({ t: 'state', state });

      if ((m.op === 'click' || m.op === 'fill') && state.tabId) {
        chrome.tabs.sendMessage(state.tabId, { t: 'perform', op: m.op, value: m.value })
          .catch(() => {});
      }
      return reply({ ok: true, state });
    }

    if (m.t === 'undo') {
      state.steps.pop();
      await save(state);
      tell({ t: 'state', state });
      return reply({ ok: true, state });
    }

    if (m.t === 'get') return reply({ ok: true, state });
    reply({ ok: false });
  })();
  return true;   // keep the channel open for the async reply
});
