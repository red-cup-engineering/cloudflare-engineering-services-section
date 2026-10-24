import { canonicalLocation } from "./canonical-host.mjs";

export default {
  fetch(request) {
    const location = canonicalLocation(request.url);
    return location
      ? new Response(null, { status: 308, headers: { location, "cache-control": "public, max-age=86400" } })
      : new Response("not an alias host\n", { status: 421 });
  },
};
