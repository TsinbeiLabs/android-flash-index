/* Android Image Index — static browser over data/builds.json.
 *
 * No framework, no build step. Everything is derived from the two JSON files
 * that scrape.py emits, so the site never needs redeploying when Google ships a
 * new build; the daily Actions run just replaces the data.
 */
"use strict";

const PAGE_SIZE = 250;

const state = {
  devices: [],
  builds: [],
  byProduct: new Map(),
  all: null,          // pseudo-device covering every build
  selected: null,     // slug, or null for the "all builds" view
  shown: PAGE_SIZE,
  filters: { q: "", active: false, canary: false, beta: false, product: "", sort: "new" },
};

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtSize(n) {
  if (!n && n !== 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i >= 3 ? 2 : 0)} ${u[i]}`;
}

function trackLabel(b) {
  const t = (b.track || "").trim();
  const v = (b.trackVersion || "").trim();
  if (!t) return v;
  if (!v) return t;
  const last = t.split(" ").pop().toLowerCase();
  // "Android Canary" + "Canary 202610" would read "Android Canary Canary …"
  return v.toLowerCase().startsWith(last) ? `${t.slice(0, t.length - last.length).trim()} ${v}` : `${t} ${v}`;
}

function buildIdNum(b) {
  const n = parseInt(b.buildId, 10);
  return Number.isFinite(n) ? n : 0;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ------------------------------------------------------- device modelling */

const GSI_PRODUCTS = [
  "gsi_arm64", "gsi_gms_arm64", "gsi_partner_arm64", "gsi_car_arm64",
  "aosp_arm64", "aosp_arm64_pubsign", "aosp_cf_arm64_phone",
  "aosp_cf_x86_64_phone", "kernel_aarch64",
];

function categorize(name) {
  const n = name.toLowerCase();
  if (n.includes("watch")) return "Wear OS";
  if (n.includes("tablet")) return "Tablets";
  if (n.includes("fold")) return "Foldables";
  if (n.startsWith("pixel")) return "Phones";
  return "Other & dev boards";
}

/** Newest Pixel first, everything else alphabetically after. */
function sortKey(name) {
  const m = name.match(/Pixel (\d+)/);
  return m ? [0, -parseInt(m[1], 10), name] : [1, 0, name];
}

function cmpSortKey(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function indexDevices(devicesRaw, builds) {
  // product -> builds
  const byProduct = new Map();
  for (const b of builds) {
    if (!byProduct.has(b.product)) byProduct.set(b.product, []);
    byProduct.get(b.product).push(b);
  }

  const claimed = new Set();
  const devices = [];

  for (const d of devicesRaw) {
    const wanted = new Set();
    for (const c of d.codenames || []) {
      wanted.add(c);
      wanted.add(`${c}_beta`);
    }
    for (const p of d.bundleProducts || []) wanted.add(p);

    const products = [...wanted].filter((p) => byProduct.has(p));
    if (!products.length) continue;
    products.forEach((p) => claimed.add(p));

    const list = products.flatMap((p) => byProduct.get(p));
    devices.push({
      slug: (d.codenames && d.codenames[0]) || d.displayName,
      name: d.displayName,
      codenames: d.codenames || [],
      products: products.sort(),
      builds: list.sort((a, b) => buildIdNum(b) - buildIdNum(a)),
      category: categorize(d.displayName),
    });
  }

  // Anything the device table did not claim (GSI, AOSP, kernel, cuttlefish…)
  const leftovers = [...byProduct.keys()].filter((p) => !claimed.has(p)).sort();
  if (leftovers.length) {
    devices.push({
      slug: "_gsi",
      name: "GSI / AOSP / kernel",
      codenames: leftovers,
      products: leftovers,
      builds: leftovers.flatMap((p) => byProduct.get(p))
        .sort((a, b) => buildIdNum(b) - buildIdNum(a)),
      category: "Generic system images",
    });
  }

  devices.sort((a, b) => cmpSortKey(sortKey(a.name), sortKey(b.name)));
  return { devices, byProduct };
}

/* --------------------------------------------------------------- rendering */

function renderSidebar() {
  const q = $("devq").value.trim().toLowerCase();
  const nav = $("devlist");
  const groups = new Map();

  for (const d of state.devices) {
    if (q && !(`${d.name} ${d.codenames.join(" ")}`.toLowerCase().includes(q))) continue;
    if (!groups.has(d.category)) groups.set(d.category, []);
    groups.get(d.category).push(d);
  }

  const order = ["Phones", "Foldables", "Tablets", "Wear OS",
                 "Generic system images", "Other & dev boards"];
  const names = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  const out = [];

  // "All devices" lives at the top of the list, styled exactly like a device
  // entry, so there is always a one-click way back out of a filtered view.
  // Empty data-slug means "no device selected".
  out.push(
    `<button class="dev all" type="button" data-slug=""`
    + ` aria-current="${state.selected === null}"`
    + ` title="Every build, every device">`
    + `<span>All devices</span>`
    + `<span class="n">${state.builds.length.toLocaleString()}</span>`
    + `<span class="code">all</span></button>`);

  for (const g of names) {
    out.push(`<div class="devgroup">${esc(g)}</div>`);
    for (const d of groups.get(g)) {
      const cur = state.selected === d.slug;
      out.push(
        `<button class="dev" type="button" data-slug="${esc(d.slug)}"`
        + ` aria-current="${cur}" title="${esc(d.codenames.join(", "))}">`
        + `<span>${esc(d.name)}</span>`
        + `<span class="n">${d.builds.length}</span>`
        + `<span class="code">${esc(d.slug)}</span></button>`);
    }
  }
  const noMatch = names.length === 0;
  nav.innerHTML = out.join("")
    + (noMatch ? `<p class="muted" style="padding:12px">No device matches.</p>` : "");
}

function latestOf(builds, wantCanary) {
  return builds
    .filter((b) => b.active && !!b.canary === wantCanary && b.factoryImageUrl)
    .sort((a, b) => buildIdNum(b) - buildIdNum(a))[0] || null;
}

function renderCards() {
  const wrap = $("latest");
  const dev = currentDevice();
  const pool = dev ? dev.builds : state.builds;

  const canary = latestOf(pool, true);
  const beta = latestOf(pool, false);
  const picks = [canary && { b: canary, kind: "canary" }, beta && { b: beta, kind: "beta" }]
    .filter(Boolean);

  if (!picks.length) { wrap.hidden = true; wrap.innerHTML = ""; return; }

  wrap.innerHTML = picks.map(({ b, kind }) => `
    <div class="card ${kind}">
      <span class="kind">${kind === "canary" ? "Latest Canary" : "Latest Beta"}</span>
      <div class="rel">${esc(b.releaseName)}</div>
      <div class="sub">${esc(trackLabel(b))} · build ${esc(b.buildId)} · <code>${esc(b.product)}</code></div>
      <div class="row">
        <a class="btn primary sm" href="${esc(b.factoryImageUrl)}" rel="noopener">Download</a>
        <a class="btn sm" href="${esc(extractHref(b.factoryImageUrl))}">Extract…</a>
        <button class="btn sm" type="button" data-copy="${esc(b.factoryImageUrl)}">Copy link</button>
        <span class="sz">${fmtSize(b.sizeBytes)}</span>
      </div>
    </div>`).join("");
  wrap.hidden = false;
}

function currentDevice() {
  if (!state.selected) return null;
  return state.devices.find((d) => d.slug === state.selected) || null;
}

function filtered() {
  const dev = currentDevice();
  const f = state.filters;
  let list = dev ? dev.builds : state.builds;

  if (f.product) list = list.filter((b) => b.product === f.product);
  if (f.active) list = list.filter((b) => b.active);
  if (f.canary) list = list.filter((b) => b.canary);
  if (f.beta) list = list.filter((b) => !b.canary);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((b) => [
      b.releaseName, b.buildId, b.product, b.target, b.track, b.trackVersion,
    ].join(" ").toLowerCase().includes(q));
  }

  const by = {
    new: (a, b) => buildIdNum(b) - buildIdNum(a),
    old: (a, b) => buildIdNum(a) - buildIdNum(b),
    size: (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0),
    name: (a, b) => String(a.releaseName).localeCompare(String(b.releaseName)),
  }[f.sort] || ((a, b) => buildIdNum(b) - buildIdNum(a));

  return [...list].sort(by);
}

function rowHtml(b) {
  const dead = b.httpStatus && b.httpStatus !== 200;
  const pills = [
    b.canary ? `<span class="pill canary">canary</span>` : "",
    b.active ? `<span class="pill active">active</span>` : "",
    dead ? `<span class="pill dead" title="Last checked: HTTP ${esc(b.httpStatus)}">HTTP ${esc(b.httpStatus)}</span>` : "",
  ].join("");

  const dl = b.factoryImageUrl
    ? (dead
      ? `<span class="btn sm" title="Link did not answer 200 on the last check">unavailable</span>`
      : `<a class="btn primary sm" href="${esc(b.factoryImageUrl)}" rel="noopener">Download</a>`)
    : "";
  const copy = b.factoryImageUrl
    ? `<button class="btn sm" type="button" data-copy="${esc(b.factoryImageUrl)}" title="Copy link">Copy</button>`
    : "";
  const extract = b.factoryImageUrl && !dead
    ? `<a class="btn sm" href="${esc(extractHref(b.factoryImageUrl))}"`
      + ` title="Open in the extractor — pull init_boot etc. without downloading the whole image">Extract</a>`
    : "";

  return `<tr>
    <td><span class="rel">${esc(b.releaseName)}</span>${pills}</td>
    <td class="track">${esc(trackLabel(b))}</td>
    <td class="pid">${esc(b.buildId)}</td>
    <td class="prod">${esc(b.product)}</td>
    <td class="num sz">${fmtSize(b.sizeBytes)}</td>
    <td class="act">${dl}${extract}${copy}</td>
  </tr>`;
}

/** Deep link into the flasher with the archive URL pre-filled. */
function extractHref(url) {
  return `flash.html?url=${encodeURIComponent(url)}`;
}

function renderTable() {
  const list = filtered();
  state.shown = Math.min(state.shown, Math.max(list.length, PAGE_SIZE));
  const slice = list.slice(0, state.shown);

  $("rows").innerHTML = slice.map(rowHtml).join("") + (list.length > slice.length
    ? `<tr><td colspan="6" style="text-align:center;padding:14px">`
      + `<button class="btn sm" type="button" id="more">Show ${Math.min(PAGE_SIZE, list.length - slice.length)} more of ${list.length}</button>`
      + `</td></tr>`
    : "");
  $("empty").hidden = list.length > 0;
  $("count").textContent = `${list.length.toLocaleString()} build${list.length === 1 ? "" : "s"}`;

  const more = $("more");
  if (more) more.onclick = () => { state.shown += PAGE_SIZE; renderTable(); };
}

function renderProductFilter() {
  const dev = currentDevice();
  const sel = $("fproduct");
  const products = dev ? dev.products : [...state.byProduct.keys()].sort();
  const keep = state.filters.product;
  sel.innerHTML = `<option value="">all products</option>`
    + products.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  sel.value = products.includes(keep) ? keep : "";
  state.filters.product = sel.value;
}

function renderHead() {
  const dev = currentDevice();
  const head = $("devhead");
  if (!dev) {
    $("devname").textContent = "Every build";
    $("devmeta").innerHTML = `All ${state.builds.length.toLocaleString()} images across `
      + `${state.byProduct.size} products. Pick a device to narrow it down.`;
    head.hidden = false;
    document.title = "Android Image Index";
    return;
  }
  $("devname").textContent = dev.name;
  $("devmeta").innerHTML = `codename${dev.codenames.length > 1 ? "s" : ""}: `
    + dev.codenames.map((c) => `<code>${esc(c)}</code>`).join(" · ")
    + ` &nbsp;—&nbsp; ${dev.builds.length} builds across ${dev.products.length} product(s)`;
  head.hidden = false;
  document.title = `${dev.name} — Android Image Index`;
}

function renderStats() {
  const active = state.builds.filter((b) => b.active).length;
  const canary = state.builds.filter((b) => b.canary).length;
  $("stats").textContent = `${state.builds.length.toLocaleString()} builds · `
    + `${state.devices.length} devices · ${active} active · ${canary} canary`;
}

function render() {
  renderHead();
  renderSidebar();
  renderProductFilter();
  renderCards();
  renderTable();
}

/* ------------------------------------------------------------ hash routing */

function writeHash() {
  const p = new URLSearchParams();
  const f = state.filters;
  if (f.q) p.set("q", f.q);
  if (f.active) p.set("active", "1");
  if (f.canary) p.set("canary", "1");
  if (f.beta) p.set("beta", "1");
  if (f.product) p.set("product", f.product);
  if (f.sort !== "new") p.set("sort", f.sort);
  const qs = p.toString();
  const hash = (state.selected || "") + (qs ? `?${qs}` : "");
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) { state.selected = null; return; }
  const [slug, qs] = raw.split("?");
  state.selected = slug || null;
  const p = new URLSearchParams(qs || "");
  state.filters = {
    q: p.get("q") || "",
    active: p.get("active") === "1",
    canary: p.get("canary") === "1",
    beta: p.get("beta") === "1",
    product: p.get("product") || "",
    sort: p.get("sort") || "new",
  };
  $("q").value = state.filters.q;
  $("factive").checked = state.filters.active;
  $("fcanary").checked = state.filters.canary;
  $("fbeta").checked = state.filters.beta;
  $("fsort").value = state.filters.sort;
}

function selectDevice(slug) {
  state.selected = slug;
  state.shown = PAGE_SIZE;
  state.filters.product = "";
  writeHash();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ------------------------------------------------------------------- theme */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("aii-theme", t); } catch { /* private mode */ }
}

function initTheme() {
  let t = null;
  try { t = localStorage.getItem("aii-theme"); } catch { /* ignore */ }
  if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(t);
}

/* -------------------------------------------------------------------- boot */

async function load() {
  const [bRes, dRes] = await Promise.all([
    fetch("data/builds.json", { cache: "no-cache" }),
    fetch("data/devices.json", { cache: "no-cache" }),
  ]);
  if (!bRes.ok || !dRes.ok) throw new Error(`HTTP ${bRes.status}/${dRes.status}`);
  const bJson = await bRes.json();
  const dJson = await dRes.json();

  state.builds = bJson.builds || [];
  const idx = indexDevices(dJson.devices || [], state.builds);
  state.devices = idx.devices;
  state.byProduct = idx.byProduct;
  state.generated = bJson.generated;
}

async function main() {
  initTheme();
  $("theme").onclick = () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  };

  try {
    await load();
  } catch (e) {
    const n = $("notice");
    n.hidden = false;
    n.textContent = `Could not load the index (${e.message}). `
      + `If you opened this file directly from disk, serve it over HTTP instead.`;
    $("stats").textContent = "failed to load";
    return;
  }

  renderStats();
  $("gen").textContent = `Index generated ${state.generated}.`;

  // sidebar clicks; an empty data-slug is the "All devices" entry
  $("devlist").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".dev");
    if (btn) selectDevice(btn.dataset.slug || null);
  });

  // copy buttons (delegated: cards + table)
  document.body.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-copy]");
    if (!btn) return;
    const url = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      // clipboard API needs a secure context; fall back to a prompt
      window.prompt("Copy this link:", url);
    }
  });

  // filters
  let qt = null;
  $("q").addEventListener("input", (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      state.shown = PAGE_SIZE;
      writeHash();
      renderTable();
    }, 130);
  });
  for (const [id, key] of [["factive", "active"], ["fcanary", "canary"], ["fbeta", "beta"]]) {
    $(id).addEventListener("change", (e) => {
      state.filters[key] = e.target.checked;
      state.shown = PAGE_SIZE;
      writeHash();
      renderCards();
      renderTable();
    });
  }
  $("fproduct").addEventListener("change", (e) => {
    state.filters.product = e.target.value;
    state.shown = PAGE_SIZE;
    writeHash();
    renderTable();
  });
  $("fsort").addEventListener("change", (e) => {
    state.filters.sort = e.target.value;
    writeHash();
    renderTable();
  });
  $("devq").addEventListener("input", renderSidebar);

  // keyboard: "/" focuses search, Esc clears it
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $("q").focus();
    } else if (e.key === "Escape" && document.activeElement === $("q")) {
      $("q").value = "";
      state.filters.q = "";
      writeHash();
      renderTable();
      $("q").blur();
    }
  });

  window.addEventListener("hashchange", () => { readHash(); render(); });

  readHash();
  if (state.selected && !currentDevice()) state.selected = null;
  render();
}

main();
