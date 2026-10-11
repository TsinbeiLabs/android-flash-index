# android-image-proxy

A Cloudflare Worker that lets **your** origin read Android factory images from
`dl.google.com`, so the site can extract a single partition out of a multi-GB
archive with a few range requests instead of downloading the whole thing.

## Why

`dl.google.com` sends `Access-Control-Allow-Origin` for exactly one origin:

```
$ curl -sSI -H 'Origin: https://flash.android.com' <image-url> | grep -i access-control
Access-Control-Allow-Origin: https://flash.android.com
Access-Control-Expose-Headers: Content-Disposition, Content-Encoding, ...

$ curl -sSI -H 'Origin: https://you.github.io' <image-url> | grep -i access-control
(nothing)
```

That single allow-list entry is why flash.android.com can stream images in-page
and why nobody else can. A browser cannot work around it — `Origin` is a
forbidden header, and the response is opaque to any other origin.

With a proxy in front, extracting `init_boot.img` from a 3.98 GiB factory zip
costs about **3 MiB of transfer** instead of 3.98 GiB.

## Deploy

```bash
cd worker
npm i -g wrangler          # once
wrangler login             # once, opens a browser
wrangler deploy
```

You get something like `https://android-image-proxy.<you>.workers.dev`. Paste
that into the site's **Reverse proxy** field (kept in your browser's
localStorage, never sent anywhere else).

Fork the repo and point your own Pages deployment at your own worker — don't
share one worker publicly, or strangers spend your quota.

### Locking it down

By default the worker answers `Access-Control-Allow-Origin: *`, which is fine
for a personal proxy. If the URL will be public:

```bash
wrangler secret put ALLOW_ORIGIN     # https://you.github.io
wrangler secret put ALLOW_REFERRER   # https://you.github.io/
```

## What it does and does not do

It is not a general-purpose proxy:

* host is hardcoded to `dl.google.com`
* only paths under `/developers/android/` and `/dl/android/` are served —
  everything else is a 404, so it cannot be repurposed to reach arbitrary
  Google URLs
* `GET` and `HEAD` only; no cookies, auth or request bodies are forwarded
* single-range `Range` headers only, capped at 512 MiB

## The content-coding trap

This is the part that silently destroys images if you write your own.

Browsers forbid scripts from setting `Accept-Encoding`, so a client **cannot**
ask for identity. And `dl.google.com` will gzip a `.zip` when the client
advertises gzip:

```
$ curl -sSI <image-url>                                   # no Accept-Encoding
Content-Length: 4269967732

$ node -e 'fetch(URL,{method:"HEAD"}).then(r=>…)'         # node sends gzip
content-encoding: gzip
content-length: 4260152987          <-- different!
x-identity-content-length: 4269967732
```

Every offset in a ZIP is an absolute byte position, so a coded body means the
central directory is read from the wrong place and the extracted image is
garbage — with no error, unless you check.

Two layers of defence:

1. The worker asks the origin for `Accept-Encoding: identity` and reads
   `x-identity-content-length` when present, so sizes always describe identity
   bytes.
2. For ranges up to 64 MiB it buffers the body and **compares the byte count to
   the requested range length**, returning `502 length mismatch after proxying`
   rather than passing on re-encoded data. Larger ranges stream unchecked.

The client repeats check 2 independently, so a proxy that gets this wrong still
fails loudly instead of handing you a corrupt `init_boot.img`.

## Cost

Cloudflare's free tier is 100,000 requests/day. Extracting one partition is
roughly 6 requests (size probe, two central-directory reads, local header,
entry data), so this is not a meaningful load unless you script it.

## Local testing without deploying

`wrangler dev` runs it on `http://localhost:8787`. The site's proxy field
accepts that too, though a page served over HTTPS cannot call `http://`
localhost in every browser — serve the site from `localhost` as well if you hit
mixed-content blocking.
