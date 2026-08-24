#!/bin/bash
# Bring up wg0 from the mounted config and KEEP the container alive so the
# shared network namespace persists for the archive-worker. Tolerate a tunnel
# failure: the worker must keep its datacenter connectivity (bgutil / VPC /
# default) even when the residential tunnel is down — only the last-ditch
# residential retry is affected.
set -u
CONF=/etc/wireguard/wg0.conf

peer_pubkey()   { sed -nE 's/^[[:space:]]*PublicKey[[:space:]]*=[[:space:]]*([A-Za-z0-9+/=]+).*/\1/p' "$CONF" | head -1; }
peer_endpoint() { sed -nE 's/^[[:space:]]*Endpoint[[:space:]]*=[[:space:]]*([^[:space:]]+).*/\1/p'     "$CONF" | head -1; }

# Re-resolve the DDNS endpoint and update the peer. WireGuard resolves the
# endpoint hostname only ONCE at bring-up, so a dynamic home IP (uhef6c7.glddns
# .com) would otherwise leave the tunnel pinned to a stale address after an ISP
# lease change. `wg set ... endpoint host:port` re-runs the DNS lookup.
reresolve() {
  local pub ep
  pub=$(peer_pubkey); ep=$(peer_endpoint)
  [ -n "$pub" ] && [ -n "$ep" ] || return 0
  if wg set wg0 peer "$pub" endpoint "$ep" 2>/dev/null; then
    echo "wg-sidecar: re-resolved endpoint $ep"
  else
    echo "wg-sidecar: re-resolve failed for $ep"
  fi
}

up() {
  if [ -s "$CONF" ]; then
    wg-quick up wg0 && echo "wg-sidecar: tunnel up" || echo "wg-sidecar: wg-quick up failed — running without tunnel"
  else
    echo "wg-sidecar: no usable $CONF — running without tunnel (datacenter only)"
  fi
}

term() { wg-quick down wg0 2>/dev/null; exit 0; }
trap term TERM INT

up

# Watchdog: keep the shared netns alive; re-up if wg0 vanishes; and re-resolve
# the DDNS endpoint whenever the handshake goes stale (home IP changed), so the
# residential tunnel self-heals within a minute or two of a new WAN IP.
while :; do
  sleep 30
  [ -s "$CONF" ] || continue
  if ! ip link show wg0 >/dev/null 2>&1; then
    echo "wg-sidecar: wg0 missing — re-upping"
    wg-quick up wg0 2>/dev/null || true
    continue
  fi
  last=$(wg show wg0 latest-handshakes 2>/dev/null | awk 'NR==1{print $2}')
  [ -n "$last" ] || last=0
  now=$(date +%s)
  if [ "$(( now - last ))" -gt 150 ]; then
    echo "wg-sidecar: handshake stale/absent (age $(( now - last ))s) — re-resolving DDNS"
    reresolve
  fi
done
