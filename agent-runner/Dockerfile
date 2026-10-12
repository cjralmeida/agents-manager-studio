# Base image for agent containers: Claude Code CLI, Agent SDK runner, git and the toolchains of the user's backends
# (Node.js/TypeScript, Python, Go, Java + Maven; Gradle projects use their own ./gradlew).
FROM golang:1.25-bookworm AS go
FROM maven:3.9-eclipse-temurin-21 AS java
FROM eclipse-temurin:11-jdk AS java11

FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
    python3 python3-pip python3-venv python-is-python3 python3-pil postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# Game audio made by code: synthesis (numpy/scipy), MIDI rendering with a General MIDI soundfont, and encoding.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fluidsynth fluid-soundfont-gm python3-numpy python3-scipy \
  && rm -rf /var/lib/apt/lists/*

# Go, JDK 21 and Maven come from their official images.
COPY --from=go /usr/local/go /usr/local/go
COPY --from=java /opt/java/openjdk /opt/java/openjdk
# Older Java projects (Java 8-11, e.g. Spring 4) build with JAVA_HOME=/opt/java/jdk11.
COPY --from=java11 /opt/java/openjdk /opt/java/jdk11
COPY --from=java /usr/share/maven /usr/share/maven
ENV JAVA_HOME=/opt/java/openjdk \
  MAVEN_HOME=/usr/share/maven \
  GOPATH=/home/node/go \
  PATH=/usr/local/go/bin:/home/node/go/bin:/opt/java/openjdk/bin:/usr/share/maven/bin:$PATH

# Agents run as "node" without sudo: pip installs go to ~/.local (or a project venv).
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PATH=/home/node/.local/bin:$PATH

ARG CLAUDE_CODE_VERSION=2.1.285
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force

# Playwright with Chromium for black-box tests in homologation. Test folders link /opt/playwright/node_modules,
# so no run downloads browsers.
ARG PLAYWRIGHT_VERSION=1.55.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers
RUN mkdir -p /opt/playwright && cd /opt/playwright \
  && npm init -y > /dev/null \
  && npm install @playwright/test@${PLAYWRIGHT_VERSION} \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /opt/playwright

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
