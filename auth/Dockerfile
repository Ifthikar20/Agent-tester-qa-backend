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
RUN mkdir -p /app/db && useradd -m app && chown -R app:app /app
USER app

EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--timeout", "60"]
