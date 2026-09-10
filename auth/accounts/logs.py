"""
What every log line from a request carries, and the two shapes a line comes in.

accounts.middleware.RequestContext decides a request's id and trace before
anything else runs, and keeps them in REQUEST, a context variable, for exactly
as long as the request lasts. RequestId, a logging filter on the console
handler, copies them onto every record written while it lasts — so a line
from the account adapter, the Turnstile check or the request log itself can be
found by the X-Request-Id the browser was shown, and joined to the edge's
trace. The audit log carries the same id (accounts.events.record).

The formatters are GC_LOG_FORMAT's two words: `text` for a person reading a
terminal, `json` for a collector reading one object per line.

Nothing here imports a model, or anything that does. The LOGGING setting
names these classes, and Django configures logging before it loads an app.
"""
import json
import logging
from contextvars import ContextVar
from datetime import datetime, timezone

# {rid, trace, sampled}, and whatever else must hold for one request and no
# longer (tenants.switches keeps the rows it read here). None outside one.
REQUEST = ContextVar('ghostclick_request', default=None)

NONE = '-'


def current():
    """This request's context, or None when no request is being served."""
    return REQUEST.get()


class RequestId(logging.Filter):
    """Put the request's rid and trace on the record, or '-' when there is no request."""

    def filter(self, record):
        context = REQUEST.get() or {}
        # A value the call passed in `extra` is kept: the request log names
        # its own request, which is the one that is ending.
        if not hasattr(record, 'rid'):
            record.rid = context.get('rid', NONE)
        if not hasattr(record, 'trace'):
            record.trace = context.get('trace', NONE)
        return True


class TextFormatter(logging.Formatter):
    """`<time> <LEVEL> <logger> rid=<id> trace=<id> <message>`."""

    FORMAT = '%(asctime)s %(levelname)s %(name)s rid=%(rid)s trace=%(trace)s %(message)s'

    def __init__(self):
        super().__init__(self.FORMAT)

    def format(self, record):
        # A record that reached this formatter without passing the filter —
        # a handler someone adds later — still formats instead of raising.
        record.__dict__.setdefault('rid', NONE)
        record.__dict__.setdefault('trace', NONE)
        return super().format(record)


class JsonFormatter(logging.Formatter):
    """
    One JSON object per line: when, how bad, which logger, the message, rid and
    trace, and every field the call passed in `extra` under its own name. ASCII
    only, so no character in a message — a path is the client's to write — can
    start a second line.
    """

    # What every LogRecord has. Anything else on a record came from `extra`
    # or from the filter.
    STANDARD = frozenset(vars(logging.LogRecord('', 0, '', 0, '', (), None))) | {'message', 'asctime'}

    def format(self, record):
        out = {
            'at': datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec='milliseconds'),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'rid': getattr(record, 'rid', NONE),
            'trace': getattr(record, 'trace', NONE),
        }
        for key, value in vars(record).items():
            if key not in self.STANDARD and key not in out:
                out[key] = value
        if record.exc_info:
            out['exception'] = self.formatException(record.exc_info)
        if record.stack_info:
            out['stack'] = self.formatStack(record.stack_info)
        return json.dumps(out, default=str)
