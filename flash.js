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
};

/* --------------------------------------------------------------- plumbing */

const $ = (id) => document.getElementById(id);

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

  const locked = state.connected && state.unlocked === "no";
  $("lockwarn").hidden = !locked;
  for (const b of document.querySelectorAll("[data-reboot]")) {
    b.disabled = !state.connected || state.busy;
  }
}

/** Which file input backs a given action button. */
function pendingFile(actionId) {
  const map = { doflash: "imgfile", dozip: "zipfile", doboot: "bootfile" };
  const input = $(map[actionId]);
  return input && input.files && input.files.length > 0;
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
  const part = $("part").value === "__custom"
    ? $("partcustom").value.trim()
    : $("part").value;
  const file = $("imgfile").files[0];
  if (!part) { toast("enter a partition name"); return; }
  if (!file) { toast("choose an image"); return; }

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
    `File:   ${file.name}`,
    `Size:   ${fmtBytes(file.size)}`,
    `Target: ${part}`,
    "",
    ...notes,
  ])) return;

  await runBusy(`flash ${part}`, () => device.flashBlob(part, file, (p) => {
    setProgress(p, `writing ${part} — ${Math.round(p * 100)}%`);
  }));
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
  if (!f) { el.textContent = ""; return; }
  const bits = [`${f.name}`, fmtBytes(f.size)];
  if (inputId === "imgfile") {
    const part = $("part").value;
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
    if (custom) $("partcustom").focus();
    describeInput("imgfile", "imginfo");
  };

  // file inputs
  $("imgfile").addEventListener("change", () => describeInput("imgfile", "imginfo"));
  $("zipfile").addEventListener("change", () => describeInput("zipfile", "zipinfo"));
  $("bootfile").addEventListener("change", () => { refreshGuards(); });

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
