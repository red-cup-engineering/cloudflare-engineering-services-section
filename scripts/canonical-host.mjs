// The rule: a host with exactly two labels is an apex someone may type with
// "www." in front. That alias must land on the apex, so the estate alone
// decides which routes the redirect worker owns.
export function wwwAliases(hosts) {
  return [...new Set(hosts.filter((host) => typeof host === "string" && host.split(".").length === 2))]
    .sort()
    .map((apex) => Object.freeze({ alias: `www.${apex}`, apex, route: `www.${apex}/*` }));
}

export function estateHosts(estate) {
  return [...new Set([...(estate?.nodes ?? []), ...(estate?.doors ?? [])].map((entry) => entry?.host).filter(Boolean))];
}

export function canonicalLocation(requestUrl) {
  const url = new URL(requestUrl);
  if (!url.hostname.startsWith("www.")) return null;
  url.hostname = url.hostname.slice(4);
  url.protocol = "https:";
  return url.toString();
}
