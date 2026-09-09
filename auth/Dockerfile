# The control plane: Django, and nothing else.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt ./
# gunicorn is a deployment concern, not a dependency of the app, so it is
# installed here rather than added to requirements.txt.
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

# The database lives on a volume, not in the image. Baking it in would mean
# every deploy shipped a fresh empty one over the top of the real accounts.
#
# BOTH volume mountpoints are created here, and that is the whole point of the
# line rather than a tidiness habit: Docker creates a missing mountpoint as
# root, this container runs as `app`, and collectstatic into a root-owned
# /app/staticfiles fails with EACCES — which `set -e` in the deploy turns into a
# dead first deploy. The runner's Dockerfile says the same thing about
# /app/.ghostclick; staticfiles needed it too and did not have it.
RUN mkdir -p /app/db /app/staticfiles && useradd -m app && chown -R app:app /app
USER app

EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "60"]
