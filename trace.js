/**
 * Request ids, trace context, and the log.
 *
 * Every response carries X-Request-Id: the caller's own if it sent a sane one
 * — the UI sends one on every call, so the id on a person's error and the id
 * in this process's log are the same string — else one made here. A W3C
 * `traceparent` rides alongside. Its trace id ties together every request one
 * page load made, across this runner and the control plane; its sampled flag
 * is how a caller asks for its requests to be logged.
 *
 *   GC_LOG_LEVEL    error | warn | info | debug     default info
 *   GC_LOG_FORMAT   text | json                     default text
 *   GC_REQUEST_LOG  off | sampled | all             default sampled
 *
 * `sampled` logs a request only when its traceparent says so — the UI's
 * "Trace my requests" setting — so following one person's session needs no
 * restart and does not log everybody else's. `all` logs every request.
 *
 * What a request line holds: the ids, method, the path WITHOUT its query
 * (tickets and tokens have lived in query strings before), status, duration,
 * address, organisation and subject. Never a header, a cookie or a body.
 */
import { randomBytes, randomUUID } from 'node:crypto';

const RID = /^[A-Za-z0-9._:-]{8,128}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** { rid, trace, sampled } for one request, from its headers or made here. */
export function requestIds(headers = {}) {
  const given = String(headers['x-request-id'] ?? '');
  const tp = TRACEPARENT.exec(String(headers.traceparent ?? '').trim().toLowerCase());
  // All-zero ids are invalid by the spec, and a sender that wrote them sent nothing.
  const valid = tp && !/^0+$/.test(tp[1]) && !/^0+$/.test(tp[2]);
  return {
    rid: RID.test(given) ? given : randomUUID(),
    trace: valid ? tp[1] : randomBytes(16).toString('hex'),
    sampled: valid ? (parseInt(tp[3], 16) & 1) === 1 : false,
  };
}

function choice(name, allowed, fallback) {
  const value = (process.env[name] ?? '').trim().toLowerCase() || fallback;
  if (!allowed.includes(value)) throw new Error(`${name}="${process.env[name]}" must be one of ${allowed.join(', ')}`);
  return value;
}

/** How this process logs, and why the settings could not be read, if they could not. */
export let LOG_ERROR = null;
let LEVEL = 'info';
let FORMAT = 'text';
let REQUESTS = 'sampled';
try {
  LEVEL = choice('GC_LOG_LEVEL', Object.keys(LEVELS), 'info');
  FORMAT = choice('GC_LOG_FORMAT', ['text', 'json'], 'text');
  REQUESTS = choice('GC_REQUEST_LOG', ['off', 'sampled', 'all'], 'sampled');
} catch (err) {
  LOG_ERROR = err.message;
}
export const logging = { level: () => LEVEL, format: () => FORMAT, requests: () => REQUESTS };

function write(level, msg, fields = {}) {
  if (LEVELS[level] > LEVELS[LEVEL]) return;
  const at = new Date().toISOString();
  const kept = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const line = FORMAT === 'json'
    ? JSON.stringify({ at, level, msg, ...Object.fromEntries(kept) })
    : `${at} ${level.toUpperCase().padEnd(5)} ${msg}${kept.map(([k, v]) => ` ${k}=${v}`).join('')}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const logger = {
  error: (msg, fields) => write('error', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  debug: (msg, fields) => write('debug', msg, fields),
};

/** Whether a request with these ids is one to log. */
export const wanted = (ids) => REQUESTS === 'all' || (REQUESTS === 'sampled' && ids.sampled);

/**
 * Express middleware: ids in, the id out, one line when the request finishes
 * if it is wanted. First in the chain, so a refusal from anything after it
 * still carries the id. `ipOf` is limits.js's clientIp, passed in so this
 * module stays free of that one's configuration.
 */
export function requestContext(ipOf) {
  return (req, res, next) => {
    const ids = requestIds(req.headers);
    req.ids = ids;
    res.setHeader('X-Request-Id', ids.rid);
    const began = process.hrtime.bigint();
    res.on('finish', () => {
      if (!wanted(ids)) return;
      const status = res.statusCode;
      write(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
        rid: ids.rid,
        trace: ids.trace,
        method: req.method,
        path: String(req.originalUrl ?? req.url).split('?')[0],
        status,
        ms: Number((process.hrtime.bigint() - began) / 1_000_000n),
        ip: ipOf(req),
        org: req.user?.org,
        sub: req.user?.sub,
      });
    });
    next();
  };
}
