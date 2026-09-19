/**
 * Notifications, checked against receivers this script starts itself.
 *
 *   the words        an incident, a failed run and a defect shaped the same
 *                    for every channel, and redacted before any channel sees them
 *   the store        channels made, changed, listed without their secret
 *   delivery         a webhook gets JSON and a signature, Slack gets text, an
 *                    email goes through a relay (an SMTP server here), a
 *                    channel that fails is retried and then says why, the
 *                    day's cap holds, an address out of reach is refused
 *
 *   node scripts/check-notify.js       (no browser, no runner)
 */
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import * as notify from '../notify.js';
import { sendMail, parseSmtpUrl } from '../smtp.js';
import { stateDir } from '../org.js';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(58)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(58)} ${d}`); };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 62 - t.length))}`);
async function check(label, fn) { try { const d = await fn(); ok(label, d ?? ''); } catch (e) { bad(label, e.message.split('\n')[0].slice(0, 140)); } }
const ORG = 'check-notify';
rmSync(stateDir(ORG), { recursive: true, force: true });

// ---------------------------------------------------------------------------
section('1 · the words');
await check('an incident, opened and resolved', () => {
  const m = notify.shape('incident', { label: 'Hero heading', ruleText: 'text must not change', headline: 'text changed: "Welcome" → "Welcome back"', severity: 'major', page: 'https://acme.example/', id: 'i-1' });
  assert.equal(m.title, 'Incident: Hero heading');
  assert.match(m.text, /Welcome back/);
  assert.deepEqual(m.lines, ['Rule: text must not change', 'Severity: major', 'Page: https://acme.example/', 'Incident i-1']);
  assert.equal(notify.shape('incident', { label: 'Hero heading', status: 'resolved', ruleText: 'x' }).title, 'Resolved: Hero heading');
});
await check('a failed run, with the step and the defect', () => {
  const m = notify.shape('run_failed', { suite: 'Acme', caseName: 'signs in', passed: 2, total: 5, error: 'button:Sign in never became visible', step: 2, doing: "click 'Sign in' : button", defect: 'DEF-2026-09-004', scheduled: true });
  assert.equal(m.title, 'Run failed: Acme · signs in');
  assert.equal(m.text, '2/5 steps passed — button:Sign in never became visible');
  assert.deepEqual(m.lines, ["Stopped at step 3 — click 'Sign in' : button", 'Defect DEF-2026-09-004', 'A scheduled run']);
  assert.match(notify.asText(m), /Stopped at step 3/);
});
await check('a defect filed or reopened', () => {
  assert.equal(notify.shape('defect', { kind: 'filed', id: 'DEF-2026-09-004', title: 'never became visible' }).title, 'Defect filed: DEF-2026-09-004');
  assert.equal(notify.shape('defect', { kind: 'reopened', id: 'DEF-2026-09-004', title: 'x' }).title, 'Defect reopened: DEF-2026-09-004');
});

// ---------------------------------------------------------------------------
section('2 · the store');
const book = notify.forOrg(ORG);
await check('channels are made, listed without their secret, and changed', () => {
  const w = book.create({ kind: 'webhook', name: 'Ops hook', url: 'https://hooks.acme.example/gc', secret: 'shh', events: ['incident', 'run_failed'] });
  assert.ok(w.id.startsWith('ch-'));
  assert.equal(w.where, 'hooks.acme.example');
  assert.equal(w.signed, true);
  assert.ok(!('secret' in w) && !('url' in w) || w.url === undefined);
  const s = book.create({ kind: 'slack', url: 'https://hooks.slack.com/services/T0/B0/xyz' });
  assert.equal(s.name, 'Slack');
  assert.deepEqual(s.events, ['incident', 'run_failed', 'defect']);
  const e = book.create({ kind: 'email', to: 'qa@acme.example, lead@acme.example', events: ['defect'] });
  assert.equal(e.where, 'qa@acme.example, lead@acme.example');
  assert.equal(book.list().length, 3);
  assert.equal(book.update(w.id, { enabled: false, name: 'Quiet hook' }).enabled, false);
  assert.equal(book.wanting('incident').length, 1, 'a switched-off channel is not told');
  book.update(w.id, { enabled: true });
  assert.throws(() => book.update(w.id, { events: [] }), /at least one event/);
});
await check('what is not a channel is refused, by name', () => {
  assert.throws(() => book.create({ kind: 'pigeon', url: 'https://x' }), /kind must be/);
  assert.throws(() => book.create({ kind: 'webhook', url: 'ftp://x' }), /http:\/\/ or https:\/\//);
  assert.throws(() => book.create({ kind: 'webhook', url: 'not a url' }), /https:\/\/ address/);
  assert.throws(() => book.create({ kind: 'slack', url: 'https://example.com/hook' }), /incoming webhook/);
  assert.throws(() => book.create({ kind: 'email', to: 'nobody' }), /not an email address/);
  assert.throws(() => book.create({ kind: 'email', to: '' }), /needs an address/);
  assert.throws(() => book.create({ kind: 'webhook', url: 'https://x.example', events: ['nope'] }), /at least one event/);
});

// ---------------------------------------------------------------------------
section('3 · delivery');
// A webhook receiver and a Slack receiver: one HTTP server, two paths; a
// path that fails twice before it answers; a path that never answers well.
const got = { hook: [], slack: [], flaky: 0 };
const web = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/hook') { got.hook.push({ headers: req.headers, body }); res.writeHead(200); return res.end('ok'); }
    if (req.url === '/services/T0/B0/x') { got.slack.push(JSON.parse(body)); res.writeHead(200); return res.end('ok'); }
    if (req.url === '/flaky') { got.flaky++; if (got.flaky < 3) { res.writeHead(503); return res.end('later'); } res.writeHead(200); return res.end('ok'); }
    res.writeHead(500); res.end('no');
  });
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const webPort = web.address().port;
// A relay: enough SMTP to accept one message and keep it.
const mails = [];
const smtp = net.createServer((sock) => {
  let data = null;
  let mail = { from: null, to: [], text: '' };
  sock.write('220 check-notify relay\r\n');
  sock.on('data', (chunk) => {
    const s = chunk.toString();
    if (data !== null) {
      data += s;
      const end = data.indexOf('\r\n.\r\n');
      if (end >= 0) { mail.text = data.slice(0, end); mails.push(mail); mail = { from: null, to: [], text: '' }; data = null; sock.write('250 queued\r\n'); }
      return;
    }
    for (const line of s.split('\r\n').filter(Boolean)) {
      if (/^EHLO/i.test(line)) sock.write('250-check-notify\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH PLAIN/i.test(line)) sock.write(Buffer.from(line.split(' ')[2], 'base64').toString() === '\0qa\0secret' ? '235 ok\r\n' : '535 no\r\n');
      else if (/^MAIL FROM:<(.+)>/i.test(line)) { mail.from = line.match(/<(.+)>/)[1]; sock.write('250 ok\r\n'); }
      else if (/^RCPT TO:<(.+)>/i.test(line)) { mail.to.push(line.match(/<(.+)>/)[1]); sock.write('250 ok\r\n'); }
      else if (/^DATA/i.test(line)) { data = ''; sock.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('500 what\r\n');
    }
  });
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const smtpUrl = `smtp://qa:secret@127.0.0.1:${smtp.address().port}?starttls=no`;
let clock = Date.now();
notify.configure({ retryMs: [0, 0, 0, 0], smtp: { url: smtpUrl, from: 'runner@acme.example' }, redactFor: () => (s) => s.replaceAll('hunter2', '[redacted]'), log: { error: () => {} }, clock: () => clock, mayReach: null });
const fresh = notify.forOrg(ORG);
for (const c of fresh.list()) fresh.remove(c.id);
const hook = fresh.create({ kind: 'webhook', name: 'Hook', url: `http://127.0.0.1:${webPort}/hook`, secret: 'topsecret', events: ['incident', 'run_failed', 'defect'] });
fresh.create({ kind: 'slack', name: 'Slack', url: `http://127.0.0.1:${webPort}/services/T0/B0/x`, events: ['run_failed'] });
fresh.create({ kind: 'email', name: 'Mail', to: 'qa@acme.example', events: ['defect'] });
await check('parseSmtpUrl reads the relay address', () => {
  const c = parseSmtpUrl('smtps://u%40x:p%3Aw@mail.acme.example');
  assert.deepEqual([c.host, c.port, c.secure, c.user, c.pass], ['mail.acme.example', 465, true, 'u@x', 'p:w']);
  assert.throws(() => parseSmtpUrl('https://x'), /smtp:\/\//);
});
await check('a failed run reaches the webhook, signed, and Slack as text; the password never leaves', async () => {
  const r = await notify.send(ORG, 'run_failed', { suite: 'Acme', caseName: 'signs in', passed: 1, total: 3, error: 'typed hunter2 and nothing happened', step: 1, doing: "fill 'Password' : label" });
  assert.deepEqual(r.map((x) => x.ok), [true, true]);
  assert.equal(got.hook.length, 1);
  const h = got.hook[0];
  const payload = JSON.parse(h.body);
  assert.equal(h.headers['x-ghostclick-event'], 'run_failed');
  assert.equal(h.headers['x-ghostclick-signature'], `sha256=${crypto.createHmac('sha256', 'topsecret').update(h.body).digest('hex')}`);
  assert.equal(payload.title, 'Run failed: Acme · signs in');
  assert.ok(!h.body.includes('hunter2') && h.body.includes('[redacted]'), 'redacted before it left');
  assert.equal(got.slack.length, 1);
  assert.match(got.slack[0].text, /^\*Run failed: Acme · signs in\*\n1\/3 steps passed/);
  assert.equal(fresh.list().find((c) => c.id === hook.id).sent, 1);
});
await check('a defect goes by email through the relay', async () => {
  const r = await notify.send(ORG, 'defect', { kind: 'filed', id: 'DEF-2026-09-001', title: 'never became visible', suite: 'Acme' });
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].from, 'runner@acme.example');
  assert.deepEqual(mails[0].to, ['qa@acme.example']);
  assert.match(mails[0].text, /Subject: \[ghostclick\] Defect filed: DEF-2026-09-001/);
  assert.match(mails[0].text, /never became visible/);
});
await check('a channel that fails twice is retried and then delivered', async () => {
  const flaky = fresh.create({ kind: 'webhook', name: 'Flaky', url: `http://127.0.0.1:${webPort}/flaky`, events: ['incident'] });
  const r = await notify.send(ORG, 'incident', { label: 'Hero', ruleText: 'x', headline: 'moved' });
  const mine = r.find((x) => x.channel === flaky.id);
  assert.equal(mine.ok, true);
  assert.equal(mine.tries, 3);
  fresh.remove(flaky.id);
});
await check('a channel that never answers well says why, on the channel', async () => {
  const dead = fresh.create({ kind: 'webhook', name: 'Dead', url: `http://127.0.0.1:${webPort}/nope`, events: ['incident'] });
  const r = await notify.send(ORG, 'incident', { label: 'Hero', ruleText: 'x', headline: 'moved' });
  const mine = r.find((x) => x.channel === dead.id);
  assert.equal(mine.ok, false);
  assert.match(mine.error, /500 from 127\.0\.0\.1/);
  const c = fresh.list().find((x) => x.id === dead.id);
  assert.equal(c.failed, 1);
  assert.match(c.lastError, /500/);
  fresh.remove(dead.id);
});
await check('an email channel without a relay says what is missing', async () => {
  notify.configure({ smtp: { url: null, from: null } });
  const r = await notify.test(ORG, fresh.list().find((c) => c.kind === 'email').id);
  assert.equal(r.ok, false);
  assert.match(r.error, /GC_SMTP_URL/);
  notify.configure({ smtp: { url: smtpUrl, from: 'runner@acme.example' } });
});
await check('the test button sends one message and reports', async () => {
  const r = await notify.test(ORG, hook.id);
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(got.hook.at(-1).body).title, 'ghostclick: a test');
});
await check('an address out of reach is refused before anything is sent', async () => {
  notify.configure({ mayReach: async (url) => (/127\.0\.0\.1/.test(url) ? 'a private address' : null) });
  const before = got.hook.length;
  const r = await notify.send(ORG, 'incident', { label: 'Hero', ruleText: 'x', headline: 'moved' });
  assert.equal(r.find((x) => x.channel === hook.id).ok, false);
  assert.match(r.find((x) => x.channel === hook.id).error, /out of reach/);
  assert.equal(got.hook.length, before);
  notify.configure({ mayReach: null });
});
await check("the day's cap holds, and a new day opens it again", async () => {
  fresh.day = { on: new Date(clock).toISOString().slice(0, 10), sent: notify.SENDS_PER_DAY };
  const r = await notify.send(ORG, 'incident', { label: 'Hero', ruleText: 'x', headline: 'moved' });
  assert.match(r[0].error, /sends are spent/);
  clock += 86_400_000;
  const again = await notify.send(ORG, 'incident', { label: 'Hero', ruleText: 'x', headline: 'moved' });
  assert.equal(again[0].ok, true);
});
await check('sendMail itself: a relay that refuses the login is a sentence', async () => {
  await assert.rejects(sendMail({ url: `smtp://qa:wrong@127.0.0.1:${smtp.address().port}?starttls=no`, from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't' }), /AUTH: the relay said 535/);
  await assert.rejects(sendMail({ url: smtpUrl, from: 'nope', to: 'c@d.co', subject: 's', text: 't' }), /sender address/);
});
web.close(); smtp.close();
rmSync(stateDir(ORG), { recursive: true, force: true });

// ---------------------------------------------------------------------------
if (process.env.GC_NOTIFY_OFFLINE) {
  console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all green (offline)\n');
  process.exit(failures ? 1 : 0);
}
section('4 · the runner');
// A receiver of this script's own, and a runner told to send to it: a case
// that fails runs, and the receiver hears about the run — and, where the
// runner files defects, about the defect.
const heard = [];
const receiver = http.createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => { heard.push({ event: req.headers['x-ghostclick-event'], body: JSON.parse(body) }); res.writeHead(200); res.end('ok'); }); });
await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
const HOOK = `http://127.0.0.1:${receiver.address().port}/gc`;
const { spawn } = await import('node:child_process');
const { resolve, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GC_NOTIFY_PORT) || 3417;
const BASE = `http://localhost:${PORT}`;
const child = spawn('node', ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), GC_CHAT: 'mock', GC_MONITOR_LLM: 'mock', HOME_URL: 'about:blank', GC_PACE_MS: '0', GC_SETTLE_MS: '120', GC_TIMEOUT_MS: '2500', GC_SMTP_URL: '', GC_SMTP_FROM: '' } });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const api = async (method, path, body) => { const r = await fetch(`${BASE}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { /* not JSON */ } return { status: r.status, json }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = async () => { child.kill('SIGTERM'); receiver.close(); await sleep(500); console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all green\n'); process.exit(failures ? 1 : 0); };
for (let i = 0; i < 120; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.ok) break; } catch { /* not yet */ } await sleep(500); }
let suiteId = null;
try {
  await check('the catalogue: events, kinds, and whether email has a relay', async () => {
    const r = await api('GET', '/api/notify');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.events), ['incident', 'run_failed', 'defect']);
    assert.equal(r.json.smtp, false);
    assert.deepEqual(r.json.channels, []);
  });
  let channelId = null;
  await check('a webhook channel is made over the API and shown by its host', async () => {
    const r = await api('POST', '/api/notify/channels', { kind: 'webhook', name: 'Check hook', url: HOOK, secret: 's3', events: ['run_failed', 'defect'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    channelId = r.json.channel.id;
    assert.equal(r.json.channel.where, `127.0.0.1:${receiver.address().port}`);
    assert.equal(r.json.channel.signed, true);
    assert.equal((await api('POST', '/api/notify/channels', { kind: 'webhook', url: 'nope' })).status, 400);
  });
  await check('the test button reaches it', async () => {
    const r = await api('POST', `/api/notify/channels/${channelId}/test`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.result.ok, true, JSON.stringify(r.json.result));
    assert.equal(heard.at(-1).event, 'test');
  });
  await check('a case that fails is told to the channel, with the step and the reason', async () => {
    await api('POST', '/api/origins', { origin: BASE });
    const made = await api('POST', '/api/suites', { name: 'Notify check', baseUrl: BASE, description: 'made by scripts/check-notify.js' });
    suiteId = made.json?.suite?.id ?? made.json?.id;
    assert.ok(suiteId, JSON.stringify(made.json).slice(0, 120));
    const flow = `%% suite "Notify check"\ntestcase TD\n  n0(("${BASE}/demo.html"))\n  n1{{"Nothing here at all, ever"}}\n\n  n0 --> n1`;
    const added = await api('POST', `/api/suites/${suiteId}/cases`, { name: 'expects words that are not there', pageId: null, flow, source: 'generated' });
    assert.ok(added.json?.ok, JSON.stringify(added.json).slice(0, 160));
    const run = await api('POST', `/api/suites/${suiteId}/run`);
    assert.equal(run.status, 200, JSON.stringify(run.json).slice(0, 160));
    assert.equal(run.json.passed, 0);
    let told = null;
    for (let i = 0; i < 100 && !told; i++) { told = heard.find((h) => h.event === 'run_failed'); if (!told) await sleep(200); }
    assert.ok(told, 'the receiver heard run_failed');
    assert.equal(told.body.event, 'run_failed');
    assert.match(told.body.title, /^Run failed: Notify check · expects words that are not there/);
    assert.match(told.body.text, /^1\/2 steps passed/);
    assert.ok(told.body.lines.some((l) => /^Stopped at step 2/.test(l)), JSON.stringify(told.body.lines));
    const ch = (await api('GET', '/api/notify')).json.channels[0];
    assert.ok(ch.sent >= 2, `sent ${ch.sent}`);
    assert.equal(ch.lastError, null);
    return told.body.data.defect ? `and defect ${told.body.data.defect}` : 'no defects on this runner';
  });
  await check('where the runner files defects, the defect is told too', async () => {
    const health = log.includes('defect') || true;
    const d = heard.find((h) => h.event === 'defect');
    if (!d) return 'skipped: this runner files no defects';
    assert.match(d.body.title, /^Defect filed: DEF-/);
    return d.body.title;
  });
  await check('removed, and gone from the catalogue', async () => {
    assert.equal((await api('DELETE', `/api/notify/channels/${channelId}`)).status, 200);
    assert.equal((await api('DELETE', `/api/notify/channels/${channelId}`)).status, 404);
    assert.deepEqual((await api('GET', '/api/notify')).json.channels, []);
  });
} finally {
  if (suiteId) await api('DELETE', `/api/suites/${suiteId}`).catch(() => null);
  await done();
}
