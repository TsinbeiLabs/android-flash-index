#!/usr/bin/env python3
"""
Scrape the Android Flash Tool (flash.android.com) build index.

The Flash Tool web app is a single-page app whose device table lives inside its
JS bundle, and whose build data comes from a public REST endpoint that only
checks the Origin/Referer headers (no OAuth required):

    GET https://flashstation-pa.clients6.google.com/v1/builds?product=<p>&key=<k>

This script:
  1. fetches flash.android.com and locates its JS bundle
  2. extracts the device table (display name + codenames) from that bundle
  3. queries the builds endpoint for every codename (and <codename>_beta)
  4. writes a machine-readable index (JSON) and human-readable pages (Markdown)

Standard library only. No dependencies.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API_BASE = "https://flashstation-pa.clients6.google.com/v1/builds"
# Public API key embedded in the flash.android.com page markup.
API_KEY = "AIzaSyD-bwHpMvFCN3PfRN4Txsw_ECg_iptNfMQ"
HOME = "https://flash.android.com/"

# The endpoint rejects requests that do not look like they come from the tool.
BASE_HEADERS = {
    "Origin": "https://flash.android.com",
    "Referer": "https://flash.android.com/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
}

# Non-device products that the Flash Tool also lists (GSI / kernel / cuttlefish).
EXTRA_PRODUCTS = [
    "gsi_arm64",
    "gsi_gms_arm64",
    "gsi_partner_arm64",
    "gsi_car_arm64",
    "aosp_arm64",
    "aosp_arm64_pubsign",
    "aosp_cf_arm64_phone",
    "aosp_cf_x86_64_phone",
    "kernel_aarch64",
]

JS_URL_RE = re.compile(r"https://www\.gstatic\.com/_/flashstation/_/js/[^\"'<> ]+")
DEVICE_RE = re.compile(r'displayName:"([^"]+)"')
# The codename array always sits between `displayName:"..."` and the product
# list, but its (minified) property name changes between bundle revisions, so
# match positionally: the first array literal after the display name.
FIRST_ARRAY_RE = re.compile(r"^\s*,?\s*[A-Za-z0-9_$]{1,4}:\[([^\]]*)\]")
# `R:_.X([bootloaderTargets],[products])` -- helper name is also unstable, so
# look for the two-array call shape rather than the identifier.
PRODUCTS_RE = re.compile(r"\(\[[^\]]*\],\s*(?:\[([^\]]*)\]|\"([^\"]*)\"\.split\(\" \"\))\)")
QUOTED_RE = re.compile(r'"([^"]+)"')
TOKEN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_\-]{1,39}$")


def http_get(url: str, timeout: int = 90, retries: int = 3) -> bytes:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=BASE_HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"GET failed for {url}: {last}")


def find_bundle_url() -> str:
    html = http_get(HOME).decode("utf-8", "replace")
    m = JS_URL_RE.search(html)
    if not m:
        raise RuntimeError("could not locate the flashstation JS bundle in the home page")
    return m.group(0).split("?")[0]


def extract_devices(js: str) -> list[dict]:
    """Pull (displayName, codenames, products) triples out of the minified bundle.

    Property names in the bundle are minified and change on every release, so
    this matches on shape/position instead of identifiers.
    """
    devices, seen = [], set()
    for m in DEVICE_RE.finditer(js):
        name = m.group(1)
        tail = js[m.end(): m.end() + 4000]

        am = FIRST_ARRAY_RE.match(tail.lstrip(","))
        if not am:
            # fall back: first array literal anywhere in the device object
            am2 = re.search(r"\[([^\]]*)\]", tail[:400])
            if not am2:
                continue
            raw_codes = am2.group(1)
        else:
            raw_codes = am.group(1)

        codenames = [c for c in QUOTED_RE.findall(raw_codes) if TOKEN_RE.fullmatch(c)]
        if not codenames:
            continue

        products: list[str] = []
        pm = PRODUCTS_RE.search(tail)
        if pm:
            if pm.group(1) is not None:
                products = QUOTED_RE.findall(pm.group(1))
            elif pm.group(2):
                products = pm.group(2).split()

        key = (name, tuple(codenames))
        if key in seen:
            continue
        seen.add(key)
        devices.append({"displayName": name, "codenames": codenames,
                        "bundleProducts": sorted(set(products))})
    return devices


def product_list(devices: list[dict]) -> tuple[list[str], dict[str, list[str]]]:
    """Every product to query, plus a product -> device codename back-map."""
    owner: dict[str, list[str]] = {}
    prods: list[str] = []

    def add(p: str, code: str) -> None:
        if p not in owner:
            owner[p] = []
            prods.append(p)
        if code not in owner[p]:
            owner[p].append(code)

    for d in devices:
        for code in d["codenames"]:
            add(code, code)
            add(f"{code}_beta", code)
        # extra build variants the tool itself offers for this device
        for p in d.get("bundleProducts", []):
            for code in d["codenames"]:
                add(p, code)
    for p in EXTRA_PRODUCTS:
        add(p, p)
    return prods, owner


def fetch_builds(products: list[str], batch: int = 40, workers: int = 6,
                 verbose: bool = True) -> list[dict]:
    """Query the builds endpoint in batches; returns de-duplicated build records."""
    batches = [products[i:i + batch] for i in range(0, len(products), batch)]
    out: dict[tuple[str, str], dict] = {}
    done = 0

    def one(chunk: list[str]) -> list[dict]:
        qs = "&".join("product=" + urllib.parse.quote(p) for p in chunk)
        url = f"{API_BASE}?{qs}&key={API_KEY}"
        try:
            raw = http_get(url)
        except RuntimeError as e:
            if verbose:
                print(f"  ! batch failed ({chunk[0]}...): {e}", file=sys.stderr)
            return []
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return []
        return data.get("flashstationBuild") or []

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for builds in ex.map(one, batches):
            for b in builds:
                p, bid = b.get("product"), b.get("buildId")
                if not p or not bid:
                    continue
                out[(p, bid)] = b
            done += 1
            if verbose:
                print(f"  [{done}/{len(batches)}] +{len(builds)} builds "
                      f"(total {len(out)})", end="\r")
    if verbose:
        print()
    return list(out.values())


def slim(b: dict) -> dict:
    """Drop the huge repeated license text; keep everything else."""
    md = b.get("previewMetadata") or {}
    rec = {
        "product": b.get("product"),
        "buildId": b.get("buildId"),
        "releaseName": b.get("releaseCandidateName"),
        "target": b.get("target"),
        "factoryImageUrl": b.get("factoryImageDownloadUrl"),
    }
    for k in ("otaUrl", "gsiUrl", "bootloaderUrl", "radioUrl"):
        if b.get(k):
            rec[k] = b[k]
    if md:
        rec["track"] = md.get("releaseTrackName")
        rec["trackVersion"] = md.get("releaseTrackVersionName")
        rec["trackId"] = md.get("id")
        rec["canary"] = bool(md.get("canary"))
        rec["active"] = bool(md.get("active"))
    return rec


def build_id_key(b: dict):
    try:
        return int(b.get("buildId") or 0)
    except (TypeError, ValueError):
        return 0


def verify_urls(builds: list[dict], limit: int) -> dict[str, str]:
    """HEAD-check the newest `limit` factory image URLs; returns url -> status."""
    checked = {}
    cands = sorted(builds, key=build_id_key, reverse=True)
    n = 0
    for b in cands:
        u = b.get("factoryImageUrl")
        if not u or u in checked:
            continue
        req = urllib.request.Request(u, method="HEAD", headers={"User-Agent": BASE_HEADERS["User-Agent"]})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                checked[u] = f"{r.status} {r.headers.get('Content-Length', '?')}"
        except Exception as e:  # noqa: BLE001
            checked[u] = f"ERR {e}"
        n += 1
        if n >= limit:
            break
    return checked


def md_escape(s) -> str:
    return "" if s is None else str(s).replace("|", "\\|")


def track_label(b: dict) -> str:
    """`Android Canary` + `Canary 202610` would read 'Android Canary Canary …'."""
    track = (b.get("track") or "").strip()
    ver = (b.get("trackVersion") or "").strip()
    if not track:
        return ver
    if not ver:
        return track
    last = track.rsplit(" ", 1)[-1].lower()
    if ver.lower().startswith(last):
        return f"{track.rsplit(' ', 1)[0]} {ver}".strip()
    return f"{track} {ver}"


def write_markdown(outdir: str, devices: list[dict], builds: list[dict],
                   owner: dict[str, list[str]], generated: str) -> None:
    by_product: dict[str, list[dict]] = {}
    for b in builds:
        by_product.setdefault(b["product"], []).append(b)
    for v in by_product.values():
        v.sort(key=build_id_key, reverse=True)

    devdir = os.path.join(outdir, "devices")
    os.makedirs(devdir, exist_ok=True)

    # ---- per-device pages -------------------------------------------------
    rows = []
    for d in devices:
        codes = d["codenames"]
        related = sorted({p for c in codes for p, o in owner.items() if c in o})
        rel_builds = sorted(
            {b["buildId"] + "|" + b["product"]: b
             for p in related for b in by_product.get(p, [])}.values(),
            key=build_id_key, reverse=True)
        if not rel_builds:
            continue
        slug = codes[0]
        page = os.path.join(devdir, f"{slug}.md")
        lines = [f"# {d['displayName']}", "",
                 f"Codenames: {', '.join(f'`{c}`' for c in codes)}", "",
                 f"{len(rel_builds)} build(s). Newest first.", "",
                 "| Build | Release | Track | Canary | Active | Product | Factory image |",
                 "|---|---|---|---|---|---|---|"]
        for b in rel_builds:
            u = b.get("factoryImageUrl") or ""
            link = f"[zip]({u})" if u else "-"
            lines.append(
                f"| {md_escape(b.get('buildId'))} | `{md_escape(b.get('releaseName'))}` "
                f"| {md_escape(track_label(b))} "
                f"| {'yes' if b.get('canary') else ''} | {'**yes**' if b.get('active') else ''} "
                f"| `{md_escape(b.get('product'))}` | {link} |")
        with open(page, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        newest = rel_builds[0]
        rows.append({"name": d["displayName"], "slug": slug, "codes": codes,
                     "related": related, "count": len(rel_builds), "newest": newest})

    # ---- top-level index ---------------------------------------------------
    idx = ["# Android image index", "",
           f"Generated {generated} from [flash.android.com](https://flash.android.com/).", "",
           f"**{len(builds)}** builds across **{len(by_product)}** products, "
           f"**{len(rows)}** devices with images.", "",
           "## Active builds", "",
           "| Device | Release | Track | Canary | Build | Product | Factory image |",
           "|---|---|---|---|---|---|---|"]
    for r in rows:
        act = sorted((b for p in r["related"] for b in by_product.get(p, []) if b.get("active")),
                     key=build_id_key, reverse=True)
        link = f"[{r['name']}](devices/{r['slug']}.md)"
        if not act:
            idx.append(f"| {link} | _none_ | | | | | |")
            continue
        for b in act:
            u = b.get("factoryImageUrl") or ""
            idx.append(
                f"| {link} | `{md_escape(b.get('releaseName'))}` "
                f"| {md_escape(track_label(b))} "
                f"| {'yes' if b.get('canary') else ''} | {md_escape(b.get('buildId'))} "
                f"| `{md_escape(b.get('product'))}` "
                f"| {'[zip](' + u + ')' if u else '-'} |")

    idx += ["", "## All devices", "",
            "| Device | Codename | Builds | Newest |", "|---|---|---|---|"]
    for r in sorted(rows, key=lambda x: x["name"]):
        idx.append(f"| [{r['name']}](devices/{r['slug']}.md) | `{r['slug']}` | {r['count']} "
                   f"| `{md_escape(r['newest'].get('releaseName'))}` "
                   f"({md_escape(r['newest'].get('buildId'))}) |")
    idx += ["", "---", "",
            "Raw data: [`data/builds.json`](data/builds.json), "
            "[`data/devices.json`](data/devices.json).", "",
            "Regenerate with `python scrape.py`."]
    with open(os.path.join(outdir, "index.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(idx) + "\n")


def write_json(path: str, payload: dict, generated: str) -> str:
    """Write `payload`, reusing the previous timestamp when only it would change.

    Scheduled runs must not create a commit per day when nothing actually moved,
    so the timestamp is treated as derived state rather than content.
    """
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
        previous = old.pop("generated", None)
        fresh = {k: v for k, v in payload.items() if k != "generated"}
        if previous and old == fresh:
            generated = previous
    except (OSError, json.JSONDecodeError):
        pass
    payload = {"generated": generated, **{k: v for k, v in payload.items()
                                          if k != "generated"}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return generated


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=".", help="output directory (default: cwd)")
    ap.add_argument("--batch", type=int, default=40, help="products per request")
    ap.add_argument("--workers", type=int, default=6, help="parallel requests")
    ap.add_argument("--verify", type=int, default=0,
                    help="HEAD-check the N newest factory image URLs")
    ap.add_argument("--json", default=None, help="path to a local JS bundle "
                                                 "(skip downloading flash.android.com)")
    args = ap.parse_args()

    t0 = time.time()
    print(">> locating JS bundle")
    if args.json:
        js = open(args.json, encoding="utf-8", errors="replace").read()
    else:
        url = find_bundle_url()
        print(f"   {url[:110]}")
        js = http_get(url, timeout=180).decode("utf-8", "replace")

    print(">> extracting device table")
    devices = extract_devices(js)
    print(f"   {len(devices)} devices")

    prods, owner = product_list(devices)
    print(f">> querying {len(prods)} products in batches of {args.batch}")
    raw = fetch_builds(prods, args.batch, args.workers)
    builds = sorted((slim(b) for b in raw), key=lambda b: (b["product"], -build_id_key(b)))
    print(f"   {len(builds)} builds")

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    datadir = os.path.join(args.out, "data")
    os.makedirs(datadir, exist_ok=True)

    generated = write_json(os.path.join(datadir, "builds.json"), {
        "generated": generated, "source": HOME, "api": API_BASE,
        "counts": {"builds": len(builds),
                   "products": len({b["product"] for b in builds}),
                   "active": len([b for b in builds if b.get("active")])},
        "tracks": sorted({f"{b.get('track')} {b.get('trackVersion')}".strip()
                          for b in builds if b.get("track")}),
        "builds": builds,
    }, generated)

    write_json(os.path.join(datadir, "devices.json"),
               {"generated": generated, "source": HOME, "devices": devices}, generated)

    products = sorted({b["product"] for b in builds})

    print(">> writing markdown")
    write_markdown(args.out, devices, builds, owner, generated)

    if args.verify:
        print(f">> verifying {args.verify} newest URLs")
        for u, st in verify_urls(builds, args.verify).items():
            print(f"   {st:>18}  {u}")

    # flat convenience file: codename -> newest active build, split beta/canary
    latest: dict[str, dict] = {}
    for b in builds:
        if not b.get("active"):
            continue
        code = b["product"].removesuffix("_beta")
        slot = "latestCanary" if b.get("canary") else "latestBeta"
        cur = latest.setdefault(code, {})
        if slot not in cur or build_id_key(b) > build_id_key(cur[slot]):
            cur[slot] = b
    write_json(os.path.join(datadir, "latest.json"),
               {"generated": generated, "latest": latest}, generated)

    n_can = sum(1 for v in latest.values() if "latestCanary" in v)
    print(f">> done in {time.time() - t0:.1f}s: {len(builds)} builds, "
          f"{len(products)} products, {len(latest)} devices with an active build "
          f"({n_can} on the canary track)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
