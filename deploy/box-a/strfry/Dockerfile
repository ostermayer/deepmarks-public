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

EXPOSE 7777
CMD ["strfry", "--config=/etc/strfry.conf", "relay"]
