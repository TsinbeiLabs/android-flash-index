/* Web Fastboot UI.
 *
 * The protocol work lives in the vendored fastboot.js (kdrag0n, MIT); this file
 * is only state, guards and presentation. Every destructive action goes through
 * confirmAction() so nothing reaches the device without an explicit click.
 */
"use strict";

import {
  FastbootDevice, FastbootError, UsbError, TimeoutError,
  USER_ACTION_MAP, setDebugLevel, configureZip,
} from "./vendor/fastboot.min.mjs";

import {
  openImageZip, extractEntry, entryLabel, ZipError, MAX_EXTRACT_BYTES,
  httpBlob, proxify,
} from "./unzip.js";

/* zip.js resolves the second inflate entry with importScripts() relative to the
 * worker, not the page, so both files must sit in vendor/. */
configureZip({
  workerScripts: { inflate: ["vendor/z-worker-pako.js", "pako_inflate.min.js"] },
});

const device = new FastbootDevice();
window.device = device;   // handy when debugging from devtools

const state = {
  connected: false,
  busy: false,
  unlocked: null,
  vars: {},
  archive: null,      // { view, entries, fileName, nested, innerName, remote?, url? }
  extracted: null,    // { partition, blob, name } pending flash
  proxy: "",          // optional reverse-proxy base for dl.google.com
  netBytes: 0,        // bytes pulled by range requests for the current archive
  netReqs: 0,
  remoteSize: null,   // total size of the remote archive, once known
};

const PROXY_KEY = "aii-proxy";

/* --------------------------------------------------------------- plumbing */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtBytes(n) {
  if (n === null || n === undefined) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i >= 2 ? 2 : 0)} ${u[i]}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function stamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function log(msg, kind = "") {
  const el = $("log");
  const line = document.createElement("div");
  if (kind) line.className = `l-${kind}`;
  line.textContent = `${stamp()}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setProgress(fraction, label) {
  const p = $("prog");
  if (fraction === null || Number.isNaN(fraction)) {
    p.removeAttribute("value");          // indeterminate
  } else {
    p.value = Math.max(0, Math.min(1, fraction));
  }
  if (label !== undefined) $("proglbl").textContent = label;
}

function setConn(text, kind) {
  const el = $("connstate");
  el.textContent = text;
  el.className = `state ${kind || ""}`;
}

/* Per-partition notes, shown before the user confirms. */
const PARTITION_NOTES = {
  init_boot: "This is where KernelSU/Magisk live. Writing an unpatched image removes root.",
  boot: "Writing a mismatched boot image can stop the device booting.",
  vbmeta: "Flashing stock vbmeta re-enables verified boot and can stop a rooted device from booting.",
  vbmeta_system: "Part of the verified boot chain.",
  vbmeta_vendor: "Part of the verified boot chain.",
  bootloader: "A bad bootloader image can brick the device unrecoverably.",
  radio: "A bad radio image can break cellular.",
  super: "Writing super directly replaces every logical partition at once.",
  userdata: "This erases all user data.",
};

const LOGICAL_PARTITIONS = new Set([
  "system", "system_ext", "product", "vendor", "vendor_dlkm",
  "system_dlkm", "odm", "odm_dlkm", "super",
]);

/* ------------------------------------------------------------------ guards */

function canFlash() {
  return state.connected && !state.busy && state.unlocked !== "no";
}

function refreshGuards() {
  const ok = canFlash();
  for (const id of ["doflash", "dozip", "doboot"]) {
    $(id).disabled = !ok || !pendingFile(id);
  }
  $("cmd").disabled = !state.connected || state.busy;
  $("readzip").disabled = !($("zipin").files && $("zipin").files.length) || state.busy;
  $("readurl").disabled = !$("urlin").value.trim() || state.busy;

  const locked = state.connected && state.unlocked === "no";
  $("lockwarn").hidden = !locked;
  for (const b of document.querySelectorAll("[data-reboot]")) {
    b.disabled = !state.connected || state.busy;
  }
}

/** Which file input backs a given action button. */
function pendingFile(actionId) {
  if (actionId === "doflash") {
    // an image extracted in-browser counts as a chosen file
    if (state.extracted && state.extracted.partition === currentPartition()) return true;
  }
  const map = { doflash: "imgfile", dozip: "zipfile", doboot: "bootfile" };
  const input = $(map[actionId]);
  return input && input.files && input.files.length > 0;
}

/** The partition currently chosen in the picker (resolving "custom…"). */
function currentPartition() {
  return $("part").value === "__custom" ? $("partcustom").value.trim() : $("part").value;
}

function confirmAction(title, lines) {
  const serial = state.vars["serialno"] || "unknown serial";
  const product = state.vars["product"] || "unknown product";
  return window.confirm(
    `${title}\n\n`
    + `Device: ${product}  (serial ${serial})\n`
    + lines.filter(Boolean).join("\n")
    + `\n\nProceed?`,
  );
}

function fail(e, what) {
  const name = e && e.name ? e.name : "Error";
  let msg = e && e.message ? e.message : String(e);
  if (e instanceof FastbootError) msg = `${e.status}: ${msg}`;
  log(`${what} failed — ${name}: ${msg}`, "err");
  setProgress(0, `${what} failed`);
  toast(`${what} failed`);
  if (e instanceof UsbError) {
    log("USB transport error: is the device still in the bootloader, and is "
      + "nothing else (adb, another fastboot client) holding it?", "warn");
  } else if (e instanceof TimeoutError) {
    log("The bootloader stopped answering. Large images can exceed the "
      + "command timeout on a slow link — retry, and avoid flashing through a "
      + "USB hub.", "warn");
  }
}

/* ---------------------------------------------------------------- connect */

const GETVARS = ["product", "serialno", "current-slot", "slot-count", "unlocked",
  "secure", "is-userspace", "version-bootloader", "version-baseband",
  "max-download-size", "partition-type:init_boot", "has-slot:init_boot"];

async function readVars() {
  state.vars = {};
  for (const v of GETVARS) {
    try {
      const val = await device.getVariable(v);
      state.vars[v] = val === null || val === undefined ? "" : val;
    } catch (e) {
      state.vars[v] = "";       // unsupported variables are normal
    }
  }
  for (const el of document.querySelectorAll("[data-var]")) {
    const key = el.dataset.var;
    const raw = state.vars[key];
    let shown = raw === undefined || raw === "" ? "—" : raw;
    if (key === "max-download-size" && raw) shown = `${raw} (${fmtBytes(parseInt(raw, 10))})`;
    el.textContent = shown;
    el.classList.toggle("good", key === "unlocked" && raw === "yes");
    el.classList.toggle("bad", key === "unlocked" && raw === "no");
  }
  state.unlocked = state.vars["unlocked"] || null;
  log(`product=${state.vars["product"] || "?"} serial=${state.vars["serialno"] || "?"} `
    + `slot=${state.vars["current-slot"] || "?"} unlocked=${state.unlocked || "?"} `
    + `userspace=${state.vars["is-userspace"] || "?"}`);
}

async function connect() {
  if (state.busy) return;
  setConn("connecting…", "");
  $("connect").disabled = true;
  try {
    await device.connect();
    state.connected = true;
    setConn("connected", "good");
    log("connected to bootloader");
    await readVars();
    if (state.vars["is-userspace"] === "yes") {
      log("in userspace fastboot (fastbootd) — logical partitions available, "
        + "bootloader/radio are not", "warn");
    }
  } catch (e) {
    state.connected = false;
    setConn("not connected", "");
    if (e && e.name === "NotFoundError") {
      log("no device chosen", "warn");
      setConn("not connected", "");
    } else {
      fail(e, "connect");
    }
  } finally {
    $("connect").disabled = false;
    refreshGuards();
  }
}

/* ----------------------------------------------------------------- actions */

async function runBusy(label, fn) {
  if (state.busy) { toast("already running"); return; }
  if (!state.connected) { toast("connect a device first"); return; }
  state.busy = true;
  refreshGuards();
  setProgress(null, label);
  log(`--- ${label} ---`);
  try {
    await fn();
    setProgress(1, `${label} done`);
    log(`${label} finished`, "ok");
  } catch (e) {
    fail(e, label);
  } finally {
    state.busy = false;
    refreshGuards();
  }
}

function onReconnect() {
  $("reconnect").hidden = false;
  log("device rebooted; re-select it to continue", "warn");
}

async function flashPartition() {
  const part = currentPartition();
  const fromArchive = state.extracted && state.extracted.partition === part;
  const payload = fromArchive ? state.extracted.blob : $("imgfile").files[0];
  const origin = fromArchive
    ? `${state.extracted.name} (extracted from ${state.archive.fileName})`
    : (payload ? payload.name : null);
  if (!part) { toast("enter a partition name"); return; }
  if (!payload) { toast("choose an image"); return; }

  const userspace = state.vars["is-userspace"] === "yes";
  const isLogical = LOGICAL_PARTITIONS.has(part);
  const notes = [PARTITION_NOTES[part]];

  if (isLogical && !userspace) {
    notes.push(`"${part}" is a logical partition but you are in the bootloader, `
      + `not fastbootd. Reboot to fastbootd first or this will fail.`);
  }
  if (!isLogical && part !== "super" && userspace) {
    notes.push(`You are in fastbootd; "${part}" is normally flashed from the `
      + `bootloader. Reboot to bootloader if this fails.`);
  }

  if (!confirmAction(`flash "${part}"`, [
    `File:   ${origin}`,
    `Size:   ${fmtBytes(payload.size)}`,
    `Target: ${part}`,
    "",
    ...notes,
  ])) return;

  await runBusy(`flash ${part}`, () => device.flashBlob(part, payload, (p) => {
    setProgress(p, `writing ${part} — ${Math.round(p * 100)}%`);
  }));
  if (fromArchive) {
    state.extracted = null;
    // the staged image is single-use; clear the label too so the UI does not
    // keep advertising a blob that is no longer there
    if (!$("imgfile").files.length) $("imginfo").textContent = "";
    log("cleared the staged image; re-extract if you want to flash it again");
    refreshGuards();
  }
}

async function flashZip() {
  const file = $("zipfile").files[0];
  if (!file) { toast("choose a factory zip"); return; }

  const wipeBox = $("wipe").checked;
  const armed = $("wipeconfirm").value.trim() === "WIPE";
  const wipe = wipeBox && armed;
  if (wipeBox && !armed) {
    toast('type WIPE to arm the data wipe');
    log("wipe requested but not armed (WIPE not typed); continuing without wipe", "warn");
  }

  if (!confirmAction("flash factory zip", [
    `File:  ${file.name}`,
    `Size:  ${fmtBytes(file.size)}`,
    `Wipe:  ${wipe ? "YES — ALL USER DATA WILL BE ERASED" : "no (data preserved)"}`,
    "",
    "This rewrites bootloader, radio, boot images and every logical partition,",
    "rebooting the device several times. It takes several minutes; do not",
    "unplug or close this tab.",
    "",
    "Root will be LOST unless you flash a patched init_boot afterwards.",
  ])) return;

  await runBusy("flash factory zip", () => device.flashFactoryZip(
    file,
    wipe,
    onReconnect,
    (action, item, progress) => {
      const verb = USER_ACTION_MAP[action] || action;
      setProgress(progress, `${verb} ${item} — ${Math.round(progress * 100)}%`);
      log(`${verb} ${item} (${Math.round(progress * 100)}%)`);
    },
  ));
  if (wipe) {
    log("userdata wiped", "warn");
  }
  log("factory zip complete. If you keep root, flash your patched init_boot now "
    + "before booting into the system.", "ok");
}

async function bootImage() {
  const file = $("bootfile").files[0];
  if (!file) { toast("choose an image"); return; }
  if (!confirmAction("boot image (temporary)", [
    `File: ${file.name}`,
    `Size: ${fmtBytes(file.size)}`,
    "",
    "Boots once from RAM. Nothing is written, so a bad image only costs a reboot.",
  ])) return;

  await runBusy("boot image", () => device.bootBlob(file, (p) => {
    setProgress(p, `uploading — ${Math.round(p * 100)}%`);
  }));
  onReconnect();
}

async function reboot(target) {
  if (!state.connected) { toast("connect a device first"); return; }
  const where = target || "system";
  if (!window.confirm(`Reboot to ${where}?`)) return;
  await runBusy(`reboot ${where}`, async () => {
    try {
      await device.reboot(target, false);
    } catch (e) {
      /* the device often drops off USB before the OKAY lands */
      log(`reboot sent (transport closed: ${e.message})`);
    }
    state.connected = false;
    setConn("rebooted", "");
    log(`rebooted to ${where}`);
  });
}

async function sendCommand(ev) {
  ev.preventDefault();
  const cmd = $("cmd").value.trim();
  if (!cmd || !state.connected || state.busy) return;
  const destructive = /^(erase|flashing\s+(unlock|lock)|oem\s+unlock| wiping)/i.test(cmd);
  if (destructive && !window.confirm(`Send raw command "${cmd}"?\n\nThis is not validated in any way.`)) {
    return;
  }
  await runBusy(`command: ${cmd}`, async () => {
    const res = await device.runCommand(cmd);
    log(`> ${cmd}\n< ${res.text}${res.dataSize ? `  (data ${res.dataSize})` : ""}`);
    $("cmd").value = "";
    if (/^getvar:/i.test(cmd)) await readVars();
  });
}

/* ----------------------------------------------------------------- extract */

/** Does the partition <select> have an <option> for this name? */
function hasPartitionOption(name) {
  return [...$("part").options].some((o) => o.value === name);
}

function partitionOf(entryName) {
  return entryLabel(entryName).replace(/\.(img|bin)$/i, "");
}

async function readArchive() {
  const file = $("zipin").files[0];
  if (!file) { toast("choose a factory zip first"); return; }

  await openArchive(
    `local file ${file.name}`,
    () => openImageZip(file),
    { fileName: file.name, sizeBytes: file.size },
  );
}

/**
 * Open a factory zip directly from a URL over range requests.
 *
 * With a proxy this avoids the multi-gigabyte download entirely: the reader
 * touches the two central directories and the one entry it needs, which is a
 * few MiB.
 */
async function readUrl() {
  const url = $("urlin").value.trim();
  if (!url) { toast("paste a factory image URL first"); return; }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    $("zipstatus").textContent = "that is not a valid URL";
    return;
  }
  if (!/^https:$/.test(parsed.protocol)) {
    $("zipstatus").textContent = "only https: URLs are supported";
    return;
  }

  const proxy = state.proxy;
  const isGoogle = /(^|\.)dl\.google\.com$/i.test(parsed.hostname);
  if (isGoogle && !proxy) {
    const msg = "dl.google.com only allows flash.android.com to read it "
      + "cross-origin, so this needs a reverse proxy. Set one below, or "
      + "download the file and use the local picker.";
    $("zipstatus").textContent = msg;
    $("proxybox").open = true;
    $("proxyhint").textContent = msg;
    log(msg, "warn");
    toast("a reverse proxy is required");
    return;
  }

  const label = parsed.pathname.split("/").pop() || url;
  await openArchive(
    `remote ${label}`,
    async () => {
      const blob = await httpBlob(url, {
        rewrite: (u) => proxify(u, proxy),
        onBytes: (n) => { state.netBytes += n; state.netReqs += 1; },
      });
      state.remoteSize = blob.size;
      return openImageZip(blob);
    },
    { fileName: label, remote: true, url },
  );
}

/** Shared tail for both entry points: open, then present. */
async function openArchive(what, open, meta) {
  $("readzip").disabled = true;
  $("readurl").disabled = true;
  state.netBytes = 0;
  state.netReqs = 0;
  state.remoteSize = null;
  $("ziplist").hidden = true;
  $("readcost").hidden = true;
  $("zipstatus").textContent = `reading ${what}…`;
  setProgress(null, `reading ${what}`);
  log(`--- reading archive ${what} ---`);

  const t0 = performance.now();
  try {
    const arc = await open();
    state.archive = { ...arc, ...meta };
    state.extracted = null;

    const ms = Math.round(performance.now() - t0);
    const where = arc.nested
      ? `${arc.entries.length} partitions inside ${arc.innerName.split("/").pop()}`
      : `${arc.entries.length} entries`;
    $("zipstatus").textContent = `${where} — read in ${ms} ms.`;

    if (meta.remote) {
      const pct = state.remoteSize ? (state.netBytes / state.remoteSize * 100) : 0;
      $("readcost").hidden = false;
      $("readcost").innerHTML =
        `Read the directory with <strong>${state.netReqs}</strong> range `
        + `requests totalling <strong>${fmtBytes(state.netBytes)}</strong>`
        + (state.remoteSize
          ? ` — ${pct.toFixed(3)}% of the ${fmtBytes(state.remoteSize)} archive.`
          : ".");
    }

    $("zipnote").hidden = false;
    $("zipnote").innerHTML = arc.nested
      ? `The outer zip stores its <code>image-*.zip</code> uncompressed, so it was `
        + `opened in place${meta.remote ? " over HTTP" : ""} — the archive was never unpacked.`
      : `This looks like an inner <code>image-*.zip</code> already, or a plain image zip.`;
    log(`archive opened: ${where}${arc.nested ? " (nested)" : ""}`, "ok");
    renderEntries();
    setProgress(1, "archive ready");
  } catch (e) {
    state.archive = null;
    const msg = e instanceof ZipError ? e.message : (e.message || String(e));
    $("zipstatus").textContent = `failed: ${msg}`;
    log(`archive read failed — ${msg}`, "err");
    setProgress(0, "archive read failed");
    toast("could not read that archive");
  } finally {
    refreshGuards();
  }
}

function renderEntries() {
  const arc = state.archive;
  if (!arc) return;
  const rows = [...arc.entries].sort((a, b) => entryLabel(a.name).localeCompare(entryLabel(b.name)));

  const head = `<tr><th>Partition</th><th class="num">Image size</th>`
    + `<th class="num">In zip</th><th class="act"></th></tr>`;
  const body = rows.map((e) => {
    const label = entryLabel(e.name);
    const part = partitionOf(e.name);
    const tooBig = e.usize > MAX_EXTRACT_BYTES;
    const star = /^(init_boot|boot|vendor_boot|dtbo|vbmeta)$/i.test(part);
    const note = tooBig
      ? `<span class="pill dead" title="over the ${fmtBytes(MAX_EXTRACT_BYTES)} in-browser limit">too large</span>`
      : (star ? `<span class="pill active">common</span>` : "");
    const actions = tooBig
      ? `<span class="muted">use 7-Zip / unzip</span>`
      : `<button class="btn sm" type="button" data-save="${esc(label)}">Save</button>`
        + `<button class="btn primary sm" type="button" data-use="${esc(label)}">Flash…</button>`;
    return `<tr${star ? ' class="star"' : ""}>`
      + `<td class="rel">${esc(label)}${note}</td>`
      + `<td class="num sz">${fmtBytes(e.usize)}</td>`
      + `<td class="num sz">${fmtBytes(e.csize)}</td>`
      + `<td class="act">${actions}</td></tr>`;
  }).join("");

  const el = $("ziplist");
  el.innerHTML = `<table class="ztable"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  el.hidden = false;

  el.onclick = async (ev) => {
    const save = ev.target.closest("[data-save]");
    const use = ev.target.closest("[data-use]");
    if (save) await saveEntry(save.dataset.save);
    else if (use) await useEntryForFlashing(use.dataset.use);
  };
}

function findEntry(label) {
  const arc = state.archive;
  if (!arc) return null;
  return arc.entries.find((e) => entryLabel(e.name) === label) || null;
}

async function extractTo(label, what) {
  const e = findEntry(label);
  if (!e || !state.archive) return null;
  setProgress(null, `extracting ${label}`);
  log(`extracting ${label} (${fmtBytes(e.usize)})`);
  const beforeBytes = state.netBytes;
  const beforeReqs = state.netReqs;
  try {
    const blob = await extractEntry(state.archive.view, e, (p, m) => {
      setProgress(p, m);
    });
    log(`${label} extracted, ${fmtBytes(blob.size)}, CRC verified`, "ok");
    if (state.archive.remote) {
      const used = state.netBytes - beforeBytes;
      const reqs = state.netReqs - beforeReqs;
      log(`  fetched ${fmtBytes(used)} in ${reqs} range request(s) instead of the `
        + `${fmtBytes(state.remoteSize)} archive`);
      $("readcost").hidden = false;
      $("readcost").innerHTML =
        `Total so far: <strong>${state.netReqs}</strong> range requests, `
        + `<strong>${fmtBytes(state.netBytes)}</strong> transferred of a `
        + `${fmtBytes(state.remoteSize)} archive `
        + `(${(state.netBytes / state.remoteSize * 100).toFixed(3)}%).`;
    }
    return blob;
  } catch (err) {
    fail(err, what);
    return null;
  }
}

async function saveEntry(label) {
  const blob = await extractTo(label, `extract ${label}`);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = label;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setProgress(1, `saved ${label}`);
  toast(`${label} saved`);
}

async function useEntryForFlashing(label) {
  const blob = await extractTo(label, `extract ${label}`);
  if (!blob) return;

  const part = partitionOf(label);
  state.extracted = { partition: part, blob, name: label };

  if (hasPartitionOption(part)) {
    $("part").value = part;
    $("partcustom").hidden = true;
  } else {
    $("part").value = "__custom";
    $("partcustom").hidden = false;
    $("partcustom").value = part;
  }
  $("part").dispatchEvent(new Event("change"));

  $("imginfo").textContent =
    `${label} — ${fmtBytes(blob.size)}, extracted from `
    + `${state.archive.fileName} and held in memory (no file was written to disk)`;
  setProgress(1, `${label} ready to flash`);
  toast(`${label} loaded into the flasher`);
  log(`${label} staged for flashing as "${part}"`, "ok");
  refreshGuards();

  const target = $("doflash");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
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

function describeInput(inputId, infoId) {
  const f = $(inputId).files[0];
  const el = $(infoId);
  if (!f) {
    el.textContent = "";
    refreshGuards();     // clearing the picker must re-disable the action button
    return;
  }
  const bits = [`${f.name}`, fmtBytes(f.size)];
  if (inputId === "imgfile") {
    const part = currentPartition();
    if (LOGICAL_PARTITIONS.has(part) && state.vars["is-userspace"] !== "yes") {
      bits.push("logical partition — needs fastbootd");
    }
    if (PARTITION_NOTES[part]) bits.push(PARTITION_NOTES[part]);
  }
  if (inputId === "zipfile" && !/\.zip$/i.test(f.name)) {
    bits.push("not a .zip — are you sure?");
  }
  el.textContent = bits.join(" · ");
  refreshGuards();
}

function main() {
  initTheme();
  $("theme").onclick = () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  };

  // environment checks
  if (!window.isSecureContext) {
    log("this page is not a secure context; WebUSB is unavailable. "
      + "Serve it over HTTPS or from localhost.", "err");
  } else if (!("usb" in navigator)) {
    log("this browser has no WebUSB. Use Chrome, Edge, Opera or Brave.", "err");
    $("connect").disabled = true;
    setConn("unsupported browser", "bad");
  } else {
    log("ready — boot the device into the bootloader and press Connect");
  }

  $("connect").onclick = connect;
  $("reconnectbtn").onclick = async () => {
    $("reconnect").hidden = true;
    await connect();
  };

  $("doflash").onclick = flashPartition;
  $("dozip").onclick = flashZip;
  $("doboot").onclick = bootImage;
  $("cmdform").addEventListener("submit", sendCommand);

  for (const b of document.querySelectorAll("[data-reboot]")) {
    b.onclick = () => reboot(b.dataset.reboot);
  }

  // partition picker
  $("part").onchange = () => {
    const custom = $("part").value === "__custom";
    $("partcustom").hidden = !custom;
    if (custom && !$("partcustom").value) $("partcustom").focus();
    describeInput("imgfile", "imginfo");
    refreshGuards();
  };
  $("partcustom").addEventListener("input", () => {
    describeInput("imgfile", "imginfo");
    refreshGuards();
  });

  // file inputs
  $("imgfile").addEventListener("change", () => {
    // picking a file on disk supersedes anything staged from an archive
    if (state.extracted) {
      state.extracted = null;
      log("discarded the staged in-memory image; using the chosen file instead");
    }
    describeInput("imgfile", "imginfo");
  });
  $("zipfile").addEventListener("change", () => describeInput("zipfile", "zipinfo"));
  $("bootfile").addEventListener("change", () => { refreshGuards(); });

  // archive extraction
  $("zipin").addEventListener("change", () => {
    const f = $("zipin").files[0];
    state.archive = null;
    state.extracted = null;
    $("ziplist").hidden = true;
    $("zipnote").hidden = true;
    $("readcost").hidden = true;
    $("zipstatus").textContent = f
      ? `${f.name} — ${fmtBytes(f.size)}. Read the directory to list its partitions.`
      : "";
    refreshGuards();
  });
  $("readzip").onclick = readArchive;

  // remote extraction
  $("urlin").addEventListener("input", () => {
    state.archive = null;
    state.extracted = null;
    $("ziplist").hidden = true;
    $("zipnote").hidden = true;
    $("readcost").hidden = true;
    refreshGuards();
  });
  $("readurl").onclick = readUrl;

  // reverse proxy setting, kept in this browser only
  const renderProxy = () => {
    $("proxy").value = state.proxy;
    $("proxystate").textContent = state.proxy
      ? new URL(state.proxy).host
      : "not set";
    $("proxystate").className = state.proxy ? "state good" : "muted";
  };
  try { state.proxy = localStorage.getItem(PROXY_KEY) || ""; } catch { /* ignore */ }
  renderProxy();

  $("saveproxy").onclick = () => {
    const v = $("proxy").value.trim().replace(/\/+$/, "");
    if (v) {
      let u;
      try {
        u = new URL(v);
      } catch {
        $("proxyhint").textContent = "that is not a valid URL";
        return;
      }
      if (u.protocol !== "https:") {
        $("proxyhint").textContent = "must be https: — an http: proxy is blocked "
          + "as mixed content on an https: page";
        return;
      }
    }
    state.proxy = v;
    try {
      if (v) localStorage.setItem(PROXY_KEY, v);
      else localStorage.removeItem(PROXY_KEY);
    } catch { /* private mode */ }
    renderProxy();
    $("proxyhint").textContent = v ? "saved." : "cleared.";
    log(`reverse proxy ${v ? "set to " + v : "cleared"}`);
    toast(v ? "proxy saved" : "proxy cleared");
  };
  $("clearproxy").onclick = () => {
    $("proxy").value = "";
    $("saveproxy").onclick();
  };

  // deep link: flash.html?url=<encoded image url>
  const qs = new URLSearchParams(location.search);
  const deepUrl = qs.get("url");
  if (deepUrl) {
    $("urlin").value = deepUrl;
    refreshGuards();
    log(`opened from a link: ${deepUrl}`);
    if (!state.proxy && /(^|\.)dl\.google\.com$/i.test(new URL(deepUrl).hostname)) {
      $("proxybox").open = true;
      $("proxyhint").textContent =
        "This link points at dl.google.com, which only flash.android.com may read "
        + "cross-origin. Deploy the bundled worker and set it above to open it "
        + "without downloading, or download the file and use the local picker.";
      log("no reverse proxy configured; the URL cannot be read cross-origin yet", "warn");
    } else {
      readUrl();
    }
  }

  // wipe arming
  $("wipe").onchange = () => {
    $("wipecfg").hidden = !$("wipe").checked;
    if (!$("wipe").checked) $("wipeconfirm").value = "";
  };
  $("wipeconfirm").addEventListener("input", refreshGuards);

  // verbose protocol logging
  let verbose = false;
  $("debug").onclick = () => {
    verbose = !verbose;
    setDebugLevel(verbose ? 2 : 0);
    $("debug").classList.toggle("on", verbose);
    log(`verbose protocol logging ${verbose ? "on" : "off"}`);
  };

  $("clearlog").onclick = () => { $("log").textContent = ""; };
  $("copylog").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("log").textContent);
      toast("log copied");
    } catch {
      window.prompt("Copy the log:", $("log").textContent.slice(0, 4000));
    }
  };

  // a device unplugged behind our back should not leave the UI claiming otherwise
  if ("usb" in navigator) {
    navigator.usb.addEventListener("disconnect", () => {
      if (!state.busy) {
        state.connected = false;
        setConn("disconnected", "bad");
        log("device disconnected", "warn");
        refreshGuards();
      }
    });
  }

  // never let a half-finished flash be abandoned silently
  window.addEventListener("beforeunload", (e) => {
    if (state.busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  refreshGuards();
}

main();
