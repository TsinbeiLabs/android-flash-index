/**
 * Combined site + range-preserving CORS proxy for dl.google.com Android images.
 *
 * Deploy this once and it serves BOTH halves of the project:
 *
 *   /                        the website, from Workers static assets
 *   /__proxy-info            tells the page "the proxy is this same origin"
 *   /developers/android/...  proxied to dl.google.com, byte-exact ranges
 *
 * Serving the page and the proxy from one origin is the point: a same-origin
 * fetch needs no CORS at all, so a fork that runs `wrangler deploy` gets
 * in-browser extraction with zero configuration. When the site is instead served
 * from GitHub Pages, this worker still works as a standalone proxy and the page
 * asks the user for its URL.
 *
 * Why a proxy is needed at all: dl.google.com answers
 * `Access-Control-Allow-Origin` for exactly one origin,
 * https://flash.android.com. Every other origin gets no ACAO header, so a
 * browser cannot read those bytes. `Origin` is a forbidden header, so no client
 * side trick can work around it.
 *
 * The subtle part is content-coding. Browsers forbid setting Accept-Encoding,
 * so a client cannot ask for identity, and dl.google.com will gzip a .zip when
 * the client advertises gzip -- which shifts every byte offset and silently
 * produces a corrupt image. We ask the origin for identity AND verify that the
 * body length equals the requested range length, failing loudly if some layer
 * re-coded it. Verification buffers the body, so it only applies to ranges up to
 * VERIFY_LIMIT; larger ranges stream through unchecked.
 *
 * This is deliberately not a general-purpose proxy:
 *   - host is hardcoded to dl.google.com
 *   - only image paths under the allow-listed prefixes are served
 *   - GET and HEAD only, single range, capped
 * Deploy your own; do not point strangers at someone else's.
 *
 * Optional bindings (wrangler.toml / `wrangler secret put`):
 *   ALLOW_ORIGIN    exact origin to allow; default "*"
 *   ALLOW_REFERRER  if set, requests without this Referer/Origin prefix are refused
 */

const UPSTREAM = "https://dl.google.com";

/** Only these path prefixes are Android image trees. Everything else 404s, so a
 *  deployed worker cannot be turned into an open proxy for arbitrary Google URLs. */
export const ALLOWED_PREFIXES = ["/developers/android/", "/dl/android/"];

const VERIFY_LIMIT = 64 * 1024 * 1024;   // buffer+verify ranges up to 64 MiB
const MAX_RANGE = 512 * 1024 * 1024;     // refuse to serve more than 512 MiB

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  // we ask for identity explicitly and must not forward the client's preference
  "accept-encoding",
]);

/** Headers we always set ourselves, so they describe identity bytes. */
const OWNED_HEADERS = new Set(["content-length", "content-range", "accept-encoding"]);

export function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": (env && env.ALLOW_ORIGIN) || "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Accept-Encoding",
    // the client needs these to size the file and validate every range
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, Etag, Last-Modified",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(body, status, env, extra) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
      ...extra,
    },
  });
}

export function isAllowedPath(pathname) {
  return ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Normalise an incoming Range header to a single [start, end] pair.
 *
 * Multi-range responses (multipart/byteranges) are not supported: the client
 * would have to parse MIME boundaries for no benefit, and the ZIP reader only
 * ever asks for one contiguous span.
 *
 * @returns {{start:number,end:number}|{error:string}|{unsatisfiable:true}|null}
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return { error: "only a single 'bytes=start-end' range is supported" };

  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);

  if (start === null && end === null) return { error: "empty range" };
  if (start === null) {                       // suffix range: last N bytes
    if (end === 0) return { error: "empty range" };
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: "malformed range" };
  if (start < 0 || start > end || start >= size) return { unsatisfiable: true };
  if (end > size - 1) end = size - 1;
  if (end - start + 1 > MAX_RANGE) {
    return { error: `range larger than the ${MAX_RANGE / 2 ** 20} MiB cap` };
  }
  return { start, end };
}

/** Build the upstream URL for an allowed path. */
export function upstreamUrl(pathname, search) {
  return UPSTREAM + pathname + (search || "");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Self-description, so a page served from this same worker can detect that
    // the proxy is built in and default to same-origin with no configuration.
    if (url.pathname === "/__proxy-info") {
      return json({
        service: "android-flash-index",
        upstream: UPSTREAM,
        proxy: "self",
        origin: url.origin,
        allowedPrefixes: ALLOWED_PREFIXES,
        methods: ["GET", "HEAD"],
        maxRangeBytes: MAX_RANGE,
        verifiedUpToBytes: VERIFY_LIMIT,
      }, 200, env);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "only GET and HEAD are allowed" }, 405, env);
    }

    if (env && env.ALLOW_REFERRER) {
      const ref = request.headers.get("Referer") || request.headers.get("Origin") || "";
      if (!ref.startsWith(env.ALLOW_REFERRER)) {
        return json({ error: "referrer not allowed", expected: env.ALLOW_REFERRER }, 403, env);
      }
    }

    // Root: Workers static assets normally answer this with index.html before
    // the worker runs. This only shows when assets are not configured, i.e. the
    // worker was deployed as a bare proxy.
    if (url.pathname === "/" || url.pathname === "") {
      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({
        service: "android-image-proxy",
        upstream: UPSTREAM,
        usage: "GET /<path-on-dl.google.com>, e.g. /developers/android/CANARY/images/factory/x.zip",
        allowedPrefixes: ALLOWED_PREFIXES,
        probe: "/__proxy-info",
        note: "No static assets are bound, so this deployment is proxy-only.",
      }, 200, env);
    }

    if (!isAllowedPath(url.pathname)) {
      // Not an image path: hand it to the assets binding if there is one, so
      // unknown URLs still get the site's 404 rather than a JSON blob.
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "path not allowed", allowedPrefixes: ALLOWED_PREFIXES }, 404, env);
    }

    const target = upstreamUrl(url.pathname, url.search);

    // HEAD first: the true size is needed before any range can be validated.
    let head;
    try {
      head = await fetch(target, {
        method: "HEAD",
        headers: { "Accept-Encoding": "identity", "User-Agent": "android-image-proxy/1.0" },
      });
    } catch (e) {
      return json({ error: "upstream request failed", detail: String(e) }, 502, env);
    }
    if (!head.ok) {
      return json({ error: `upstream returned ${head.status}`, url: target },
        head.status >= 400 && head.status < 600 ? head.status : 502, env);
    }

    // x-identity-content-length is what dl.google.com reports alongside a coded
    // body; it is the only length that ZIP offsets can be computed from.
    const identityLength = Number(
      head.headers.get("x-identity-content-length") || head.headers.get("content-length") || "0");
    if (!identityLength) {
      return json({ error: "upstream did not report a length" }, 502, env);
    }

    const parsed = parseRange(request.headers.get("Range"), identityLength);
    if (parsed && parsed.error) return json({ error: parsed.error }, 400, env);
    if (parsed && parsed.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${identityLength}`, ...cors },
      });
    }

    const headers = new Headers();
    headers.set("Accept-Encoding", "identity");
    headers.set("User-Agent", "android-image-proxy/1.0");
    if (parsed) headers.set("Range", `bytes=${parsed.start}-${parsed.end}`);

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers,
      });
    } catch (e) {
      return json({ error: "upstream request failed", detail: String(e) }, 502, env);
    }

    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || OWNED_HEADERS.has(lk)) continue;
      out.set(k, v);
    }
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    out.set("Accept-Ranges", "bytes");

    if (request.method === "HEAD") {
      out.set("Content-Length", String(identityLength));
      return new Response(null, { status: 200, headers: out });
    }

    if (!parsed) {
      out.set("Content-Length", String(identityLength));
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    const wantLength = parsed.end - parsed.start + 1;

    if (wantLength <= VERIFY_LIMIT) {
      const buf = await upstream.arrayBuffer();
      if (buf.byteLength !== wantLength) {
        return json({
          error: "length mismatch after proxying",
          requested: wantLength,
          received: buf.byteLength,
          hint: "A layer between here and the origin re-encoded the body. "
              + "Byte-exact ranges are required or extracted images are corrupt.",
        }, 502, env);
      }
      out.set("Content-Length", String(buf.byteLength));
      out.set("Content-Range", `bytes ${parsed.start}-${parsed.end}/${identityLength}`);
      return new Response(buf, { status: 206, headers: out });
    }

    out.set("Content-Length", String(wantLength));
    out.set("Content-Range", `bytes ${parsed.start}-${parsed.end}/${identityLength}`);
    return new Response(upstream.body, { status: 206, headers: out });
  },
};
