# Vendored: fastboot.js

These files are copied verbatim from
[kdrag0n/fastboot.js](https://github.com/kdrag0n/fastboot.js) (`master`,
retrieved 2026-10-11), which is MIT licensed — see
[`LICENSE-fastboot.js`](LICENSE-fastboot.js), © 2021 Danny Lin.

| File | Upstream path | Why |
|---|---|---|
| `fastboot.min.mjs` | `dist/fastboot.min.mjs` | the library; ES module, no external imports |
| `z-worker-pako.js` | `dist/vendor/z-worker-pako.js` | zip.js inflate worker |
| `pako_inflate.min.js` | `dist/vendor/pako_inflate.min.js` | deflate implementation loaded *inside* that worker |

The two worker files must sit in the same directory: zip.js resolves the
second entry of `workerScripts.inflate` with `importScripts()` relative to the
worker itself, not to the page. `flash.js` therefore calls:

```js
configureZip({ workerScripts: { inflate: ["vendor/z-worker-pako.js", "pako_inflate.min.js"] } });
```

Vendored rather than loaded from a CDN so the site has no third-party runtime
dependency and behaves identically offline. Nothing here is modified — a diff
against upstream should be empty, which also makes updating a one-line
re-download.

Upstream provides the WebUSB transport, the fastboot protocol, sparse-image
splitting against `max-download-size`, logical-partition handling and AOSP
factory-zip sequencing. This repo only supplies the UI.
