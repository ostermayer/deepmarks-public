FROM node:22-bookworm

# Playwright needs system libraries for Chromium.
# mcr.microsoft.com/playwright images work but are larger; install
# the minimum ourselves to keep image size reasonable.
#
# yt-dlp + ffmpeg + python3 are pulled in for the YouTube archive add-on.
# yt-dlp comes from its GitHub release as a self-contained binary so we
# don't have to manage a pip install. ffmpeg is needed to mux the
# downloaded VP9 video + Opus audio into a single MKV file.
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
    xvfb \
  && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
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
