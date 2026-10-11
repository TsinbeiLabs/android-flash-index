# android-flash-index

Machine-readable index of **every** Android factory / GSI image that
[flash.android.com](https://flash.android.com/) offers, with direct
`dl.google.com` download links — including **Canary** builds that Google no
longer lists on the developer site.

* **4000+ builds**, **80+ products**, **300+ release tracks** (Android 12 QPR3 → current Canary)
* refreshed automatically by GitHub Actions
* plain JSON, no auth, no scraping of HTML tables

```
data/builds.json    every build, every product
data/latest.json    newest active build per device (beta + canary)
data/devices.json   device table (display name <-> codenames)
index.md            human-readable summary
devices/<code>.md   full build history per device
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

> The API key is public — it is shipped inside the flash.android.com page
> markup to every visitor. Nothing here bypasses authentication; internal-only
> builds still return 401.

---

## Quick start

```bash
# everything, no dependencies (stdlib only), ~60 s
python scrape.py

# options
python scrape.py --out .            # output directory
python scrape.py --verify 8         # HEAD-check the N newest URLs
python scrape.py --batch 40         # products per request
python scrape.py --workers 6        # parallel requests
python scrape.py --json bundle.js   # reuse a local JS bundle (offline parsing)
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
        print(b["releaseName"], b["trackVersion"], b["factoryImageUrl"])
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
  "canary": true,      // canary track vs. beta track
  "active": true       // still offered by the Flash Tool
}
```

`active: false` means Google pulled it from the tool; the `dl.google.com` link
usually still resolves, which is how older builds stay downloadable.

---

## How it works

| Step | Detail |
|---|---|
| 1 | `GET https://flash.android.com/` → locate the `gstatic.com/_/flashstation/_/js/...` bundle |
| 2 | Parse `displayName:"…"` + the array literal that follows it → device names and codenames |
| 3 | Parse the `([bootloaderTargets],[products])` call → extra per-device build variants |
| 4 | Query `/v1/builds` for `<codename>`, `<codename>_beta` and every variant, batched 40 per request |
| 5 | De-duplicate on `(product, buildId)`, drop the repeated licence text, emit JSON + Markdown |

Step 2/3 deliberately match on **shape**, not on property names: the bundle is
minified and Google renames those keys between releases (`S:[…]` became
`O:[…]`). Parsing positionally survives that. Verified against two different
bundle revisions.

## Caveats

* The endpoint and the bundle format are private and can change without notice.
* Only products the Flash Tool exposes are indexed; internal/dogfood targets
  still require Google SSO.
* URLs are recorded as returned. They are not re-verified on every run — use
  `--verify N` to spot-check.

## Licence

Code: MIT. The build metadata belongs to Google; this repo only republishes
URLs that Google already serves publicly.
