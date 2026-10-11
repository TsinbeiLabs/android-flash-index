/* Minimal ZIP reader over a Blob/File, for pulling single partition images out
 * of a multi-gigabyte Android factory zip without unpacking it.
 *
 * Why this exists rather than a library: a factory zip is ~4-15 GB but the thing
 * people actually want is init_boot.img (~8 MB). The inner `image-*.zip` is
 * STORED (method 0) inside the outer zip, so its bytes sit verbatim at a
 * computable offset and the whole extraction is a handful of slice() reads:
 *
 *   outer central directory -> inner zip offset -> inner central directory
 *   -> entry offset -> slice + inflate-raw -> Blob
 *
 * Everything is random access; nothing is ever fully buffered.
 *
 * The `blob` argument only needs `.size` and `.slice(start, end)` returning
 * something with `.arrayBuffer()`, so it works equally on a File, a Blob, or a
 * range-request-backed shim (which is how the tests read a real 4 GB factory
 * zip over HTTP without downloading it).
 *
 * ZIP64 is implemented because Pixel 11 factory images exceed 4 GB.
 */
"use strict";

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/* Refuse to materialise anything bigger than this in memory. The partitions
 * worth extracting (init_boot, boot, vendor_boot, dtbo, vbmeta) are <= 64 MiB;
 * product.img alone is 4.6 GiB and would take the tab down. */
export const MAX_EXTRACT_BYTES = 1024 * 1024 * 1024; // 1 GiB

/* How much of the tail to scan for the EOCD. The record is 22 bytes plus a
 * comment of at most 65535 bytes. */
const EOCD_SCAN = 66 * 1024;
const CD_FETCH_CHUNK = 4 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipError";
  }
}

/* ------------------------------------------------------------------- crc32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, seed = 0) {
  const b = new Uint8Array(buf);
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------- primitives */

async function readSlice(blob, start, end) {
  const lo = Math.max(0, start);
  const hi = Math.min(blob.size, end);
  if (hi <= lo) return new ArrayBuffer(0);
  return blob.slice(lo, hi).arrayBuffer();
}

function findSignature(buf, sig, fromEnd = true) {
  const v = new Uint8Array(buf);
  const needle = [sig & 0xff, (sig >>> 8) & 0xff, (sig >>> 16) & 0xff, (sig >>> 24) & 0xff];
  if (fromEnd) {
    for (let i = v.length - 4; i >= 0; i--) {
      if (v[i] === needle[0] && v[i + 1] === needle[1]
        && v[i + 2] === needle[2] && v[i + 3] === needle[3]) return i;
    }
    return -1;
  }
  for (let i = 0; i + 4 <= v.length; i++) {
    if (v[i] === needle[0] && v[i + 1] === needle[1]
      && v[i + 2] === needle[2] && v[i + 3] === needle[3]) return i;
  }
  return -1;
}

/** Parse zip64 extra field 0x0001. Values appear in the order
 *  uncompressed, compressed, local-header-offset, disk — but only for the
 *  fields that were set to 0xFFFFFFFF, so callers must consume in that order. */
function zip64Extra(extra, need) {
  const v = new Uint8Array(extra);
  let p = 0;
  while (p + 4 <= v.length) {
    const id = v[p] | (v[p + 1] << 8);
    const sz = v[p + 2] | (v[p + 3] << 8);
    if (id === 0x0001) {
      const out = [];
      const dv = new DataView(extra);
      for (let q = p + 4; q + 8 <= p + 4 + sz && out.length < need; q += 8) {
        out.push(dv.getUint32(q, true) + dv.getUint32(q + 4, true) * 4294967296);
      }
      return out;
    }
    p += 4 + sz;
  }
  return [];
}

/* ------------------------------------------------------------------- EOCD  */

async function readEocd(blob) {
  const tail = Math.min(EOCD_SCAN, blob.size);
  const buf = await readSlice(blob, blob.size - tail, blob.size);
  const at = findSignature(buf, EOCD_SIG);
  if (at < 0) throw new ZipError("not a ZIP file (no end-of-central-directory)");
  const dv = new DataView(buf);
  let count = dv.getUint16(at + 10, true);
  let cdSize = dv.getUint32(at + 12, true);
  let cdOffset = dv.getUint32(at + 16, true);

  // ZIP64: 0xFFFFFFFF / 0xFFFF sentinels mean "look in the zip64 EOCD"
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = findSignature(buf, ZIP64_LOCATOR_SIG);
    if (loc < 0) throw new ZipError("ZIP64 archive but no zip64 locator");
    const z64off = dv.getUint32(loc + 8, true) + dv.getUint32(loc + 12, true) * 4294967296;
    const zbuf = await readSlice(blob, z64off, z64off + 56);
    const zdv = new DataView(zbuf);
    if (findSignature(zbuf, ZIP64_EOCD_SIG, false) !== 0) {
      throw new ZipError("bad zip64 EOCD signature");
    }
    const rd64 = (o) => zdv.getUint32(o, true) + zdv.getUint32(o + 4, true) * 4294967296;
    count = Number(rd64(32));
    cdSize = Number(rd64(40));
    cdOffset = Number(rd64(48));
  }
  return { count, cdSize, cdOffset };
}

/* -------------------------------------------------------- central directory */

async function readCentralDir(blob) {
  const { count, cdSize, cdOffset } = await readEocd(blob);
  if (cdOffset + cdSize > blob.size) {
    throw new ZipError("central directory extends past end of file");
  }
  const entries = [];
  // Fetch in chunks: a 15 GB image's CD is small, but be safe anyway.
  for (let off = 0; off < cdSize; off += CD_FETCH_CHUNK) {
    const buf = await readSlice(blob, cdOffset + off,
      cdOffset + Math.min(off + CD_FETCH_CHUNK, cdSize));
    const dv = new DataView(buf);
    let p = 0;
    while (p + 46 <= buf.byteLength) {
      if (dv.getUint32(p, true) !== CD_SIG) break;
      const method = dv.getUint16(p + 10, true);
      const flags = dv.getUint16(p + 8, true);
      const crc = dv.getUint32(p + 16, true);
      let csize = dv.getUint32(p + 20, true);
      let usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      let lho = dv.getUint32(p + 42, true);

      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
      const extra = buf.slice(p + 46 + nlen, p + 46 + nlen + elen);

      const need = [usize, csize, lho].filter((x) => x === 0xffffffff).length;
      if (need) {
        const big = zip64Extra(extra, need);
        let i = 0;
        if (usize === 0xffffffff) usize = big[i++];
        if (csize === 0xffffffff) csize = big[i++];
        if (lho === 0xffffffff) lho = big[i++];
      }

      entries.push({
        name, method, flags, crc, csize, usize, lho,
        dir: name.endsWith("/"),
      });
      p += 46 + nlen + elen + clen;
      if (entries.length >= count && count) break;
    }
  }
  if (!entries.length) throw new ZipError("ZIP has no readable entries");
  return entries;
}

/** Absolute offset where an entry's (possibly compressed) data begins. */
async function dataOffset(blob, entry) {
  const buf = await readSlice(blob, entry.lho, entry.lho + 30);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== LFH_SIG) {
    throw new ZipError(`bad local header for ${entry.name}`);
  }
  const nlen = dv.getUint16(26, true);
  const elen = dv.getUint16(28, true);
  return entry.lho + 30 + nlen + elen;
}

/* ------------------------------------------------------------ inflate-raw */

async function inflateRaw(blobSlice) {
  if (typeof DecompressionStream !== "function") {
    throw new ZipError("this browser has no DecompressionStream; use Chrome 103+");
  }
  const ds = new DecompressionStream("deflate-raw");
  const out = await new Response(blobSlice.stream().pipeThrough(ds)).arrayBuffer();
  return out;
}

/* ------------------------------------------------------------------ public */

/** A view onto a byte range of another blob, so a nested ZIP can be read as if
 *  it were its own file. */
function subBlob(blob, base, size) {
  return {
    size,
    slice: (a, b) => blob.slice(base + a, base + (b === undefined ? size : b)),
  };
}

/**
 * Open a factory zip or a plain image zip and return its partition entries.
 * Transparently descends into the STORED inner `image-*.zip` of a factory zip.
 *
 * @returns {{entries: object[], view: object, nested: boolean, innerName: string|null}}
 */
export async function openImageZip(blob) {
  let entries = await readCentralDir(blob);
  let view = blob;
  let nested = false;
  let innerName = null;

  // A factory zip holds exactly one `image-*.zip`; descend into it.
  const inner = entries.find((e) => !e.dir && /(?:^|\/)image-[^/]*\.zip$/i.test(e.name));
  if (inner) {
    if (inner.method !== METHOD_STORED) {
      throw new ZipError(
        `the inner ${inner.name} is compressed (method ${inner.method}); `
        + "factory images are expected to store it uncompressed");
    }
    const off = await dataOffset(blob, inner);
    innerName = inner.name;
    view = subBlob(blob, off, inner.usize);
    entries = await readCentralDir(view);
    nested = true;
  }

  return { entries: entries.filter((e) => !e.dir), view, nested, innerName };
}

/**
 * Extract one entry to a Blob, verifying CRC-32 and length.
 *
 * @param {object} view  the blob the entry was listed from (openImageZip().view)
 * @param {object} entry an entry from openImageZip().entries
 */
export async function extractEntry(view, entry, onProgress) {
  if (entry.usize > MAX_EXTRACT_BYTES) {
    throw new ZipError(
      `${entry.name} is ${(entry.usize / 2 ** 30).toFixed(2)} GiB uncompressed, `
      + `over the ${(MAX_EXTRACT_BYTES / 2 ** 30).toFixed(0)} GiB in-browser limit. `
      + "Extract that one with 7-Zip/unzip instead.");
  }
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw new ZipError(`${entry.name}: unsupported compression method ${entry.method}`);
  }
  if (entry.usize === 0) {
    throw new ZipError(`${entry.name} is empty`);
  }
  // A data descriptor (flag bit 3) means the local header has no sizes, but we
  // already took them from the central directory, so this is fine either way.

  const start = await dataOffset(view, entry);
  const end = start + entry.csize;
  if (end > view.size) {
    throw new ZipError(`${entry.name}: data extends past end of archive`);
  }
  onProgress && onProgress(0.1, `reading ${entry.name}`);

  let raw;
  if (entry.method === METHOD_STORED) {
    raw = await readSlice(view, start, end);
  } else {
    onProgress && onProgress(0.35, `inflating ${entry.name}`);
    raw = await inflateRaw(view.slice(start, end));
  }

  if (raw.byteLength !== entry.usize) {
    throw new ZipError(
      `${entry.name}: expected ${entry.usize} bytes, got ${raw.byteLength}`);
  }
  onProgress && onProgress(0.85, `verifying ${entry.name}`);
  const got = crc32(raw);
  if (entry.crc !== 0 && got !== entry.crc) {
    throw new ZipError(
      `${entry.name}: CRC mismatch (expected ${entry.crc.toString(16)}, `
      + `got ${got.toString(16)}) — the file is probably truncated`);
  }
  onProgress && onProgress(1, `done ${entry.name}`);
  return new Blob([raw], { type: "application/octet-stream" });
}

/** Human-readable partition name for an entry: strips any directory prefix.
 *  Takes the entry's `name` string, not the entry itself. */
export function entryLabel(name) {
  return String(name ?? "").split("/").pop();
}

/* ------------------------------------------------------- remote (range) I/O */

/**
 * A Blob-like view over a remote file, read with HTTP Range requests.
 *
 * This is what makes it possible to pull an 8 MiB init_boot.img out of a 4 GiB
 * factory zip without downloading it: the reader only ever touches the central
 * directory and the one entry it needs.
 *
 * Two things have to be true of the server, and both are the reason a
 * self-hosted proxy is recommended over hitting dl.google.com directly:
 *
 *   1. It must answer `Range` with `206` and a correct `Content-Range`.
 *   2. It must not content-code the body. Browsers forbid setting
 *      `Accept-Encoding`, so a client cannot ask for identity. dl.google.com
 *      will happily gzip a .zip when the client advertises gzip, which shifts
 *      every offset and silently corrupts the result. Every read here therefore
 *      asserts that the byte count came back exactly as requested, so a coded
 *      response fails loudly instead of producing a bad image.
 *
 * The returned object only exposes `.size` and `.slice()`, which is all
 * openImageZip/extractEntry use, so a File and a remote zip are interchangeable.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {function(string, number): (string|URL)} [opts.rewrite]
 *        map a URL to the one actually fetched, e.g. to route through a proxy
 * @param {function(number): void} [opts.onBytes] called with each read length
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function httpBlob(url, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const rewrite = opts.rewrite || ((u) => u);
  const onBytes = opts.onBytes || (() => {});

  async function get(start, end) {
    const res = await doFetch(rewrite(url), {
      headers: { Range: `bytes=${start}-${end - 1}` },
      cache: "no-store",
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new ZipError(`HTTP ${res.status} reading bytes ${start}-${end - 1} of ${url}`);
    }
    const buf = await res.arrayBuffer();
    const want = end - start;
    if (buf.byteLength !== want) {
      throw new ZipError(
        `range ${start}-${end - 1} returned ${buf.byteLength} bytes, expected ${want}. `
        + "The server probably applied a content-coding (gzip/br) to the response, "
        + "which shifts every offset. Serve it through a proxy that requests "
        + "identity encoding upstream.");
    }
    onBytes(buf.byteLength);
    return { buf, res };
  }

  // Size probe: one byte is enough, the total rides along in Content-Range.
  const first = await get(0, 1);
  let size = null;
  const cr = first.res.headers.get("content-range");
  const m = cr && cr.match(/\/(\d+)\s*$/);
  if (m) size = Number(m[1]);
  if (!size || !Number.isFinite(size)) {
    const cl = first.res.headers.get("content-length");
    if (first.res.status === 200 && cl) size = Number(cl);
  }
  if (!size || !Number.isFinite(size)) {
    throw new ZipError(
      "could not determine the remote file size; the server did not return a "
      + "usable Content-Range. Range requests may be unsupported or blocked by CORS.");
  }

  return {
    size,
    remote: true,
    url,
    slice(start, end) {
      const lo = Math.max(0, start);
      const hi = Math.min(size, end === undefined ? size : end);
      const chunk = {
        size: Math.max(0, hi - lo),
        async arrayBuffer() {
          if (hi <= lo) return new ArrayBuffer(0);
          return (await get(lo, hi)).buf;
        },
        stream() {
          return new ReadableStream({
            async start(controller) {
              controller.enqueue(new Uint8Array(await chunk.arrayBuffer()));
              controller.close();
            },
          });
        },
      };
      return chunk;
    },
  };
}

/**
 * Turn a dl.google.com image URL into one served by a reverse proxy.
 *
 * The proxy exists because dl.google.com answers `Access-Control-Allow-Origin`
 * only for https://flash.android.com, so no other origin can read those bytes
 * from a browser. A worker that forwards the request and adds a permissive
 * header fixes that -- and can also force identity encoding upstream.
 *
 * @param {string} url   absolute image URL
 * @param {string} base  proxy base, with or without a trailing slash
 */
export function proxify(url, base) {
  if (!base) return url;
  const b = base.trim().replace(/\/+$/, "");
  if (!b) return url;
  const u = new URL(url);
  return `${b}${u.pathname}${u.search}`;
}
