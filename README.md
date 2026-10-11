# android-flash-index

Machine-readable index of **every** Android factory / GSI image that
[flash.android.com](https://flash.android.com/) offers, with direct
`dl.google.com` download links — including **Canary** builds that Google no
longer lists on the developer site.

**→ Browse it: <https://tsinbeilabs.github.io/android-flash-index/>**

**→ Fork it:** one `wrangler deploy` from [`worker/`](worker/) publishes the
site *and* the image proxy from a single origin, which unlocks reading images
straight from their URL — see [Self-hosting](#self-hosting-everything).

* **4000+ builds**, **80+ products**, **300+ release tracks** (Android 12 QPR3 → current Canary)
* **47 devices** with public images, Pixel 2 → Pixel 11 Pro Fold, plus GSI/AOSP
* file sizes and link health verified by HEAD probe
* refreshed daily by GitHub Actions
* plain JSON, no auth, no HTML-table scraping

```
index.html / app.js / style.css   the index site (GitHub Pages, zero dependencies)
flash.html / flash.js             Web Fastboot flasher UI
unzip.js                          in-place ZIP reader, local File or HTTP ranges
worker/                           optional Cloudflare Worker CORS/range proxy
vendor/                           fastboot.js (kdrag0n, MIT) + zip.js workers
data/builds.json                  every build, every product
data/latest.json                  newest active build per device (beta + canary)
data/devices.json                 device table (display name <-> codenames)
data/sizes.json                   committed URL -> [status, bytes] cache
LISTING.md                        generated markdown summary
devices/<code>.md                 generated build history per device
```

---

## Why this exists

Google used to publish factory-image links on
`developers.android.com/preview/download`. That page now only carries the
current Beta — Canary builds (e.g. `ZP11.260918.007` / Canary 202610) are only
reachable through the Android Flash Tool, which is a SPA with no public list.

The Flash Tool's data comes from a single REST endpoint that does **not**
require OAuth — it only checks that the request looks like it came from the
tool:

```
GET https://flashstation-pa.clients6.google.com/v1/builds?product=<p>&key=<k>
Origin:  https://flash.android.com
Referer: https://flash.android.com/
```

The device → codename table is embedded in the app's JS bundle. `scrape.py`
reads both, so it keeps working as new devices appear.

> The API key is public — it ships inside the flash.android.com page markup to
> every visitor. Nothing here bypasses authentication; internal-only builds
> still return 401.

---

## The website

A static single-page app served by GitHub Pages. No framework, no build step —
it fetches `data/*.json` at runtime, so a data refresh needs no redeploy.

* device sidebar grouped into Phones / Foldables / Tablets / Wear OS / GSI, with counts
* "Latest Canary" and "Latest Beta" cards for the current selection
* full-text search across release name, build id, product, target and track
* filters: active only · canary only · beta only · per-product · four sort orders
* one-click **Download** (direct `dl.google.com` link) and **Copy link**
* shows image size, and flags links that did not answer `200` on the last probe
* deep-linkable — `#caiman?active=1&q=ZP11` restores the whole view
* dark mode (follows the OS, with a manual override), keyboard: `/` search, `Esc` clear

## Web Fastboot

[`flash.html`](https://tsinbeilabs.github.io/android-flash-index/flash.html)
flashes a device straight from the browser over WebUSB — the same approach
flash.android.com uses, but for images you already have on disk.

* **connect** to a device in the bootloader and read `product`, `serialno`,
  `current-slot`, `unlocked`, `is-userspace`, bootloader/baseband versions and
  `max-download-size`
* **extract a single partition** out of a factory zip — see below
* **flash a partition** from a local `.img`, or straight from an archive you just
  opened. Raw and sparse both work; oversized images are split against
  `max-download-size` automatically
* **flash a factory zip** (the inner `image-*.zip` or the outer factory zip),
  sequencing bootloader → radio → boot images → logical partitions with the
  reboots in between, exactly as `fastboot update` does
* **boot an image temporarily** (`fastboot boot`) — ideal for trying a patched
  `init_boot` before committing it
* **reboot** to system / bootloader / fastbootd / recovery
* **raw commands** for anything not covered, e.g. `getvar:current-slot`
* live progress bar plus a timestamped, copyable log

### Pulling one image out of a 4 GB factory zip

Most people who download a factory image only want `init_boot.img` (8 MiB) to
patch with KernelSU or Magisk. Unpacking the whole thing to get it is slow and
pointless, so the page reads the archive in place:

* a factory zip **stores** its inner `image-*.zip` uncompressed (method 0), so
  that nested archive sits at a computable offset and can be opened as if it
  were its own file
* from there it is ordinary random access — read the central directory, find the
  entry, `slice()` out just those bytes, `inflate-raw` them, verify CRC-32
* nothing is ever fully buffered, and nothing leaves the machine

Extracting `init_boot.img` from a 3.98 GiB factory zip costs **2 range reads and
2.5 MiB of I/O**. The partition table shows real vs. in-zip size, marks the
partitions people usually want, and offers **Save** (download the `.img`) or
**Flash…** (stage it in memory and hand it to the partition flasher — no
intermediate file on disk).

Entries above 1 GiB (`product.img` is 4.3 GiB) are refused with an explanation
rather than taking the tab down; use 7-Zip for those.

ZIP64 is implemented because Pixel 11 images are ~15 GiB — verified against a
real 14.44 GiB `cubs_beta` archive.

> Factory images are plain zips of `.img` files. They contain **no**
> `payload.bin`, so none of the protobuf/bsdiff machinery that
> [payload_dumper](https://github.com/rajmani7584/Payload-Dumper-Android) needs
> for OTA payloads applies here — that format only shows up in OTA zips, which
> this index does not list.

Guards, because a wrong write here is unrecoverable:

* every destructive action goes through a confirmation naming the partition,
  file, size and device serial
* flashing is refused while `unlocked = no`
* `wipe` is off by default **and** requires typing `WIPE` to arm
* logical partitions (`system`, `vendor`, `super`…) warn when you are in the
  bootloader rather than fastbootd, and vice versa
* per-partition notes for the ones that matter — e.g. writing stock `init_boot`
  removes root, stock `vbmeta` re-enables verified boot

Requirements and limits:

* Chromium only (Chrome, Edge, Opera, Brave) — Firefox and Safari have no WebUSB
* HTTPS or `localhost`; WebUSB needs a secure context
* the bootloader must already be unlocked; this tool will not unlock it for you

### Reading images straight from the URL (optional reverse proxy)

By default the extractor works on files already on disk, because
`dl.google.com` answers `Access-Control-Allow-Origin` for exactly one origin:

```
$ curl -sSI -H 'Origin: https://flash.android.com' <image-url> | grep -i access-control
Access-Control-Allow-Origin: https://flash.android.com

$ curl -sSI -H 'Origin: https://you.github.io' <image-url> | grep -i access-control
(nothing)
```

That single allow-list entry is what lets flash.android.com stream images
in-page, and what stops everyone else. A browser cannot work around it —
`Origin` is a forbidden header.

Deploy the bundled Cloudflare Worker and the extractor will open an archive
**directly from its URL** — no download at all:

| | requests | transferred |
|---|---|---|
| open the directory of a 3.98 GiB factory zip | 6 | 133 KiB |
| …then extract `init_boot.img` | 2 | 2.63 MiB |
| **total vs. downloading the image** | **8** | **0.065 %** |

Every build row and "latest" card in the index has an **Extract** link that
deep-links into the flasher with the URL pre-filled
(`flash.html?url=…`), so the whole flow is: find build → extract `init_boot` →
patch it → flash it back.

Two ways to run it — see [`worker/README.md`](worker/README.md):

* **Fork and deploy the Worker (recommended).** `cd worker && wrangler deploy`
  publishes the *site and the proxy from one origin*, because `wrangler.toml`
  binds the repo as static assets. Same-origin means no CORS at all, so
  `flash.html` probes `/__proxy-info` on load, sees `{"proxy":"self"}` and
  configures itself — zero setup, nothing stored. This is the one-deployment
  answer: the worker endpoint defaults to itself and can still be overridden.
* **Keep the site on GitHub Pages, add a proxy.** Deploy the worker with the
  `[assets]` block removed and paste its URL into the page's **Reverse proxy**
  field. It is stored in that browser's localStorage and used only to rewrite
  image URLs.

The worker is not an open proxy: the host is hardcoded to `dl.google.com`, only
`/developers/android/` and `/dl/android/` are served, `GET`/`HEAD` only, single
range capped at 512 MiB. It also handles a trap that silently corrupts images —
browsers cannot send `Accept-Encoding`, and `dl.google.com` gzips a `.zip` when
the client advertises gzip, which shifts every offset. Both the worker and the
client verify each range came back byte-exact and fail loudly if not.

Protocol work is [kdrag0n/fastboot.js](https://github.com/kdrag0n/fastboot.js)
(MIT), vendored unmodified into [`vendor/`](vendor/) — see
[`vendor/README.md`](vendor/README.md). This repo only supplies the UI.

## Self-hosting everything

The GitHub Pages deployment can browse and download, but it cannot read an image
from its URL — that needs a proxy, and a proxy needs a server you control.

The Worker in [`worker/`](worker/) removes that split. `wrangler.toml` binds the
repo root as static assets, so one deployment serves:

```
/                       the site            <- Workers static assets
/__proxy-info           {"proxy":"self"}    <- Worker
/developers/android/…   proxied image bytes <- Worker
```

```bash
git clone https://github.com/TsinbeiLabs/android-flash-index
cd android-flash-index/worker
wrangler deploy
```

Open `https://<yours>.workers.dev/flash.html`, click **Extract** on any build,
and it reads the archive in place. The page probes `/__proxy-info` on load and
sets its own origin as the proxy, so there is nothing to configure; the field is
still there if you want to point it somewhere else.

Details, limits, `.assetsignore`, quota pinning and the proxy-only variant are
in [`worker/README.md`](worker/README.md).

## Quick start

```bash
# full refresh, no dependencies (stdlib only), ~15 s once sizes are cached
python scrape.py

# options
python scrape.py --out .            # output directory
python scrape.py --no-sizes         # skip HEAD probes entirely
python scrape.py --sizes-all        # probe every build, not just active ones
python scrape.py --size-workers 4   # keep low: bursts get 429s
python scrape.py --batch 40         # products per API request
python scrape.py --workers 6        # parallel API requests
python scrape.py --json bundle.js   # reuse a local JS bundle (offline parsing)
```

Serve the site locally:

```bash
python -m http.server 8000     # then open http://localhost:8000
```

### Consume the data

```bash
# newest canary factory image for caiman (Pixel 9 Pro)
curl -s https://raw.githubusercontent.com/TsinbeiLabs/android-flash-index/main/data/latest.json \
  | jq -r '.latest.caiman.latestCanary.factoryImageUrl'
```

```python
import json, urllib.request

URL = ("https://raw.githubusercontent.com/TsinbeiLabs/"
       "android-flash-index/main/data/builds.json")
data = json.load(urllib.request.urlopen(URL))

for b in data["builds"]:
    if b["product"] == "caiman_beta" and b.get("canary"):
        print(b["releaseName"], b["trackVersion"],
              round(b.get("sizeBytes", 0) / 2**30, 2), "GB", b["factoryImageUrl"])
```

### Record shape

```jsonc
{
  "product": "caiman_beta",
  "buildId": "16484274",
  "releaseName": "ZP11.260918.007",
  "target": "caiman_beta-user",
  "factoryImageUrl": "https://dl.google.com/developers/android/CANARY/images/factory/caiman_beta-zp11.260918.007-factory-b96cfe1f.zip",
  "track": "Android Canary",
  "trackVersion": "Canary 202610",
  "trackId": "canary-202610",
  "canary": true,        // canary track vs. beta track
  "active": true,        // still offered by the Flash Tool
  "httpStatus": 200,     // from the last HEAD probe
  "sizeBytes": 4272451072
}
```

`active: false` means Google pulled it from the tool; the `dl.google.com` link
usually still resolves, which is how older builds stay downloadable.
`httpStatus` / `sizeBytes` are only present for URLs that have been probed —
by default that is the active set, use `--sizes-all` to backfill history.

---

## How it works

| Step | Detail |
|---|---|
| 1 | `GET https://flash.android.com/` → locate the `gstatic.com/_/flashstation/_/js/...` bundle |
| 2 | Parse `displayName:"…"` + the array literal that follows it → device names and codenames |
| 3 | Parse the `([bootloaderTargets],[products])` call → extra per-device build variants |
| 4 | Query `/v1/builds` for `<codename>`, `<codename>_beta` and every variant, batched 40 per request |
| 5 | De-duplicate on `(product, buildId)`, drop the repeated licence text |
| 6 | HEAD-probe image URLs for size/liveness, through a committed cache |
| 7 | Emit JSON + Markdown |

Two details worth knowing:

**Steps 2–3 match on shape, not on property names.** The bundle is minified and
Google renames those keys between releases — the codename array was `S:[…]` and
is now `O:[…]`. Parsing positionally survives that; verified against two
different bundle revisions.

**Step 6 treats throttling as "unknown", never as "dead".** `dl.google.com`
answers bursts of HEAD requests with `429`. A 429 is indistinguishable from a
removed image unless you back off, so inconclusive results are *not* written to
the cache and get retried on the next run. Concurrency stays at 4 and the cache
is checkpointed every 25 probes, so an interrupted backfill resumes instead of
restarting.

The `generated` timestamp is treated as derived state: if a freshly scraped
payload is byte-identical to the committed one apart from the timestamp, the old
timestamp is reused. A quiet day therefore produces no commit.

## Caveats

* The endpoint and the bundle format are private and can change without notice.
* Only products the Flash Tool exposes are indexed; internal/dogfood targets
  still require Google SSO.
* Sizes are a point-in-time probe, not a guarantee.

## Licence

Code: MIT. The build metadata belongs to Google; this repo only republishes
URLs that Google already serves publicly. Unofficial — not affiliated with Google.
