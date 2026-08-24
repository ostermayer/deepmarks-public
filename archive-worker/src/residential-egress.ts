// Selective residential egress.
//
// Most archiving uses Box B's datacenter IP — cheap and fast. But some sites
// (YouTube above all) bot-wall datacenter ranges no matter what cookies we
// hold. For those, we route just that job's outbound traffic out a *residential*
// IP via a WireGuard tunnel, by binding the outbound socket to the wg0 source
// address (RESIDENTIAL_EGRESS_SOURCE_IP); a Box B source route then sends only
// packets from that address through the tunnel. The datacenter IP stays the
// default for everything else.
//
// Residential egress is a LAST-DITCH fallback: nothing is routed residential
// up front — a job uses the tunnel only as a final retry after the datacenter
// path has failed (see youtube.ts), so the home line is used sparingly.
//
// Inert until RESIDENTIAL_EGRESS_SOURCE_IP is set, so shipping it is a no-op.

/** The configured wg0 source IP, or undefined when the feature is off. */
export function residentialSourceIp(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ip = env.RESIDENTIAL_EGRESS_SOURCE_IP?.trim();
  return ip ? ip : undefined;
}
