# The control plane: Django, and nothing else.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt ./
# gunicorn is a deployment concern, not a dependency of the app, so it is
# installed here rather than added to requirements.txt.
RUN pip install --no-cache-dir -r requirements.txt gunicorn

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
