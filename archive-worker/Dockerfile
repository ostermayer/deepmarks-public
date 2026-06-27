FROM node:22-bookworm

# Playwright needs system libraries for Chromium.
# mcr.microsoft.com/playwright images work but are larger; install
# the minimum ourselves to keep image size reasonable.
#
# yt-dlp + ffmpeg + python3 are pulled in for the YouTube archive add-on.
# yt-dlp is installed via pip into a venv (instead of the standalone binary)
# so the bgutil PO-token-provider plugin loads cleanly — YouTube now gates
# most formats behind a PO token, and the plugin fetches one from the
# bgutil-provider sidecar (see compose). ffmpeg muxes the VP9 + Opus streams.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    python3 \
    python3-pip \
    python3-venv \
    unzip \
    xvfb \
  && python3 -m venv /opt/ytdlp \
  && /opt/ytdlp/bin/pip install --no-cache-dir --upgrade yt-dlp bgutil-ytdlp-pot-provider \
  && ln -sf /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp \
  && chmod -R a+rX /opt/ytdlp \
  # deno: yt-dlp's default JS runtime for signature/nsig deciphering. Without
  # it yt-dlp warns and some YouTube formats/videos are unavailable; it's now
  # the deprecated-without path. Installed as a static binary on PATH so
  # yt-dlp auto-detects it.
  && curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
  && unzip -o /tmp/deno.zip -d /usr/local/bin \
  && chmod a+rx /usr/local/bin/deno \
  && rm -f /tmp/deno.zip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --omit=dev=false

# Install Chromium to a shared path the non-root worker user can read.
# Without PLAYWRIGHT_BROWSERS_PATH, the install lands in /root/.cache and
# the runtime `worker` user can't see it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN mkdir -p /opt/playwright \
 && npx playwright install chromium \
 && chmod -R a+rX /opt/playwright

COPY src ./src
RUN npm run build

# Drop privileges.
RUN groupadd --system --gid 1001 worker \
  && useradd --system --uid 1001 --gid worker worker \
  && mkdir -p /home/worker && chown -R worker:worker /app /home/worker
USER worker
ENV HOME=/home/worker

CMD ["node", "dist/index.js"]
