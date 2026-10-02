# AccessDenied: observed wire response and client behavior

This investigation concerns ordinary anonymous requests from this project's
independent CM client. It observes the server's response and the local error path;
it does not reconstruct Valve's server implementation or assume a particular
license-database query.

## Live result, 2026-09-11

`evidence/access-denied-comparison.json` records one anonymous session beginning
at **2026-09-11T15:14:17.495Z**. After connecting, the experiment requested appinfo,
then a manifest request code, then a depot key for each of these exact targets:

| Target, public branch | Appinfo | Request code | Depot key | Session after each request |
|---|---|---|---|---|
| app 1510440 / depot 1510441 / manifest 601642318524817879 | returned | header EResult 15 | body EResult 15; 0 key bytes | ready |
| app 1007 / depot 1004 / manifest 5612541580377302256 | returned | header EResult 1; nonzero code | body EResult 1; 32 key bytes | ready |

The second target was requested **after both denials, on the same connection**.
This demonstrates that the session remained usable and the implementation could
receive successful authorization responses for the control target. It does not
prove that every AccessDenied has the same cause.

No CDN manifest was requested during this comparison. Keys were cleared after
recording their length; key material and request-code values are absent from the
report. The normal CLI was also run separately, with its trace saved in
`evidence/access-denied-1510440.json`.

## The manifest request-code response

The outgoing unified RPC is `ContentServerDirectory.GetManifestRequestCode#1`,
EMsg **151**. The fields identify the app, depot, manifest and branch. This client's
anonymous request does not contain a password or a depot key.

Steam answers with EMsg **147**, `ServiceMethodResponse`. The reply is correlated
with the outstanding request before its status is accepted. The relevant captured
fields for the refused target were:

```text
header.eresult:                 15
actual encoded status field:  68 0f
response body:                 0 bytes
nonzero request code present:  false
nonempty error_message:        false
matched outstanding request:  true
```

`68` is protobuf `(13 << 3) | 0`: field 13, varint wire type. `0f` is decimal 15.
These two bytes are the **status field**, not the entire header or a fixed-offset
signature. The observer walks protobuf fields and records the actual last status
occurrence; it does not search arbitrary payload bytes for `68 0f`.

The control target returned `68 01`, with an **11-byte** response body containing
a nonzero `manifest_request_code`. The denied reply contained no body from which
a request code could be extracted.

## The separate depot-key response

`ClientGetDepotDecryptionKey` is EMsg **5438**; its reply is **5439**. Its status
comes from **body field 1**, not unified-header field 13. The denied target returned:

```text
body.eresult:                  15
actual encoded status field:  08 0f
response body:                 6 bytes
depot key:                     0 bytes
```

The control returned `08 01` and a 32-byte key. The normal manifest CLI asks for
this key only after downloading and decoding a manifest with encrypted names.
The comparison deliberately issued the ordinary key request separately to observe
that second authorization response.

## Local control flow

1. `AnonymousCMClient._receive` decodes the reply, matches its job and message type,
   and rejects the pending unified request when `header.eresult !== 1`. The error
   retains the operation, EResult and status source. The pending timer is cleared.
2. `getManifestRequestCode` in `fetch-manifest.js` preserves that evidence while
   wrapping an actual 15 as `AccessDeniedError`, with stage `manifest-request-code`.
3. `downloadFromCdn` obtains the code before the manifest HTTP request. A code denial
   therefore ends that depot's attempt immediately, before any manifest GET. The
   CDN directory lookup may already have happened; that is not a manifest download.
4. The main multi-depot CLI counts the denial and can continue with other depots.
   Its aggregate exit is 2 for denials, or 1 if any other download failed. The research
   harness records `status: denied` and returns 2, then explicitly logs off in `finally`.

The live comparison shows the denial itself did not disconnect this session.
The normal harness's final `ClientLogOff` is sent by our cleanup code.

The depot-key case has a different outcome. Once the manifest is available, an
actual key AccessDenied leaves filenames encrypted and permits saving that
manifest. A timeout, malformed key response or other key error now fails the
download instead of silently being counted as success.

An HTTP **403** from a CDN is a separate HTTP result. The downloader records
`stage: cdn-http` and `httpStatus: 403`, tries the remaining configured candidates
with fresh server-issued request codes, and exits as a download failure if none
succeeds. It does not invent EResult 15 from an HTTP status. A header status of 1
with a missing or zero code is likewise a malformed response, not AccessDenied.

## What the result establishes

The server refused the requested operation for this anonymous session and target.
Valve's public package documentation describes packages as granting access to
applications and depots, so a missing applicable entitlement is a relevant
explanation to check. However, the captured reply supplies **no detailed reason**:
it does not identify a package, a specific license test, or an internal decision
branch. This experiment did not authenticate an owning account, so it does not
establish the result such an account would receive for this target.

An offline regression changes only the synthetic response status from 15 to 1
while keeping the body empty. The client then reports a missing-code error. A
local status change cannot create the absent server-issued value. No modified
status, guessed code or substituted identity was sent to Steam in this experiment.

## Reproduction and regression coverage

```sh
# Fresh trace of a normal anonymous manifest request.
node re/fetch_raw.js 1510440 --report re/evidence/access-denied-rerun.json

# Successful control through the normal downloader and local comparison.
node re/fetch_raw.js 1007 --depot 1004 --report re/evidence/access-control-rerun.json

# Offline coverage, including synthetic denial/status-change and HTTP 403 cases.
node --test tests/access_denied.test.js tests/cm_client.test.js
```

The two CLI commands create separate sessions. To repeat the recorded same-session
experiment through the exported API, connect one `AnonymousCMClient`, use
`getProductInfo` and `pickDepot` to resolve the current public targets, and call
`getManifestRequestCode` and `getDepotDecryptionKey` sequentially for 1510440/1510441
then 1007/1004. Catch each result independently and check `client.state` before
finally calling `logOff`. Never serialize returned request-code values or keys.

`access_trace.js` emits only the stage, status field bytes/presence, decoded result,
body size, nonempty-error flag, code-presence flag and key length. Full headers,
bodies, session identities and error text are omitted. An absent status is marked
as absent even though the protobuf default decodes to 2.

## Proposed legacy manifest-code message: static review, 2026-09-11

The proposed `ClientUCMGetManifestRequestCode` ancestor is **unverified**. No Steam
CM or CDN request was sent for this hypothesis, and it must not be recorded as a
third AccessDenied result.

The installed reference is `steam-user` **5.3.0**. Case-insensitive searches for
`ManifestRequestCode` and `manifest_request_code` produced no matches in:

* `node_modules/steam-user/enums/EMsg.js`;
* `node_modules/steam-user/protobufs/enums_clientserver.proto`;
* `node_modules/steam-user/protobufs/steammessages_clientserver_ucm.proto`.

A search across the installed `.proto` files found those terms only in
`steammessages_contentsystem.steamclient.proto`: the unified request declaration
at line 58, response at lines 66-68, and service method at line 109. It did not
establish a separate numeric EMsg, request schema, response schema or client
implementation for the claimed legacy manifest-code call.

The UCM schema defines screenshot and published-file operations. Its Workshop
item-change response includes a `manifest_id` (lines 156-171); its published-file
update request includes a `content_manifest` (lines 65-107). Neither declaration
defines a manifest-request-code response. The presence of the word "manifest"
does not make these operations ancestors of the code-issuing service.

These are findings about the inspected versioned references. Complete historical
schema retrieval was not established during this review. Absence from this
snapshot does not prove that an older or undocumented message never existed, and
the server-side patch chronology or shared authorization implementation is not
known. A direct EMsg and a unified RPC having different wire layouts does not,
by itself, establish that their authorization checks are separate.

The existing comparison is explicitly `mode: anonymous`; it did not test a
signed-in owning account. Its grant and denial results apply to the recorded
operations and targets. Even an additional well-identified denial would not prove
all protocol routes were exhausted, all account types were covered, or that donor
pools were the only possible sources of manifests. The implementation's completion
scope remains the supported manifest workflow described in `PROTOCOL.md`.

This review changed documentation only. It adds no opcode, network probe or test
result to the implementation or the previous live evidence.

## Sources

* [Valve EResult documentation](https://partner.steamgames.com/doc/api/steam_api#EResult):
  1 is OK and 15 is AccessDenied; individual calls determine more specific semantics.
* [Valve package documentation](https://partner.steamgames.com/doc/store/application/packages):
  access grants cover applications and depots.
* [Tracked CM header schema](https://github.com/SteamTracking/Protobufs/blob/master/steam/steammessages_base.proto):
  `eresult` is field 13, default 2; `error_message` is optional field 14.
* Installed `steam-user` **5.3.0**, `components/cdn.js`, `components/helpers.js`,
  `protobufs/steammessages_clientserver_2.proto` and
  `protobufs/steammessages_contentsystem.steamclient.proto`: independently inspected
  reference behavior and field declarations. These contain client behavior and
  schemas, not the server's authorization implementation.
