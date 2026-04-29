FROM node:22-bookworm

# Playwright needs system libraries for Chromium.
# mcr.microsoft.com/playwright images work but are larger; install
# the minimum ourselves to keep image size reasonable.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
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
    xvfb \
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
