# android-flash-index

Machine-readable index of **every** Android factory / GSI image that
[flash.android.com](https://flash.android.com/) offers, with direct
`dl.google.com` download links — including **Canary** builds that Google no
longer lists on the developer site.

**→ Browse it: <https://tsinbeilabs.github.io/android-flash-index/>**

* **4000+ builds**, **80+ products**, **300+ release tracks** (Android 12 QPR3 → current Canary)
* **47 devices** with public images, Pixel 2 → Pixel 11 Pro Fold, plus GSI/AOSP
* file sizes and link health verified by HEAD probe
* refreshed daily by GitHub Actions
* plain JSON, no auth, no HTML-table scraping

```
index.html / app.js / style.css   the index site (GitHub Pages, zero dependencies)
flash.html / flash.js             Web Fastboot flasher UI
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
* **flash a partition** from a local `.img` — raw and sparse both work, oversized
  images are split against `max-download-size` automatically
* **flash a factory zip** (the inner `image-*.zip` or the outer factory zip),
  sequencing bootloader → radio → boot images → logical partitions with the
  reboots in between, exactly as `fastboot update` does
* **boot an image temporarily** (`fastboot boot`) — ideal for trying a patched
  `init_boot` before committing it
* **reboot** to system / bootloader / fastbootd / recovery
* **raw commands** for anything not covered, e.g. `getvar:current-slot`
* live progress bar plus a timestamped, copyable log

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
* **images must be local.** `dl.google.com` sends no `Access-Control-Allow-Origin`
  header, so a browser cannot fetch them cross-origin — download first, then
  pick the file. There is no proxy: these are 4 GB objects.
* the bootloader must already be unlocked; this tool will not unlock it for you

Protocol work is [kdrag0n/fastboot.js](https://github.com/kdrag0n/fastboot.js)
(MIT), vendored unmodified into [`vendor/`](vendor/) — see
[`vendor/README.md`](vendor/README.md). This repo only supplies the UI.

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
