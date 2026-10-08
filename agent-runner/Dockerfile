# Base image for agent containers: Claude Code CLI, Agent SDK runner, git and the Python toolchain.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
    python3 python3-pip python3-venv python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

# Agents run as "node" without sudo: pip installs go to ~/.local (or a project venv).
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PATH=/home/node/.local/bin:$PATH

ARG CLAUDE_CODE_VERSION=2.1.285
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force

# Versions are pinned by the image; agents must not update themselves.
ENV DISABLE_AUTOUPDATER=1

WORKDIR /opt/runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY spike ./spike
COPY src ./src

# Claude Code refuses to skip permissions as root, and agents should not run as root anyway.
USER node
# Created as "node" so a volume mounted here inherits the right owner.
RUN mkdir -p /home/node/.claude
WORKDIR /home/node
