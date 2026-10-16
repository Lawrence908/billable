FROM python:3.12-alpine

WORKDIR /app
COPY server.py /app/server.py

ENV PORT=8000 \
    DATA_DIR=/app/data/mailboxes \
    PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["python", "/app/server.py"]
