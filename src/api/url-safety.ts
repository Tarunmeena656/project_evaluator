import { isIP } from "node:net";

/**
 * SSRF guard for student-supplied URLs (live app URL, Drive links, videos).
 * Validation-time check: scheme, no credentials, no literal private/loopback
 * IPs, no obviously internal hostnames. Fetch-time check (production): resolve
 * DNS, re-check every resolved address, disable redirects or re-validate each
 * hop, and route through an egress proxy with a deny-list for RFC1918/169.254.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("credentials in URL are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("internal hostnames are not allowed");
  }
  if (isIP(host) && isPrivateAddress(host)) throw new Error("private or reserved IP addresses are not allowed");
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 100 && b >= 64 && b <= 127) || // carrier NAT
      a >= 224 // multicast / reserved
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") ||
    v6.startsWith("::ffff:") // IPv4-mapped; re-check the embedded v4 in production
  );
}
