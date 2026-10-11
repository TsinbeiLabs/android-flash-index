# Worker: site + proxy in one deployment

`wrangler deploy` in this directory publishes **both** halves of the project:

| Route | Served by |
|---|---|
| `/`, `/flash.html`, `/app.js`, `/data/*.json`, … | Workers static assets (the repo, minus `.assetsignore`) |
| `/__proxy-info` | Worker — tells the page the proxy is this same origin |
| `/developers/android/…`, `/dl/android/…` | Worker — proxied to `dl.google.com`, byte-exact ranges |

Same origin is the whole point. A same-origin fetch needs no CORS, so a fork
that deploys this gets in-browser extraction from a URL with **zero
configuration**: `flash.html` probes `/__proxy-info` on load, sees
`{"proxy":"self"}`, and defaults its reverse-proxy setting to `location.origin`.
Nothing to paste, nothing in localStorage.

## Deploy

```bash
cd worker
npm i -g wrangler        # once
wrangler login           # once, opens a browser
wrangler deploy
```

You get `https://android-flash-index.<you>.workers.dev`. Open `/flash.html`,
pick a build in the index, click **Extract** — it reads the archive straight
from `dl.google.com` through the worker.

The index refreshes on a schedule only via GitHub Actions
(`.github/workflows/update-index.yml`), which commits `data/*.json` to the repo.
A worker deployment serves whatever was in the repo at deploy time, so re-run
`wrangler deploy` to pick up new builds — or point a cron trigger at it.

### What gets uploaded

`wrangler.toml` sets `[assets] directory = ".."`, i.e. the repo root.
`.assetsignore` keeps the non-site parts out: `.git`, `.github`, `worker/`,
`scrape.py`, `__pycache__`, and `data/sizes.json` (a 460 KB scraper cache the
page never reads). Check `wrangler deploy`'s upload list if you add files.

Cloudflare's asset limits are 25 MiB per file and 20,000 files; the largest file
here is `data/builds.json` at ~1.6 MB.

## Proxy-only mode

If you would rather keep the site on GitHub Pages and use the worker only as a
proxy, delete the `[assets]` block from `wrangler.toml` and deploy. `/` then
returns a JSON service description instead of the site, and unknown paths 404
with the allow-list. Paste the worker URL into the page's **Reverse proxy**
field; it is stored in that browser's localStorage.

The page detects which mode it is in. With no `/__proxy-info` response it leaves
the proxy unset and says so, rather than silently failing on the first fetch.

## Locking it down

By default the worker answers `Access-Control-Allow-Origin: *`. That is
harmless in same-origin mode (the header is never consulted) and fine for a
personal proxy-only deployment. If you publish a proxy-only URL:

```bash
wrangler secret put ALLOW_ORIGIN     # https://you.github.io
wrangler secret put ALLOW_REFERRER   # https://you.github.io/
```

`ALLOW_REFERRER` is checked before anything is proxied. Note that Referer is
spoofable outside a browser — this is quota protection, not a security boundary.

## What it does and does not proxy

Not a general-purpose proxy:

* host hardcoded to `dl.google.com`
* only `/developers/android/` and `/dl/android/` — everything else 404s (or goes
  to assets), so it cannot be repurposed to reach arbitrary Google URLs
* `GET` and `HEAD` only; no cookies, auth or request bodies are forwarded
* one contiguous `Range` only, capped at 512 MiB
* `Accept-Encoding` is never forwarded; the origin is always asked for identity

## The content-coding trap

This is the part that silently destroys images if you write your own.

Browsers forbid scripts from setting `Accept-Encoding`, so a client **cannot**
ask for identity. And `dl.google.com` will gzip a `.zip` when the client
advertises gzip:

```
$ curl -sSI <image-url>                                   # no Accept-Encoding
Content-Length: 4269967732

$ node -e 'fetch(URL,{method:"HEAD"}).then(…)'            # node sends gzip
content-encoding: gzip
content-length: 4260152987          <-- different
x-identity-content-length: 4269967732
```

Every offset in a ZIP is an absolute byte position, so a coded body means the
central directory is read from the wrong place and the extracted image is
garbage — silently, unless you check.

Two layers of defence, both covered by tests:

1. The worker asks the origin for `Accept-Encoding: identity`, prefers
   `x-identity-content-length` when present, and for ranges up to 64 MiB buffers
   the body and compares its length to the requested range — returning
   `502 length mismatch after proxying` rather than passing on re-encoded data.
   Larger ranges stream unchecked.
2. The client (`httpBlob` in `unzip.js`) repeats the length check independently,
   so a proxy that gets this wrong still fails loudly instead of handing back a
   corrupt `init_boot.img`.

## Cost

The free tier is 100,000 requests/day. Extracting one partition is roughly 8
range requests plus one HEAD, so this is not a meaningful load unless scripted.
Consult Cloudflare's current docs for how static-asset requests are counted
against a plan — that part is not something this repo should assert.

## Local testing without deploying

```bash
wrangler dev        # http://localhost:8787
```

`localhost` is a secure context, so WebUSB works there too. The page's proxy
field accepts `http://localhost:8787`; same-origin values are exempt from the
https-only validation precisely so this works.

The worker's logic is unit-tested in isolation (range parsing, allow-list,
CORS, ASSETS delegation, the length guard, the referrer and origin bindings) by
driving the `fetch` handler against a mocked upstream that reproduces
`dl.google.com`'s gzip behaviour — no deployment needed.
