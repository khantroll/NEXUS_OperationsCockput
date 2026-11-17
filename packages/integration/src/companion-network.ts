import { isIP } from "node:net";

/**
 * How the companion is reachable.
 *  - local:   loopback only (default). Nothing else on the network can connect.
 *  - private: plain HTTP bound to ONE private address, meant for a Tailscale/WireGuard/LAN interface where the
 *             tunnel provides encryption. Peers outside private/CGNAT/loopback ranges are refused.
 *  - https:   TLS with a certificate you supply; for exposure beyond a private network (e.g. a third-party
 *             service or a public server). Authentication and rate limits still apply to every request.
 */
export type CompanionNetworkConfig =
  | { mode: "local"; port?: number }
  | { mode: "private"; bind?: string; port?: number; allowLan?: boolean }
  | { mode: "https"; bind?: string; port?: number; certFile: string; keyFile: string; publicHost: string };

export const defaultRemotePort = 47821;

export interface NetworkInterfaceLike {
  address: string;
  family: string | number;
  internal: boolean;
}

export type ParsedNetworkConfig = { config: CompanionNetworkConfig; error: null } | { config: null; error: string };

/** Parses `companion-network.json`. Anything invalid is an error (the caller falls back to local and says why). */
export function parseCompanionNetworkConfig(text: string): ParsedNetworkConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { config: null, error: "not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { config: null, error: "must be a JSON object" };
  const raw = value as Record<string, unknown>;
  const port = raw["port"];
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535)) {
    return { config: null, error: "port must be an integer 0-65535" };
  }
  const bind = raw["bind"];
  if (bind !== undefined && (typeof bind !== "string" || isIP(bind) === 0)) return { config: null, error: "bind must be an IP address" };
  const withPort = port === undefined ? {} : { port: port as number };
  switch (raw["mode"]) {
    case "local":
      if (bind !== undefined) return { config: null, error: "local mode always uses 127.0.0.1; remove bind or choose another mode" };
      return { config: { mode: "local", ...withPort }, error: null };
    case "private": {
      if (raw["allowLan"] !== undefined && typeof raw["allowLan"] !== "boolean") return { config: null, error: "allowLan must be true or false" };
      if (typeof bind === "string" && !isPrivateAddress(bind)) {
        return { config: null, error: "private mode needs a private/Tailscale/WireGuard address (10.x, 172.16-31.x, 192.168.x, 100.64-127.x, fc00::/7); use mode \"https\" to listen elsewhere" };
      }
      if (typeof bind === "string" && !isTunnelAddress(bind) && raw["allowLan"] !== true) {
        return { config: null, error: "bind " + bind + " is a plain LAN address: traffic (including the token) would be unencrypted. Use a Tailscale/WireGuard address, or set \"allowLan\": true if you accept that" };
      }
      return { config: { mode: "private", ...(typeof bind === "string" ? { bind } : {}), ...(raw["allowLan"] === true ? { allowLan: true } : {}), ...withPort }, error: null };
    }
    case "https": {
      const { certFile, keyFile, publicHost } = raw;
      if (typeof certFile !== "string" || !certFile || typeof keyFile !== "string" || !keyFile) return { config: null, error: "https mode needs certFile and keyFile" };
      if (typeof publicHost !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(publicHost)) {
        return { config: null, error: "https mode needs publicHost (the DNS name clients connect to)" };
      }
      return { config: { mode: "https", certFile, keyFile, publicHost, ...(typeof bind === "string" ? { bind } : {}), ...withPort }, error: null };
    }
    default:
      return { config: null, error: "mode must be \"local\", \"private\" or \"https\"" };
  }
}

/** Addresses a VPN overlay hands out (Tailscale CGNAT / ULA) or loopback: the tunnel encrypts traffic. WireGuard users on 10.x/192.168.x set allowLan. */
export function isTunnelAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number) as [number, number];
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  return normalized === "::1" || normalized.startsWith("fd7a:115c:a1e0:");
}

/** Loopback, RFC1918, CGNAT (100.64/10, which Tailscale uses), link-local and IPv6 ULA / link-local. */
export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split(".").map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (family === 6) {
    if (normalized === "::1") return true;
    const first = parseInt(normalized.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

/** May a peer at `remoteAddress` talk to a server in `mode`? (https accepts any peer; credentials and rate limits are the gate.) */
export function peerAllowed(mode: CompanionNetworkConfig["mode"], remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (mode === "https") return true;
  if (mode === "local") return isLoopbackAddress(remoteAddress);
  return isPrivateAddress(remoteAddress);
}

/** First Tailscale-range (100.64.0.0/10) IPv4 address on this machine, if any. */
export function detectTailscaleAddress(interfaces: Record<string, readonly NetworkInterfaceLike[] | undefined>): string | null {
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if ((entry.family === "IPv4" || entry.family === 4) && !entry.internal) {
        const [a, b] = entry.address.split(".").map(Number) as [number, number];
        if (a === 100 && b >= 64 && b <= 127) return entry.address;
      }
    }
  }
  return null;
}

export interface ResolvedBind {
  mode: CompanionNetworkConfig["mode"];
  bind: string;
  port: number;
}

/** Turns a config into a concrete bind address, auto-detecting the Tailscale address for private mode. */
export function resolveBind(config: CompanionNetworkConfig, interfaces: Record<string, readonly NetworkInterfaceLike[] | undefined>): ResolvedBind {
  if (config.mode === "local") return { mode: "local", bind: "127.0.0.1", port: config.port ?? 0 };
  const port = config.port ?? defaultRemotePort;
  if (config.mode === "private") {
    const bind = config.bind ?? detectTailscaleAddress(interfaces);
    if (!bind) throw new Error("private mode: no Tailscale (100.64.0.0/10) address found; set \"bind\" to your WireGuard/LAN address");
    return { mode: "private", bind, port };
  }
  return { mode: "https", bind: config.bind ?? "0.0.0.0", port };
}
