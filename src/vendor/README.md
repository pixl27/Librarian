# Vendored libraries

## hls.light.min.js

hls.js 1.5.20 (light build), Apache-2.0 — https://github.com/video-dev/hls.js

Vendored rather than installed as a dependency so the renderer can load it with
a plain relative `<script>` tag that resolves identically in development and
from inside the packaged asar.

**Why it is here at all:** Steam no longer publishes progressive trailer files
for new releases; `appdetails` returns DASH and HLS manifests, which Chromium
cannot play natively. Without this, every trailer published since that change
is unplayable. See `src/js/trailer.js`.

To update: download `dist/hls.light.min.js` from a tagged release and replace
this file, then bump the version above.
