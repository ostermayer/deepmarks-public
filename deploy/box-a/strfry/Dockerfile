# Build strfry from source. Single stage so we don't have to guess
# runtime package names (libflatbuffers's ABI-version suffix differs
# between Debian releases).

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git g++ make pkg-config libssl-dev zlib1g-dev libtool ca-certificates \
      libflatbuffers-dev libsecp256k1-dev libzstd-dev liblmdb-dev \
      build-essential automake \
      curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone https://github.com/hoytech/strfry.git . && \
    git submodule update --init && \
    make setup-golpe && \
    make -j$(nproc) && \
    cp strfry /usr/local/bin/strfry && \
    cd / && rm -rf /src

RUN mkdir -p /var/lib/strfry /opt/strfry-policies

# Install ioredis into the strfry-policies dir so the writePolicy plugin
# can require it. The plugin uses Redis to check whether the event's
# pubkey is registered with Deepmarks before accepting writes. ioredis
# stays self-contained in /opt/strfry-policies/node_modules — the
# plugin file itself (deepmarks.js) is bind-mounted from the host so
# operator edits don't require a rebuild.
WORKDIR /opt/strfry-policies
RUN npm init -y \
    && npm install --omit=dev ioredis@5 \
    && rm -f package.json package-lock.json

WORKDIR /
EXPOSE 7777
CMD ["strfry", "--config=/etc/strfry.conf", "relay"]
