# steammanifest

Download and inspect Steam depot manifests. The default anonymous path uses this
project's own CM protocol implementation, PICS parser, CDN client, manifest decoder
and filename decryption. Generic `websocket13`, `protobufjs`, and Node.js provide
WebSocket, protobuf, TLS, compression and AES primitives.

`--login` retains `steam-user` for account authentication and Steam Guard. Both
paths use the project's independent manifest decoder. Steam decides whether a
session may receive a manifest request code and depot key; receiving app metadata
does not imply permission to download its manifests.

## Install and run

Requires Node.js 18.3 or newer. The recorded verification used Node.js 20.10.0.

```sh
npm ci
node fetch-manifest.js 1007
```

The app argument accepts an app ID, Steam store URL or game name.

```sh
# Inspect visible depot and branch metadata.
node fetch-manifest.js 1510440 --info
node fetch-manifest.js "honeycomb the world beyond" --info

# Download a specific depot with the independent anonymous client.
node fetch-manifest.js 1007 --depot 1004

# Use your account for content your account can access.
node fetch-manifest.js 1510440 --login your_steam_username

# Specify an exact manifest rather than the branch's current manifest.
node fetch-manifest.js 1007 --depot 1004 --manifest 5612541580377302256
```

| Option | Behavior |
|---|---|
| `--info` | List depot metadata; do not download manifests or request depot keys |
| `--depot <ids>` | Select comma-separated depot IDs |
| `--manifest <id>` | Select an exact manifest; requires one depot |
| `--branch <name>` | Branch name; defaults to `public` |
| `--login <username>` | Account login; password from `STEAM_PASSWORD` or a hidden prompt, with Steam Guard handled in the terminal |
| `--out <dir>` | Output root; defaults to `./manifests` |
| `--debug` | Connection and download diagnostics; request-code URLs are redacted |

Exit codes are `0` for success, `1` for failure, and `2` when Steam denies access to
at least one requested manifest. An absent or password-protected branch is reported
explicitly; the tool does not silently select a different depot.

## Output

Files are written under `manifests/<app id>/`:

* `<depot>_<manifest>.manifest` contains the decompressed manifest bytes, unchanged.
* `<depot>_<manifest>.json` contains file names, sizes, flags, SHA-1 values and every
  chunk's identifier, checksum, offset and sizes.

The JSON uses numbers for sizes and offsets within JavaScript's exact integer range
and decimal strings for larger values. Manifest IDs always remain decimal strings.
Filename and link-target decryption happens only after Steam supplies the depot key.
Keys are used in memory and cleared after use; they are not written to artifacts.
When Steam denies the key, filenames remain encrypted and the JSON says so.
Other key errors fail the download instead of being counted as success.

The `.manifest` preserves its signature section, but **cryptographic signature
verification is not implemented**. ZIP CRC and reference-parser agreement are not
signature authentication.

## SteamTools Lua generator

Generate exact, up-to-date SteamTools `.lua` scripts directly from Steam metadata and your local depot keys database without downloading gigabytes of manifests:

```sh
# Generate Lua from AppID or game name using known depot keys
npm run lua -- 1510440
node fetch-lua.js "honeycomb the world beyond"

# Add or update a depot key into depot_keys.json while generating
node fetch-lua.js 1510440 --key 8ad5009f4eb2b7f0710239d2b6aec5c9e94d3c711a568329b547217844b0d47b

# Print to terminal only (without writing to disk)
node fetch-lua.js 1510440 --print-only
```

Depot keys are saved to `depot_keys.json` so they automatically persist and apply to any future game updates. Shared dependencies (e.g. Common Redistributables `228989`/`228990`) are automatically resolved and appended under `--Share Depots`.

## Local connection portal

```sh
npm run portal -- --apps 1007
```

Open `http://127.0.0.1:3000`. The dashboard shows actual local request rates,
latency, a 48-bin half-hour timeline, cache activity and process totals, refreshed
every five seconds. It starts without a Steam connection. The link builder creates
a request URL without downloading until the generated link is clicked.

```text
GET /manifest/1004/5612541580377302256
GET /manifest/1004/5612541580377302256?appid=1007
GET /api/stats
```

The optional `--apps` list seeds automatic app-ID lookup from Steam's app metadata.
Without a known association, supply `?appid=<appId>` on the manifest request;
the relay verifies that the app lists that depot. It remembers validated apps
for subsequent automatic lookup. Shared/ambiguous depots require an explicit app
ID. `?branch=public` is the default. Manifest IDs stay exact decimal strings.
An optional `--port <1..65535>` changes the port; the listener remains local only.

Downloads reuse the existing independent anonymous client and CDN retries and
return the decompressed `.manifest` binary. The relay validates its structure
and requested IDs before responding. Successful binaries have a ten-minute,
64-MiB/128-entry memory cache with LRU eviction; identical concurrent requests
share one download. The cache key includes app, depot, manifest and branch.
Metadata expires after five minutes, so a stale app association can require
Steam metadata before an otherwise cached response. No portal files or keys
are persisted. Use the existing `--login` CLI for owning-account access.

Steam EResult 15 returns HTTP 403 / `STEAM_ACCESS_DENIED`. CDN failures return
HTTP 502 / `CDN_HTTP_ERROR`, with the upstream HTTP status preserved separately.
Bad inputs return 400, absent app/depot metadata 404, ambiguous app mappings 409,
and admission/rate limits 429. Failed or mismatched manifests are never cached.
The response header `X-Manifest-Source` reports `upstream`, `cache` or `coalesced`.

Statistics count completed manifest deliveries; in-flight requests are separate.
Dashboard polls do not inflate the totals. Cache hit rate uses successful
deliveries in the recent minute. P95 is nearest rank; above 10,000 completions
per minute it reports the last 10,000 latency samples and marks truncation.
Timeline bins include the current unfinished half-hour. Client counts describe
requesting addresses, not people. History and cache reset on restart.

The supplied `20770407.xyz` HTML established this dashboard style and public route,
but contained no server implementation or download response. App lookup, cache
policy, local stats API and binary response format are our implementation choices;
remote API/byte compatibility and identical appearance are not claimed. See
[the source investigation](re/SITE_20770407.md) for the evidence and remaining gaps.

Portal validation is included in `npm test`. The optional browser smoke test,
`node re/check_portal_browser.js`, uses an installed Chromium browser and a local
fixture transport; it writes desktop/mobile screenshots and a result under
`re/evidence/`. The recorded complete suite passed 143/143 tests, and the browser
check completed without runtime exceptions. These checks used no live Steam or
target-site requests.

## Reverse-engineering verification

The research harness uses the same independent client and saves the CDN ZIP,
decompressed manifest, decoded JSON, hashes and a protocol trace without message
bodies. By default, it compares the decoded result with `steam-user` parsing the
**same downloaded bytes locally**. It checks all nine metadata fields, file fields,
and all five fields of every chunk; duplicate entries remain part of the comparison.

```sh
# Offline regression tests; no Steam login or external requests.
npm test

# Verify the preserved original fixture without network access.
node re/verify_manifest.js re/output/1007/1004_5612541580377302256.raw

# Live independent pipeline and local reference comparison.
node re/fetch_raw.js 1007 --report re/evidence/anonymous-1007-verified.json

# Pure independent path, without loading the reference parser.
node re/fetch_raw.js 1007 --no-verify

# Recheck a saved manifest and write an offline proof.
node re/fetch_raw.js --offline re/output/1007/1004_5612541580377302256.manifest --report re/evidence/offline.json
```

Live harness output defaults to `re/output/live/`; the original fixture under
`re/output/1007/` is preserved. A requested `--depot` must exist on the selected
branch unless an explicit `--manifest` is supplied.

`--report` must use a different file from the offline input and generated artifacts.
Colliding paths, including filesystem aliases, fail with exit code `1` before either
file is overwritten; this also applies to reports written after an error.

For an access failure, the harness now records the response status field and its
actual encoded bytes, body size, and whether a code or key was present. Request-code
values, key material and account identities are omitted. A Steam EResult 15 and a
CDN HTTP 403 remain distinct failures. See [the AccessDenied investigation](re/ACCESS_DENIED.md)
for the same-session live comparison, exact client control flow and known limits.

See [the protocol specification](re/PROTOCOL.md) for wire fields, reference sources,
limits and unsupported formats. The independent implementation targets the current
protobuf-manifest workflow. It does not implement Steam's full account-authentication
protocol, legacy binary manifests, ZIP64, VZip/Zstd containers, chunk downloading,
or password-protected branch unlocking.
