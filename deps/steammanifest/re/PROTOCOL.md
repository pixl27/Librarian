# Steam manifest protocol: implementation and evidence

This project implements the anonymous manifest workflow independently of
`steam-user`: CM discovery, WebSocket login, protobuf framing, heartbeat and job
routing, PICS app metadata, manifest request codes, depot keys, CDN retrieval, ZIP
validation, manifest decoding, and filename/link-target decryption. Account login
through `--login` still uses `steam-user`; the manifest decoder is shared.

The scope is manifest retrieval and inspection, not a replacement for the complete
Steam client. Unsupported formats and the unverified signature boundary are listed
below. A successful parser comparison is not proof that Steam authenticates a file.

## References and method

The wire field numbers and enums were inspected in the installed `steam-user`
**5.3.0** sources, which are not imported by the independent production modules:

| Reference | Facts used |
|---|---|
| `protobufs/steammessages_base.proto` | CM header, Multi envelope |
| `protobufs/steammessages_clientserver_login.proto` | Anonymous login/reply, heartbeat, logoff |
| `protobufs/steammessages_clientserver_appinfo.proto` | PICS app requests, multipart responses and tokens |
| `protobufs/steammessages_clientserver_2.proto` | Depot-key request/reply |
| `protobufs/steammessages_contentsystem.steamclient.proto` | Manifest request-code and content-directory fields |
| `protobufs/content_manifest.proto` | Manifest payload, metadata, signature and chunk fields |
| `enums/EMsg.js`, `enums/EDepotFileFlag.js` | Message numbers and file flags |
| `components/03-messages.js` | Frame layouts, jobs, Multi ordering |
| `components/09-logon.js` | Anonymous identity, login fields, heartbeat and SteamID fallback |
| `components/cdn.js` | WebAPI content-directory discovery, request-code and key flow |
| `components/content_manifest.js`, `components/cdn_compression.js` | Independent test-oracle behavior |
| Installed `@doctormckay/steam-crypto` | Encrypted-IV plus CBC contract; test oracle only |

Public references: [Valve protocol schema tracking](https://github.com/SteamTracking/Protobufs),
[CM base schema](https://github.com/SteamTracking/Protobufs/blob/master/steam/steammessages_base.proto),
and [node-steam-user](https://github.com/DoctorMcKay/node-steam-user).
These repositories are references, not runtime downloads. The local codec contains
the selected field declarations and uses generic `protobufjs` to encode/decode them.

## Connection and discovery

CM addresses come from the public HTTPS WebAPI:

```text
GET https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/
    ?cellid=0&cmtype=websockets&format=json
```

The client selects `websockets` entries in the `steamglobal` realm, ordered by
weighted load, and attempts at most three. It connects to
`wss://<endpoint>/cmsocket/`. TLS supplies transport encryption; the raw-TCP Steam
channel-encryption handshake is not used on this path.

On connection, the client sends `ClientLogon` with protocol version **65580** and
`anon_user_target_account_name="anonymous"`. The initial identity is
`(1 << 56) | (10 << 52) = 117093590311632896`: public universe, anonymous-user type,
instance zero and account ID zero. No account password is supplied.

A successful response supplies the assigned SteamID, session ID, cell and heartbeat
interval. If the header SteamID is absent/zero, the reply's `client_supplied_steamid`
is the documented fallback. The connection must still be open after the complete
incoming Multi is processed; a login immediately followed by logoff is not success.

Default CM login/request deadlines are 15 seconds. Disconnects cancel login,
heartbeat and all outstanding jobs. Job IDs use exact decimal uint64 strings.

## CM frame layout

Every protobuf CM frame is:

```text
uint32 LE  EMsg | 0x80000000
uint32 LE  header_length
byte[]     CMsgProtoBufHeader, exactly header_length bytes
byte[]     message body, protobuf according to EMsg or target_job_name
```

The header-length word is separate from the header protobuf. Omitting it shifts
the whole message and cannot be compatible with the captured protocol.

| Header field | Protobuf tag/type | Use |
|---|---|---|
| `steamid` | 1 / fixed64 | Session identity |
| `client_sessionid` | 2 / int32 | Session number |
| `jobid_source` | 10 / fixed64 | Outbound request correlation |
| `jobid_target` | 11 / fixed64 | Identifies the request answered by a reply |
| `target_job_name` | 12 / string | Unified service name including `#1` |
| `eresult` | 13 / int32 | Unified response status; default 2 |
| `error_message` | 14 / string | Optional error text |

Absent job IDs mean `18446744073709551615`. Source/target IDs never pass through a
JavaScript floating-point conversion. Replies must match both the expected message
number and, for unified methods, the requested method name.

| Message | EMsg |
|---|---:|
| Multi | 1 |
| ServiceMethodResponse | 147 |
| ServiceMethodCallFromClient | 151 |
| ClientHeartBeat / ClientLogOff | 703 / 706 |
| ClientLogOnResponse / ClientLoggedOff | 751 / 757 |
| ClientGetDepotDecryptionKey / response | 5438 / 5439 |
| ClientLogon | 5514 |
| ClientPICSProductInfoRequest / response | 8903 / 8904 |
| ClientPICSAccessTokenRequest / response | 8905 / 8906 |

`CMsgMulti` contains `size_unzipped` (tag 1) and `message_body` (tag 2). Nonzero
`size_unzipped` means gzip; decompression must produce exactly that many bytes.
The payload is a sequence of `[uint32 LE child_length][child_frame]`. Nested Multi
envelopes preserve order and share depth, count and expanded-byte budgets.

The frame codec caps individual frames at 16 MiB and headers at 64 KiB. Multi caps
are 64 MiB cumulative expansion, 4096 child messages and depth 8. The CM session
additionally bounds aggregate multipart responses and pending jobs. Properly framed
unsolicited legacy messages can be skipped: their 36-byte extended header must have
size byte 36, version 2 and canary 239. Their bodies are not interpreted as protobuf.

## App metadata and server-issued access

PICS app buffers are NUL-terminated text KeyValues. `re/vdf.js` parses nested objects,
quoted strings, escapes and comments while keeping identifiers as strings. Dictionaries
have no prototype. Unsupported include directives/conditionals and malformed text fail
explicitly. This parser does not handle binary package-info buffers.

PICS replies can span several messages. `response_pending` keeps the request open.
When an app reports `missing_token`, the client requests a token and retries only
with tokens the server actually supplied. A missing inline appinfo buffer is an
explicit unsupported-response error, not an empty successful app record.

The CDN directory is a **WebAPI call**, not one of this client's CM requests:

```text
GET https://api.steampowered.com/IContentServerDirectoryService/GetServersForSteamPipe/v1/
    ?cell_id=<assigned cell>&format=json
```

The client filters CDN/SteamCache entries and their advertised app restrictions.
The unified CM method `ContentServerDirectory.GetManifestRequestCode#1` has:

| Request field | Tag/type |
|---|---|
| `app_id` | 1 / uint32 |
| `depot_id` | 2 / uint32 |
| `manifest_id` | 3 / uint64 |
| `app_branch` | 4 / string |
| `branch_password_hash` | 5 / string, declared but branch unlocking is not exposed |

The original capture notes contain these golden request-body bytes, retained by
`tests/cm_wire.test.js` and checked against both encoders. They contain public
app/depot/manifest identifiers and the branch name, not a response request code.

```text
app 1007 / depot 1004 / manifest 5612541580377302256 / public
08ef0710ec0718f0c9fe8bcb9af0f14d22067075626c6963

app 1510440 / depot 1510441 / manifest 601642318524817879 / public
08a8985c10a9985c18d7c38eac84d0ddac0822067075626c6963
```

The response contains `manifest_request_code` (tag 1 / uint64). Header `eresult=15`
is an actual AccessDenied response. Header success with an empty/zero code is a
malformed response, not an invented AccessDenied status.

The [AccessDenied investigation](ACCESS_DENIED.md) records the actual status bytes
and compares a denied target with a successful target in the same anonymous session.
The diagnostic trace preserves EResult location and response size without retaining
request-code values, keys or identity fields. An AccessDenied result does not reveal
the precise server-side rule that caused it.

The CDN path is `/depot/<depot_id>/manifest/<manifest_id>/5/<request_code>`. Request
codes come from the active session; examples and traces omit their values. Up to
five candidate servers are attempted, using a fresh code each time. HTTP retrieval
has a total deadline, an idle timeout, redirect limits and a 64 MiB response cap.

For encrypted filenames, `ClientGetDepotDecryptionKey` sends depot ID (tag 1) and
app ID (tag 2). Its reply must contain a successful result, the same depot ID, and a
32-byte key. Receiving visible metadata or a manifest ID does not itself grant this
key or a manifest request code.

## ZIP and manifest format

Supported CDN containers have one classic ZIP entry, stored or raw-DEFLATE
compressed, with a central directory and EOCD. Local header, central directory,
payload boundaries, declared sizes and CRC must agree. Bit-3 data descriptors work
with or without their four-byte signature. Zero CRC and zero size are real values,
not reasons to skip checks. Decompression is bounded before output allocation.

The decompressed manifest contains three magic-tagged protobuf sections and an END:

| Section | uint32 LE magic | Body |
|---|---|---|
| Payload | `0x71F617D0` | `ContentManifestPayload` |
| Metadata | `0x1F4812BE` | `ContentManifestMetadata` |
| Signature | `0x1B81B817` | `ContentManifestSignature` |
| END | `0x32C415AB` | No length word or body |

Non-END sections use `[magic][uint32 LE length][exactly length bytes]`. All three
must occur once. Missing/duplicate sections, invalid protobuf wire types, truncated
fields and bytes after END are rejected. The default manifest/output limit is
64 MiB, configurable with `maxOutputBytes` for offline parsing.

Metadata exposes depot ID, manifest ID, creation time, filename-encryption flag,
original/compressed totals, unique-chunk count and the clear/encrypted CRC fields.
File mappings expose filename, uint64 size, flags, filename/content SHA-1 bytes,
optional link target, and chunks. Every chunk retains SHA-1, fixed32 CRC, uint64
offset, original size and compressed size. Low-level uint64 results are decimal
strings; hashes are hexadecimal strings.

The parsed `signature` bytes and original `signature_section` bytes are retained.
`signature_verified` is always **false**. No RSA algorithm, signed byte range or
public-key trust decision has been established by this implementation.

## Filename encryption

The encrypted path is base64. The preserved live fixture includes trailing LF
characters, so the decoder accepts ASCII whitespace folding before validating
base64. Non-ASCII whitespace and unrelated characters are rejected.

For ciphertext `C` and a server-supplied 32-byte key `K`:

```text
IV    = AES-256-ECB-decrypt(K, C[0:16]), padding disabled
clear = AES-256-CBC-decrypt(K, IV, C[16:]), PKCS#7 padding
path  = UTF-8 bytes before the NUL terminator
```

Filename and nonempty link-target decryption is staged for every file before any
mutation. Wrong keys, malformed encodings, invalid UTF-8, invalid terminators or
unwritable fields leave the input manifest unchanged. On success the encrypted flag
is cleared and backslashes become forward slashes. Paths are displayed, not extracted
to filesystem locations; absolute paths and dot components are not resolved.

## Reproduction and evidence

```sh
npm test
node re/verify_manifest.js re/output/1007/1004_5612541580377302256.raw
node re/fetch_raw.js 1007 --report re/evidence/anonymous-1007-verified.json
node re/fetch_raw.js 1510440 --report re/evidence/anonymous-1510440-denied.json
```

The original fixture is app **1007**, depot **1004**, manifest
**5612541580377302256**. Its ZIP has **3361 bytes**, the decompressed manifest has
**3848 bytes**, and the parsed result has **8 files and 66 chunk entries**.

```text
ZIP SHA-256
587644367a16f4386f7835e80b6faf6e28c7c94b359a8db094f1830c34aaac40

Decompressed manifest SHA-256
4135e314316347856f582251d6514ad8d44956dd141d3617e86adcaaff64a30e
```

`anonymous-1007-verified.json` records the successful live run, content hashes,
metadata-only CM trace, filename-decryption state and complete semantic comparison.
The original `anonymous-1007.json` retains the first run's trailing-LF regression
failure; it is not the completion proof. Test reports record their own actual run
times. A subsequent rerun may see different live app metadata or server addresses.

`verifyManifest` compares nine metadata fields, all known file fields and all chunk
fields, normalizing protobuf absent/default values and path separators. Sorting
ignores harmless ordering changes while retaining duplicate entries. Differences in
CRC, chunk sizes, offsets, encryption state, link targets or duplicate counts fail
verification. It does not verify unknown future protobuf fields or signatures.

## Explicit boundaries

Not implemented independently: account authentication/Steam Guard (retained via
`steam-user`), raw-TCP channel encryption, binary PICS package buffers, PICS appinfo
served through an external HTTP buffer, and password-protected branch unlocking.
Container boundaries: ZIP64, multi-entry/split/encrypted ZIP, local-header-only ZIP,
VZip and Zstd are unsupported. The legacy manifest starting with `0x16349781` and
Steam content-chunk downloads/deltas are outside this manifest workflow. Cryptographic
signature verification remains unimplemented and is never reported as passed.
