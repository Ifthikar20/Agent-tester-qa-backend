import { toFlow } from './lib/flow.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_HOST = 'http://localhost:3000';
let host = DEFAULT_HOST;   // where the runner lives; remembered per install
// Where the person signs in — the control plane. Deployed, it is the same
// origin as the runner; on a laptop it is the Django port. Empty means
// "the same as host".
let authHost = '';

let state = { on: false, steps: [] };
let pick = null;

const send = (msg) => chrome.runtime.sendMessage(msg);

function render() {
  $('start').disabled = state.on;
  $('stop').disabled = !state.on;
  $('undo').disabled = !state.on || state.steps.length <= 1;

  $('idle').classList.toggle('hide', state.on);
  $('armPrompt').classList.toggle('hide', !state.on || !!pick);
  $('answer').classList.toggle('hide', !pick);

  $('count').textContent = state.steps.length ? `· ${state.steps.length}` : '';
  const ol = $('steps');
  ol.innerHTML = '';
  if (!state.steps.length) {
    ol.innerHTML = '<li class="dim">Nothing yet.</li>';
  } else {
    for (const s of state.steps) {
      const li = document.createElement('li');
      li.textContent = describe(s);
      ol.append(li);
    }
  }

  const flow = state.steps.length ? toFlow({ suite: 'Recorded flow', steps: state.steps }) : '';
  $('flow').textContent = flow || 'Recording will appear here.';
  $('flow').classList.toggle('dim', !flow);
  $('copy').disabled = !flow;
  $('send').disabled = !flow;
}

function describe(s) {
  if (s.op === 'goto') return `go to ${s.url}`;
  if (s.op === 'click') return `click ${s.target}`;
  if (s.op === 'hover') return `hover ${s.target}`;
  if (s.op === 'fill') return s.valueRef ? `type into ${s.target} ← vault` : `type "${s.value}" into ${s.target}`;
  if (s.op === 'expect' && s.assert === 'urlContains') return `assert url contains ${s.value}`;
  if (s.op === 'expect' && s.assert === 'textVisible') return `assert text "${s.value}"`;
  return s.op;
}

// ------------------------------------------------------------------ wiring
$('start').onclick = async () => { const r = await send({ t: 'start' }); state = r.state; pick = null; render(); };
$('stop').onclick  = async () => { const r = await send({ t: 'stop' });  state = r.state; pick = null; render(); };
$('undo').onclick  = async () => { const r = await send({ t: 'undo' });  state = r.state; render(); };
$('arm').onclick   = () => send({ t: 'arm' });

$('assertUrl').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const path = new URL(tab.url).pathname + new URL(tab.url).hash;
  const r = await send({ t: 'answer', op: 'seeUrl', value: path, pick: { href: tab.url } });
  state = r.state; render();
};

const answer = async (op, extra = {}) => {
  // The first proposal that is unambiguous. The runner verifies again when it
  // replays, so a bad guess fails loudly rather than silently passing.
  const target = (pick.candidates.find((c) => c.n === 1) ?? pick.candidates[0])?.target;
  const r = await send({ t: 'answer', op, target, pick, ...extra });
  state = r.state;
  pick = null;
  $('fillBox').classList.add('hide');
  render();
};

$('opClick').onclick  = () => answer('click');
$('opHover').onclick  = () => answer('hover');   // for whatever opens a menu
$('opSee').onclick    = () => answer('seeText', { value: pick.name });
$('opCancel').onclick = () => { pick = null; render(); };
$('opFill').onclick   = () => {
  $('fillBox').classList.remove('hide');
  $('fillValue').value = pick.value ?? '';
  $('fillValue').focus();
};
$('fillGo').onclick = () =>
  answer('fill', { value: $('fillValue').value, secret: $('fillSecret').checked });

$('copy').onclick = async () => {
  await navigator.clipboard.writeText($('flow').textContent);
  $('sendNote').textContent = 'Copied. Paste it into the ghostclick script box.';
};

// The hand-off is the background worker's (background.js): with auth on it
// has to be handed a token first, on the strength of your session, and the
// worker is where that request carries this extension's origin.
$('send').onclick = async () => {
  $('sendNote').textContent = 'Sending…';
  const r = await send({ t: 'send', flow: $('flow').textContent, host, authHost });
  if (r?.ok) {
    $('sendNote').textContent = r.note;
  } else {
    $('sendNote').textContent = '';
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = r?.note ?? 'The recorder did not answer.';
    $('sendNote').append(warn);
  }
};

chrome.runtime.onMessage.addListener((m) => {
  if (m.t === 'state') { state = m.state; render(); }
  if (m.t === 'picked') {
    pick = m.pick;
    $('picked').textContent = pick.preview;
    $('opFill').disabled = !pick.isField;
    render();
  }
});

$('saveHost').onclick = async () => {
  host = ($('host').value.trim() || DEFAULT_HOST).replace(/\/+$/, '');
  authHost = $('authHost').value.trim().replace(/\/+$/, '');
  await chrome.storage.local.set({ host, authHost });
  $('host').value = host;
  $('authHost').value = authHost;
  $('sendNote').textContent = `Will send to ${host}${authHost ? `, signed in at ${authHost}` : ''}`;
};

chrome.storage.local.get(['host', 'authHost']).then(({ host: saved, authHost: savedAuth }) => {
  host = saved || DEFAULT_HOST;
  authHost = savedAuth || '';
  $('host').value = host;
  $('authHost').value = authHost;
});
// An unpacked extension's id is derived from its directory, so it differs
// per machine; the operator lists this exact origin in GC_EXTENSION_ORIGINS.
$('origin').textContent = `chrome-extension://${chrome.runtime.id}`;

send({ t: 'get' }).then((r) => { if (r?.state) state = r.state; render(); });
