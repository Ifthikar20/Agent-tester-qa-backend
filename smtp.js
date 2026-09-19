/**
 * A mail, sent — over SMTP, with nothing added to package.json.
 *
 * The runner carries its own readers and writers where a dependency would
 * be bigger than the job (chat-import.js reads a spreadsheet the same way),
 * and a notification is one message to one relay: EHLO, STARTTLS when the
 * relay offers it and the address did not already say TLS, AUTH PLAIN when
 * there are credentials, one MAIL FROM, the recipients, DATA, QUIT. The
 * relay is named by one address in the environment (GC_SMTP_URL, see
 * notify.js): `smtp://user:pass@host:587` upgrades to TLS on the wire when
 * offered; `smtps://user:pass@host:465` is TLS from the first byte.
 *
 * Pure protocol: nothing here knows what a notification is.
 */
import net from 'node:net';
import tls from 'node:tls';

export const DEFAULT_TIMEOUT_MS = 15_000;

/** `smtp://user:pass@host:port` → what the connection needs; a bad address is a reason. */
export function parseSmtpUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { throw new Error('the SMTP address is not a URL — smtp://user:pass@host:587 or smtps://…:465'); }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error(`the SMTP address must start with smtp:// or smtps://, not ${u.protocol}//`);
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: Number(u.port) || (secure ? 465 : 587),
    secure,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null,
    starttls: u.searchParams.get('starttls') !== 'no',
  };
}

/** One RFC 5322 address, checked loosely: something@something, no line breaks. */
export const isAddress = (s) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s ?? '').trim());

/**
 * The conversation over one socket: commands out, coded replies in. A reply
 * is every line up to the one whose code is followed by a space (`250 ok`
 * after `250-…`), and a code the caller did not expect is the error, with the
 * relay's own words in it.
 */
function talker(socket, timeoutMs) {
  let buffer = '';
  const waiting = [];
  const feed = (chunk) => {
    buffer += chunk;
    for (;;) {
      const m = buffer.match(/^([\s\S]*?\r?\n)?(\d{3}) [^\r\n]*\r?\n/);
      if (!m) return;
      const whole = m[0];
      buffer = buffer.slice(whole.length);
      const lines = whole.split(/\r?\n/).filter(Boolean);
      const code = Number(lines[lines.length - 1].slice(0, 3));
      const w = waiting.shift();
      if (w) w.resolve({ code, lines });
    }
  };
  let current = socket;
  const listen = (s) => {
    s.setEncoding('utf8');
    s.on('data', feed);
    s.on('error', (err) => { for (const w of waiting.splice(0)) w.reject(err); });
    s.on('close', () => { for (const w of waiting.splice(0)) w.reject(new Error('the relay closed the connection')); });
  };
  listen(socket);
  const reply = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the relay did not answer within ${timeoutMs} ms`)), timeoutMs);
    waiting.push({ resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
  const expect = (r, codes, what) => {
    const ok = Array.isArray(codes) ? codes.includes(r.code) : r.code === codes;
    if (!ok) throw new Error(`${what}: the relay said ${r.lines.join(' | ').slice(0, 200)}`);
    return r;
  };
  return {
    reply,
    expect,
    async cmd(line, codes, what = line.split(' ')[0]) {
      current.write(`${line}\r\n`);
      return expect(await reply(), codes, what);
    },
    /** STARTTLS: the same conversation carries on over a TLS socket wrapped around the plain one. */
    async upgrade(host) {
      current.removeListener('data', feed);
      current = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: current, servername: host }, () => resolve(s));
        s.once('error', reject);
      });
      listen(current);
    },
    end() { try { current.end(); } catch { /* gone */ } },
  };
}

const stuff = (text) => String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
const header = (s) => String(s).replace(/[\r\n]+/g, ' ');

/**
 * Send one message. Resolves when the relay has accepted it (a 250 after
 * DATA), rejects with the relay's words otherwise.
 */
export async function sendMail({ url, from, to, subject, text, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const cfg = parseSmtpUrl(url);
  const rcpts = (Array.isArray(to) ? to : String(to ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
  if (!isAddress(from)) throw new Error(`the sender address is not an address: ${from}`);
  for (const r of rcpts) if (!isAddress(r)) throw new Error(`a recipient is not an address: ${r}`);
  if (!rcpts.length) throw new Error('no recipient');
  const socket = await new Promise((resolve, reject) => {
    const s = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s))
      : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeoutMs, () => { s.destroy(new Error(`no answer from ${cfg.host}:${cfg.port} within ${timeoutMs} ms`)); });
  });
  const t = talker(socket, timeoutMs);
  try {
    t.expect(await t.reply(), 220, 'greeting');
    let ehlo = await t.cmd('EHLO ghostclick', 250, 'EHLO');
    if (!cfg.secure && cfg.starttls && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await t.cmd('STARTTLS', 220, 'STARTTLS');
      await t.upgrade(cfg.host);
      ehlo = await t.cmd('EHLO ghostclick', 250, 'EHLO');
    }
    if (cfg.user) {
      const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ''}`).toString('base64');
      await t.cmd(`AUTH PLAIN ${plain}`, 235, 'AUTH');
    }
    await t.cmd(`MAIL FROM:<${from}>`, 250, 'MAIL FROM');
    for (const r of rcpts) await t.cmd(`RCPT TO:<${r}>`, [250, 251], `RCPT TO ${r}`);
    await t.cmd('DATA', 354, 'DATA');
    const date = new Date().toUTCString();
    const id = `<${Date.now()}.${Math.random().toString(16).slice(2)}@ghostclick>`;
    const body = [
      `From: ${header(from)}`, `To: ${rcpts.map(header).join(', ')}`, `Subject: ${header(subject)}`, `Date: ${date}`, `Message-ID: ${id}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '',
      stuff(text), '.',
    ].join('\r\n');
    await t.cmd(body, 250, 'the message');
    await t.cmd('QUIT', 221, 'QUIT').catch(() => null);
    return { ok: true, id, accepted: rcpts.length };
  } finally { t.end(); }
}
