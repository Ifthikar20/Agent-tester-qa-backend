# The control plane: Django, and nothing else.
#
# The base image is pinned by digest as well as by tag (docs/AUTH.md §12
# [ops-supply-3]): a tag is a name the registry can point somewhere else
# tomorrow, a digest is the image that was tested. To move, look the new
# one up with `docker buildx imagetools inspect python:3.12-slim` and change
# both halves.
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt ./
# --require-hashes: every package, gunicorn included, is pinned in
# requirements.txt with the sha256 of the files PyPI publishes for it, and a
# file that does not match does not install, whatever version it claims.
# Nothing is added on this line: the hash-checked install is all-or-nothing,
# so gunicorn is pinned in requirements.in with everything else rather than
# appended here unpinned.
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY . .

# The accounts live in Postgres, not in this image; the only thing written at
# runtime is the collected static tree, on a volume.
RUN useradd -m app && chown -R app:app /app
USER app

EXPOSE 8000
# --forwarded-allow-ips='*': trust X-Forwarded-* from any peer, because the
# only peer that can reach this port is the edge (docker-compose.prod.yml puts
# nothing else on the network), and the edge overwrites those headers on every
# request. Without it gunicorn would strip the scheme and every cookie would be
# set insecure behind TLS.
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "60", "--forwarded-allow-ips", "*"]
