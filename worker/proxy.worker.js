/**
 * Range-preserving CORS proxy for dl.google.com Android images.
 *
 * Why this is needed: dl.google.com answers `Access-Control-Allow-Origin` only
 * for https://flash.android.com. Every other origin gets no ACAO header, so a
 * browser cannot read those bytes at all -- which is the only thing stopping the
 * site from pulling an 8 MiB init_boot.img out of a 4 GiB factory zip with a
 * handful of range requests.
 *
 * This is deliberately narrow. It is not a general-purpose proxy:
 *   - host is hardcoded to dl.google.com
 *   - only image paths under /developers/android/ and /dl/android/ are served
 *   - only GET and HEAD
 *   - ranges are capped
 * Deploy your own; do not point strangers at someone else's.
 *
 * The subtle part is content-coding. Browsers forbid setting Accept-Encoding,
 * so a client cannot ask for identity, and dl.google.com will gzip a .zip if
 * the client advertises gzip -- which shifts every byte offset and silently
 * produces a corrupt image. We ask the origin for identity AND verify that the
 * body length equals the requested range length, failing loudly if some layer
 * re-coded it. Verification buffers the body, so it is only done for ranges up
 * to VERIFY_LIMIT; larger ranges stream through unchecked.
 *
 * Deploy:
 *   npm i -g wrangler
 *   wrangler deploy            # from the worker/ directory
 * then put the printed https://<name>.<subdomain>.workers.dev URL into the
 * site's "Reverse proxy" field.
 *
 * Optional bindings (wrangler.toml / dashboard):
 *   ALLOW_ORIGIN   exact origin to allow, e.g. https://you.github.io
 *                  (default "*", which is fine for a single-user proxy)
 *   ALLOW_REFERRER if set, requests without this referrer prefix are refused
 */

const UPSTREAM = "https://dl.google.com";

// Only these path prefixes are Android image trees. Everything else 404s, so a
// deployed worker cannot be turned into an open proxy for arbitrary Google URLs.
const ALLOWED_PREFIXES = ["/developers/android/", "/dl/android/"];

const VERIFY_LIMIT = 64 * 1024 * 1024;   // buffer+verify ranges up to 64 MiB
const MAX_RANGE = 512 * 1024 * 1024;     // refuse to serve more than 512 MiB
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  // let the runtime/origin negotiate encoding; we ask for identity explicitly
  "accept-encoding",
]);

function corsHeaders(env) {
  const origin = (env && env.ALLOW_ORIGIN) || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Accept-Encoding",
    // the client needs these to size the file and validate each range
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, Etag, Last-Modified",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, env, extra) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env), ...extra },
  });
}

/**
 * Normalise an incoming Range header to a single [start, end] pair.
 * Multi-range responses (multipart/byteranges) are not supported because the
 * client would then have to parse MIME boundaries for no benefit.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { error: "only a single 'bytes=start-end' range is supported" };
  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);

  if (start === null && end === null) return { error: "empty range" };
  if (start === null) {                       // suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: "malformed range" };
  if (start > end || start >= size) return { unsatisfiable: true };
  if (end > size - 1) end = size - 1;
  if (end - start + 1 > MAX_RANGE) {
    return { error: `range larger than the ${MAX_RANGE / 2 ** 20} MiB cap` };
  }
  return { start, end };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "only GET and HEAD are allowed" }, 405, env);
    }

    // Optional referrer gate, for people who would rather not run an open relay
    if (env && env.ALLOW_REFERRER) {
      const ref = request.headers.get("Referer") || request.headers.get("Origin") || "";
      if (!ref.startsWith(env.ALLOW_REFERRER)) {
        return json({ error: "referrer not allowed", expected: env.ALLOW_REFERRER }, 403, env);
      }
    }

    if (url.pathname === "/" || url.pathname === "") {
      return json({
        service: "android-image-proxy",
        upstream: UPSTREAM,
        usage: "GET /<path-on-dl.google.com>, e.g. /developers/android/CANARY/images/factory/x.zip",
        allowedPrefixes: ALLOWED_PREFIXES,
        methods: ["GET", "HEAD"],
        maxRangeBytes: MAX_RANGE,
      }, 200, env);
    }

    if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return json({
        error: "path not allowed",
        allowedPrefixes: ALLOWED_PREFIXES,
      }, 404, env);
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    // HEAD first: we need the true size before we can validate any range.
    let head;
    try {
      head = await fetch(upstreamUrl, {
        method: "HEAD",
        headers: { "Accept-Encoding": "identity", "User-Agent": "android-image-proxy/1.0" },
      });
    } catch (e) {
      return json({ error: "upstream request failed", detail: String(e) }, 502, env);
    }
    if (!head.ok) {
      return json({ error: `upstream returned ${head.status}`, url: upstreamUrl }, head.status || 502, env);
    }

    const identityLength = Number(
      head.headers.get("x-identity-content-length") || head.headers.get("content-length") || "0");
    if (!identityLength) {
      return json({ error: "upstream did not report a length" }, 502, env);
    }

    const rangeHeader = request.headers.get("Range");
    const parsed = parseRange(rangeHeader, identityLength);
    if (parsed && parsed.error) return json({ error: parsed.error }, 400, env);
    if (parsed && parsed.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${identityLength}`, ...corsHeaders(env) },
      });
    }

    const headers = new Headers();
    headers.set("Accept-Encoding", "identity");
    headers.set("User-Agent", "android-image-proxy/1.0");
    if (parsed) headers.set("Range", `bytes=${parsed.start}-${parsed.end}`);

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers,
      });
    } catch (e) {
      return json({ error: "upstream request failed", detail: String(e) }, 502, env);
    }

    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      // we set these ourselves so they always describe identity bytes
      if (lk === "content-length" || lk === "content-range" || lk === "accept-encoding") continue;
      out.set(k, v);
    }
    for (const [k, v] of Object.entries(corsHeaders(env))) out.set(k, v);
    out.set("Accept-Ranges", "bytes");

    if (request.method === "HEAD") {
      out.set("Content-Length", String(identityLength));
      return new Response(null, { status: 200, headers: out });
    }

    if (!parsed) {
      // whole-file GET: stream, and let the origin's length stand
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
