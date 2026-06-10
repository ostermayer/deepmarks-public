# Custom Caddy image: stock caddy:2 plus the rate-limit plugin
# (github.com/mholt/caddy-ratelimit), which is not in the official image.
# Used to per-IP throttle public Blossom blob downloads so a single
# scraper can't drive sustained outbound on Box A.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
