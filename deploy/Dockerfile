# syntax=docker/dockerfile:1

# ---- 1. build the React/Vite frontend ----
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build          # outputs /fe/dist

# ---- 2. python runtime: serves the API + the built SPA (single origin) ----
FROM python:3.13-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
COPY --from=frontend /fe/dist ./frontend_dist
ENV TW_FRONTEND_DIR=/app/frontend_dist
EXPOSE 8000
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "8000"]
