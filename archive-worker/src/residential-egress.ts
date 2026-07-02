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
// Residential egress is a LAST-DITCH fallback: by default NOTHING is routed
// residential up front — a job uses the tunnel only as a final retry after the
// datacenter path has failed (opts.fallback), so the home line is used
// sparingly. RESIDENTIAL_ALWAYS_DOMAINS is an optional advanced override —
// hosts listed there skip straight to residential on the first try — and is
// EMPTY by default.
//
// Inert until RESIDENTIAL_EGRESS_SOURCE_IP is set, so shipping it is a no-op.

const DEFAULT_ALWAYS_DOMAINS: string[] = [];

/** The configured wg0 source IP, or undefined when the feature is off. */
export function residentialSourceIp(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ip = env.RESIDENTIAL_EGRESS_SOURCE_IP?.trim();
  return ip ? ip : undefined;
}

function alwaysResidentialDomains(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RESIDENTIAL_ALWAYS_DOMAINS?.trim();
  return (raw ? raw.split(',') : DEFAULT_ALWAYS_DOMAINS)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Source IP to bind this URL's egress to, or undefined for the normal
 *  datacenter path. Returns the residential wg0 IP when it is configured AND
 *  the host is always-residential (e.g. YouTube) or this is a fallback retry. */
export function residentialSourceIpFor(
  url: string,
  opts: { fallback?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const ip = residentialSourceIp(env);
  if (!ip) return undefined;
  if (opts.fallback) return ip;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return hostMatches(host, alwaysResidentialDomains(env)) ? ip : undefined;
}
