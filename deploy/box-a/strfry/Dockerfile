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
# Pinned deliberately — an unpinned master clone made every deploy a
# potential surprise strfry upgrade, incl. LMDB schema bumps
# mid-incident. Bump with intent, nightly restore-test as pre-flight.
#
# 37f2812 = tag 1.1.1 (2026-07-21) + the WSConnection reconnect-stall
# fix (#252, 2026-08-01) that hardens `strfry router`/`strfry sync` —
# our replication path. Over the previous pin (1461e6b, 1.1.0-81) this
# also picks up two crash-class fixes: a golpe bump for a uWebSockets
# memory fix, and an out-of-bounds read on empty tag values in
# client-supplied filter sets — the leading suspect for the sporadic
# libc GPF segfaults the relay showed Jun–Aug 2026
# (docs/incidents/2026-08-04-strfry-replica-stale-sidecar-strand.md).
# No LMDB/DB-format changes in the 1461e6b..37f2812 range.
#
# MAKE_JOBS: -j$(nproc) has OOMed Box A (8GB/4-core) during deploys.
# -j2 keeps the compile inside the box's memory headroom; override with
# --build-arg MAKE_JOBS= on a beefier builder.
ARG MAKE_JOBS=2
RUN git clone https://github.com/hoytech/strfry.git . \
    && git checkout 37f2812 && \
    git submodule update --init && \
    make setup-golpe && \
    make -j${MAKE_JOBS} && \
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
