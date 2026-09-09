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
      if (m.op === 'hover') state.steps.push({ op: 'hover', target });
      if (m.op === 'fill') {
        state.steps.push(m.secret
          ? { op: 'fill', target, valueRef: 'secrets.TODO' }
          : { op: 'fill', target, value: m.value ?? '' });
      }
      if (m.op === 'seeText') state.steps.push({ op: 'expect', assert: 'textVisible', value: m.value });
      if (m.op === 'seeUrl') state.steps.push({ op: 'expect', assert: 'urlContains', value: m.value });
      await save(state);
      tell({ t: 'state', state });

      // A hover is recorded but not performed: the pointer is already there,
      // and re-firing it would close what it just opened.
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

    if (m.t === 'send') return reply(await deliver(m.flow, m.host, m.authHost));
    reply({ ok: false });
  })();
  return true;   // keep the channel open for the async reply
});

/**
 * Hand a recording to ghostclick.
 *
 * With auth on, POST /api/recording is under the runner's gate like every
 * other route, and the runner never sees a cookie. So the hand-off is done
 * the way the app does it (docs/AUTH.md §11 [browser-side-2]): ask the
 * control plane for an executor token on the strength of the person's own
 * session — GET /auth/csrf, then POST /auth/executor-token with the cookie
 * and the CSRF token echoed — and present that token to the runner as a
 * Bearer. It runs HERE, in the service worker, and not in the panel: the
 * request carries this extension's origin (chrome-extension://<id>), which
 * the operator has listed in GC_EXTENSION_ORIGINS on both services, and
 * Chrome sends the site's cookies with it because the manifest holds host
 * permission for the site. Nothing is stored: the token lives for one
 * hand-off and is dropped.
 *
 * A laptop with no control plane — `npm run app` with no --auth — has a
 * runner that wants no token and an auth host that answers 404 for
 * /auth/csrf; that is the "no token" path, not an error.
 */
async function deliver(flow, host, authHost) {
  let token = null;
  try {
    token = await executorToken(authHost || host);
  } catch (e) {
    return { ok: false, note: e.message };
  }
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let res;
  try {
    res = await fetch(`${host}/api/recording`, { method: 'POST', headers, body: JSON.stringify({ flow }) });
  } catch (e) {
    return { ok: false, note: `Could not reach ${host} (${e.message}). Check it is running, or use Copy mermaid instead.` };
  }
  if (res.status === 401 && !token) {
    return { ok: false, note: `${host} wants a signed-in session and no control plane answered at ${authHost || host}. Set "Where you sign in" below and sign in there first.` };
  }
  if (res.status === 401) return { ok: false, note: 'The runner refused the token. Sign in to ghostclick again and retry.' };
  if (res.status === 409) return { ok: false, note: 'Another organisation is driving the runner right now; try again when it is free.' };
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, note: `${res.status}: ${body.error ?? res.statusText}` };
  return { ok: true, note: 'Sent — it is in the ghostclick script box.' };
}

/**
 * The token, or null when there is no control plane at `authHost` to ask —
 * a runner with auth off is reached without one. Every refusal names what
 * to do about it, because the panel has nowhere else to look.
 */
async function executorToken(authHost) {
  let csrf;
  try {
    csrf = await fetch(`${authHost}/auth/csrf`, { credentials: 'include' });
  } catch (e) {
    throw new Error(`Could not reach ${authHost} for a token (${e.message}).`);
  }
  if (csrf.status === 404) return null;
  if (!csrf.ok) throw new Error(`${authHost}/auth/csrf answered ${csrf.status}.`);
  const { csrfToken } = await csrf.json();
  const res = await fetch(`${authHost}/auth/executor-token`, {
    method: 'POST', credentials: 'include', headers: { 'X-CSRFToken': csrfToken },
  });
  if (res.status === 401) throw new Error(`Sign in to ghostclick at ${authHost}/app/ first, then send again.`);
  if (res.status === 403) {
    const { error } = await res.json().catch(() => ({}));
    if (error === 'mfa_required') throw new Error('Your account must enrol an authenticator first — Security in the app.');
    if (error === 'password_change_required') throw new Error('Your password must be changed first — Security in the app.');
    // A CSRF refusal: this extension's origin is not in GC_EXTENSION_ORIGINS.
    throw new Error(`${authHost} refused this extension (${chrome.runtime.id}). Its origin has to be listed in GC_EXTENSION_ORIGINS on both services.`);
  }
  if (res.status === 429) throw new Error('Too many tokens minted for this session in ten minutes; wait a little.');
  if (!res.ok) throw new Error(`${authHost}/auth/executor-token answered ${res.status}.`);
  return (await res.json()).token;
}
