/**
 * The credential host of `url`: its `host` (lowercase, with the port only when it is not 443), or
 * `null` when `url` is not https or carries a username or password. Only such a URL's host may
 * join the allowlist.
 * @lastreviewed null
 */
export function credentialHostOf(url: URL): string | null {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url.host === "" ? null : url.host;
}

/**
 * The host git asked about, in the form {@link credentialHostOf} gives, or `null` when it is not a
 * bare host (with an optional port). The value must already be in that form, apart from case and
 * an explicit `:443`: anything the URL parser would rewrite (an IPv4 shorthand, percent-escapes, an
 * empty port) or that is not a host at all (a path, a userinfo, whitespace) is refused rather than
 * normalized, so a lookalike can never normalize onto an allowed host. A trailing dot is kept, so
 * such a host never equals an allowed one.
 * @lastreviewed null
 */
export function requestedCredentialHost(host: string): string | null {
  const lowered = host.toLowerCase();
  // One host and at most one port, checked before the default port is dropped, so `host:8443:443` never becomes
  // `host:8443`.
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(lowered)) {
    return null;
  }
  const withoutDefaultPort = lowered.endsWith(":443") ? lowered.slice(0, -":443".length) : lowered;
  let parsed: URL;
  try {
    parsed = new URL(`https://${withoutDefaultPort}/`);
  } catch {
    return null;
  }
  const normalized = credentialHostOf(parsed);
  return normalized === withoutDefaultPort && parsed.pathname === "/" ? normalized : null;
}
