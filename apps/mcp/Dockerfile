# Use Python 3.11 as base image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv for faster package management
COPY --from=ghcr.io/astral-sh/uv:0.12.21@sha256:a7aed3216253ee804de3e2d8afa5073baa1a177335345d43845cd4165e43b711 /uv /usr/local/bin/uv

# Copy dependency files and application code
COPY pyproject.toml ./
COPY uv.lock* ./
COPY plane_mcp/ ./plane_mcp/
COPY nexus_serve.py ./

# Install the package and dependencies using uv. pip>=26.2.2 replaces the base
# image's pip, whose vendored certifi still trusts the emSign ECC Root CA - G3.
RUN uv pip install --system --no-cache . "pip>=26.2.2"

# Expose port for HTTP transports (SSE, streamable-http, http)
EXPOSE 8211

# Set environment variables with defaults
ENV FASTMCP_PORT=8211

# Run as nobody. The server keeps no state on disk.
USER 65534:65534

# Header-auth streamable HTTP at /mcp (see nexus_serve.py). Upstream's
# `python -m plane_mcp stdio` still works for local use.
ENTRYPOINT ["python", "/app/nexus_serve.py"]

