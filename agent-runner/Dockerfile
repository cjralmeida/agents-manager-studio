# Base image for agent containers: Claude Code CLI + git tooling.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=2.1.285
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force

# Versions are pinned by the image; agents must not update themselves.
ENV DISABLE_AUTOUPDATER=1

# Claude Code refuses to skip permissions as root, and agents should not run as root anyway.
USER node
WORKDIR /home/node
