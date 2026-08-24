# Minimal WireGuard sidecar. The archive-worker runs in THIS container's
# network namespace (compose: network_mode "service:wg"), so the worker's
# safe-proxy can source-bind to the wg0 tunnel IP for the residential
# last-ditch retry. The config uses Table=off + a PostUp source rule, so ONLY
# traffic from that IP uses the tunnel; bgutil-provider, the 10.0.0.2 VPC, and
# the datacenter default path all stay on the compose network.
FROM alpine:3.20
RUN apk add --no-cache wireguard-tools iproute2 iptables bash
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
