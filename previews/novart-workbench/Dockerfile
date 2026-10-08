FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home app
COPY --chown=app:app harness /app/harness
COPY --chown=app:app originals /app/originals
COPY --chown=app:app evidence /app/evidence
COPY --chown=app:app print_review_link.py /app/print_review_link.py
COPY --chown=app:app PACKAGE_MANIFEST.json /app/PACKAGE_MANIFEST.json
RUN mkdir -p /app/sharing && chown app:app /app/sharing
USER app
ENV PYTHONUNBUFFERED=1 PYTHONUTF8=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8769
VOLUME ["/app/sharing"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8769/healthz', timeout=3).read()"
CMD ["python", "harness/share_runtime.py", "--host", "0.0.0.0", "--port", "8769", "--room", "preview"]
