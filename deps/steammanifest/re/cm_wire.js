'use strict';

/**
 * Independent Steam CM protobuf framing. No socket, credentials or RPC state.
 * Wire facts were read from the installed steam-user 5.3.0 reference, not loaded
 * at runtime: enums/EMsg.js; protobufs/steammessages_{base,clientserver_login,
 * clientserver_appinfo,clientserver_2,contentsystem.steamclient}.proto;
 * components/03-messages.js:456-486, 524-552, 656-699.
 *
 * Anonymous WSS login: 09-logon.js:21,83-101,230-235 and
 * connection_protocols/websocket.js:29,71-75 send ClientLogon directly after TLS.
 * PUBLIC universe=1, ANON_USER type=10, ALL instance=0, accountid=0 give
 * (1n << 56n) | (10n << 52n) = ANON_STEAM_ID. protocol_version=65580 and
 * anon_user_target_account_name='anonymous'; account_name/password are absent.
 * client_package_version (tag 5) is optional and not set by that reference.
 * The session adopts reply header steamid/client_sessionid and body cell_id;
 * body heartbeat_seconds controls periodic ClientHeartBeat. The codec itself
 * never supplies identity, job ids, status or login defaults to outgoing frames.
 *
 * All field names use snake_case. Decode includes protobuf defaults (notably
 * eresult=2 and unset job ids=UINT64_MAX), bytes are Buffers, and 64-bit integers
 * are decimal strings. Unknown EMsgs/services retain their opaque body Buffer.
 * Multi preserves opaque legacy leaves after validating their 36-byte extended
 * header. Standalone decoding remains protobuf-only; protobuf groups and legacy
 * payload decoding are unsupported.
 */

const protobuf = require('protobufjs');
const {gunzipSync} = require('node:zlib');

const PROTO_MASK = 0x80000000;
const JOBID_NONE = '18446744073709551615';
const ANON_STEAM_ID = '117093590311632896';
const PROTOCOL_VERSION = 65580;
const EMsg = Object.freeze({
	Multi: 1,
	ServiceMethod: 146,
	ServiceMethodResponse: 147,
	ServiceMethodCallFromClient: 151,
	ClientHeartBeat: 703,
	ClientLogOff: 706,
	ClientLogOnResponse: 751,
	ClientLoggedOff: 757,
	ClientGetDepotDecryptionKey: 5438,
	ClientGetDepotDecryptionKeyResponse: 5439,
	ClientLogon: 5514,
	ClientPICSProductInfoRequest: 8903,
	ClientPICSProductInfoResponse: 8904,
	ClientPICSAccessTokenRequest: 8905,
	ClientPICSAccessTokenResponse: 8906,
	ServiceMethodCallFromClientNonAuthed: 9804,
	ClientHello: 9805
});

// Per-frame limits also bound standalone protobuf bodies. Multi limits apply
// across the entire nested expansion, including intermediate container payloads.
const LIMITS = Object.freeze({
	maxFrameBytes: 16 * 1024 * 1024,
	maxHeaderBytes: 64 * 1024,
	maxExpandedBytes: 64 * 1024 * 1024,
	maxMessages: 4096,
	maxDepth: 8,
	maxProtoFields: 262144,
	maxProtoDepth: 16
});

// Field/tag declarations only; generic protobufjs supplies protobuf encoding.
// This deliberately small logon schema covers anonymous client metadata only.
const root = protobuf.parse(`
syntax = "proto2";
message IPAddress { oneof ip { fixed32 v4 = 1; bytes v6 = 2; } }
message GCRouting { optional uint64 dst_gcid_queue = 1; optional uint32 dst_gc_dir_index = 2; }
message Header {
 optional fixed64 steamid = 1;
 optional int32 client_sessionid = 2;
 optional uint32 routing_appid = 3;
 optional fixed64 jobid_source = 10 [default = 18446744073709551615];
 optional fixed64 jobid_target = 11 [default = 18446744073709551615];
 optional string target_job_name = 12;
 optional int32 eresult = 13 [default = 2];
 optional string error_message = 14;
 optional uint32 auth_account_flags = 16;
 optional int32 transport_error = 17 [default = 1];
 optional uint64 messageid = 18 [default = 18446744073709551615];
 optional uint32 publisher_group_id = 19;
 optional uint32 sysid = 20;
 optional uint64 trace_tag = 21;
 optional uint32 token_source = 22;
 optional bool admin_spoofing_user = 23;
 optional int32 seq_num = 24;
 optional uint32 webapi_key_id = 25;
 optional bool is_from_external_source = 26;
 repeated uint32 forward_to_sysid = 27;
 optional uint32 cm_sysid = 28;
 optional uint32 launcher_type = 31 [default = 0];
 optional uint32 realm = 32 [default = 0];
 optional int32 timeout_ms = 33 [default = -1];
 optional string debug_source = 34;
 optional uint32 debug_source_string_index = 35;
 optional uint64 token_id = 36;
 optional GCRouting routing_gc = 37;
 oneof ip_addr { uint32 ip = 15; bytes ip_v6 = 29; }
}
message Multi { optional uint32 size_unzipped = 1; optional bytes message_body = 2; }
message HeartBeat { optional bool send_reply = 1; }
message Hello { optional uint32 protocol_version = 1; }
message Logon {
 optional uint32 protocol_version = 1;
 optional uint32 deprecated_obfustucated_private_ip = 2;
 optional uint32 cell_id = 3;
 optional uint32 last_session_id = 4;
 optional uint32 client_package_version = 5;
 optional string client_language = 6;
 optional uint32 client_os_type = 7;
 optional bool should_remember_password = 8 [default = false];
 optional string wine_version = 9;
 optional IPAddress obfuscated_private_ip = 11;
 optional uint32 deprecated_public_ip = 20;
 optional uint32 qos_level = 21;
 optional fixed64 client_supplied_steam_id = 22;
 optional IPAddress public_ip = 23;
 optional uint32 launcher_type = 31 [default = 0];
 optional uint32 ui_mode = 32 [default = 0];
 optional uint32 chat_mode = 33 [default = 0];
 optional string anon_user_target_account_name = 80;
 optional string machine_name = 96;
 optional uint64 client_instance_id = 100;
 optional bool supports_rate_limit_response = 102;
}
message LogonResponse {
 optional int32 eresult = 1 [default = 2];
 optional int32 legacy_out_of_game_heartbeat_seconds = 2;
 optional int32 heartbeat_seconds = 3;
 optional uint32 deprecated_public_ip = 4;
 optional fixed32 rtime32_server_time = 5;
 optional uint32 account_flags = 6;
 optional uint32 cell_id = 7;
 optional string email_domain = 8;
 optional bytes steam2_ticket = 9;
 optional int32 eresult_extended = 10;
 optional string webapi_authenticate_user_nonce = 11;
 optional uint32 cell_id_ping_threshold = 12;
 optional bool deprecated_use_pics = 13;
 optional string vanity_url = 14;
 optional IPAddress public_ip = 15;
 optional fixed64 client_supplied_steamid = 20;
 optional string ip_country_code = 21;
 optional bytes parental_settings = 22;
 optional bytes parental_setting_signature = 23;
 optional int32 count_loginfailures_to_migrate = 24;
 optional int32 count_disconnects_to_migrate = 25;
 optional int32 ogs_data_report_time_window = 26;
 optional uint64 client_instance_id = 27;
 optional bool force_client_update_check = 28;
 optional string agreement_session_url = 29;
 optional uint64 token_id = 30;
}
message LogOff {}
message LoggedOff { optional int32 eresult = 1 [default = 2]; }
message ProductInfoRequest {
 message App { optional uint32 appid = 1; optional uint64 access_token = 2; optional bool only_public_obsolete = 3; }
 message Package { optional uint32 packageid = 1; optional uint64 access_token = 2; }
 repeated Package packages = 1;
 repeated App apps = 2;
 optional bool meta_data_only = 3;
 optional uint32 num_prev_failed = 4;
 optional uint32 OBSOLETE_supports_package_tokens = 5;
 optional uint32 sequence_number = 6;
}
message ProductInfoResponse {
 message App {
  optional uint32 appid = 1; optional uint32 change_number = 2; optional bool missing_token = 3;
  optional bytes sha = 4; optional bytes buffer = 5; optional bool only_public = 6; optional uint32 size = 7;
 }
 message Package {
  optional uint32 packageid = 1; optional uint32 change_number = 2; optional bool missing_token = 3;
  optional bytes sha = 4; optional bytes buffer = 5; optional uint32 size = 6;
 }
 repeated App apps = 1;
 repeated uint32 unknown_appids = 2;
 repeated Package packages = 3;
 repeated uint32 unknown_packageids = 4;
 optional bool meta_data_only = 5;
 optional bool response_pending = 6;
 optional uint32 http_min_size = 7;
 optional string http_host = 8;
}
message AccessTokenRequest { repeated uint32 packageids = 1; repeated uint32 appids = 2; }
message AccessTokenResponse {
 message Package { optional uint32 packageid = 1; optional uint64 access_token = 2; }
 message App { optional uint32 appid = 1; optional uint64 access_token = 2; }
 repeated Package package_access_tokens = 1;
 repeated uint32 package_denied_tokens = 2;
 repeated App app_access_tokens = 3;
 repeated uint32 app_denied_tokens = 4;
}
message DepotKeyRequest { optional uint32 depot_id = 1; optional uint32 app_id = 2; }
message DepotKeyResponse {
 optional int32 eresult = 1 [default = 2]; optional uint32 depot_id = 2; optional bytes depot_encryption_key = 3;
}
message ManifestCodeRequest {
 optional uint32 app_id = 1; optional uint32 depot_id = 2; optional uint64 manifest_id = 3;
 optional string app_branch = 4; optional string branch_password_hash = 5;
}
message ManifestCodeResponse { optional uint64 manifest_request_code = 1; }
message ServersRequest {
 optional uint32 cell_id = 1; optional uint32 max_servers = 2 [default = 20];
 optional string ip_override = 3; optional int32 launcher_type = 4 [default = 0]; optional string ipv6_public = 5;
}
message ServerInfo {
 optional string type = 1; optional int32 source_id = 2; optional int32 cell_id = 3;
 optional int32 load = 4; optional float weighted_load = 5; optional int32 num_entries_in_client_list = 6;
 optional bool steam_china_only = 7; optional string host = 8; optional string vhost = 9;
 optional bool use_as_proxy = 10; optional string proxy_request_path_template = 11;
 optional string https_support = 12; repeated uint32 allowed_app_ids = 13; optional bool preferred_server = 14;
}
message ServersResponse { repeated ServerInfo servers = 1; }
`, {keepCase: true}).root.resolveAll();

const headerType = root.lookupType('Header');
const messageTypes = new Map([
	[EMsg.Multi, 'Multi'], [EMsg.ClientHeartBeat, 'HeartBeat'], [EMsg.ClientHello, 'Hello'],
	[EMsg.ClientLogon, 'Logon'], [EMsg.ClientLogOnResponse, 'LogonResponse'],
	[EMsg.ClientLogOff, 'LogOff'], [EMsg.ClientLoggedOff, 'LoggedOff'],
	[EMsg.ClientPICSProductInfoRequest, 'ProductInfoRequest'],
	[EMsg.ClientPICSProductInfoResponse, 'ProductInfoResponse'],
	[EMsg.ClientPICSAccessTokenRequest, 'AccessTokenRequest'],
	[EMsg.ClientPICSAccessTokenResponse, 'AccessTokenResponse'],
	[EMsg.ClientGetDepotDecryptionKey, 'DepotKeyRequest'],
	[EMsg.ClientGetDepotDecryptionKeyResponse, 'DepotKeyResponse']
].map(([id, name]) => [id, root.lookupType(name)]));
const unifiedTypes = new Map([
	['ContentServerDirectory.GetManifestRequestCode#1', ['ManifestCodeRequest', 'ManifestCodeResponse']],
	['ContentServerDirectory.GetServersForSteamPipe#1', ['ServersRequest', 'ServersResponse']]
].map(([name, types]) => [name, types.map(type => root.lookupType(type))]));
const wireTypes = Object.freeze({uint32: 0, int32: 0, bool: 0, uint64: 0, fixed64: 1, string: 2, bytes: 2, fixed32: 5, float: 5});

function bytes(value, name) {
	if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Buffer or Uint8Array`);
	return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function uint32(value, name) {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`${name} must be a uint32`);
	return value;
}

function uint64(value, name) {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError(`${name} must not be an unsafe Number; use a decimal string`);
	if (!['number', 'bigint', 'string'].includes(typeof value) || !/^(0|[1-9][0-9]{0,19})$/.test(String(value))) {
		throw new TypeError(`${name} must be an unsigned 64-bit decimal string, bigint or safe integer`);
	}
	if (BigInt(value) > 0xffffffffffffffffn) throw new RangeError(`${name} exceeds uint64`);
	return String(value);
}

function countField(budget) {
	if (++budget.fields > LIMITS.maxProtoFields) throw new RangeError('Protobuf field count limit exceeded');
}

// Check values BEFORE protobufjs.fromObject can coerce, truncate or wrap them.
function normalize(type, value, budget, depth = 0) {
	if (depth > LIMITS.maxProtoDepth) throw new RangeError('Protobuf nesting limit exceeded');
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) throw new TypeError(`${type.name} must be an object`);
	const result = {};
	for (const name of Object.keys(value)) {
		if (!Object.hasOwn(type.fields, name)) throw new TypeError(`Unknown ${type.name} field: ${name}`);
		const field = type.fields[name];
		if (value[name] === undefined || value[name] === null) continue;
		const values = field.repeated ? value[name] : [value[name]];
		if (!Array.isArray(values)) throw new TypeError(`${name} must be an array`);
		if (values.length > LIMITS.maxProtoFields) throw new RangeError('Protobuf field count limit exceeded');
		// Array.from visits holes too, so sparse input cannot turn into zero ids.
		const converted = Array.from(values, item => {
			countField(budget);
			if (field.resolvedType) return normalize(field.resolvedType, item, budget, depth + 1);
			if (field.type === 'uint64' || field.type === 'fixed64') return uint64(item, name);
			if (field.type === 'uint32' || field.type === 'fixed32') return uint32(item, name);
			if (field.type === 'int32' && (!Number.isInteger(item) || item < -2147483648 || item > 2147483647)) throw new RangeError(`${name} must be an int32`);
			if (field.type === 'bool' && typeof item !== 'boolean') throw new TypeError(`${name} must be a boolean`);
			if (field.type === 'float' && (typeof item !== 'number' || !Number.isFinite(Math.fround(item)))) throw new TypeError(`${name} must be a finite float32`);
			if (field.type === 'string') {
				if (typeof item !== 'string') throw new TypeError(`${name} must be a string`);
				budget.bytes += Buffer.byteLength(item);
			}
			if (field.type === 'bytes') { item = bytes(item, name); budget.bytes += item.length; }
			if (budget.bytes > budget.maxBytes) throw new RangeError('Protobuf byte limit exceeded');
			return item;
		});
		result[name] = field.repeated ? converted : converted[0];
	}
	return result;
}

function encodeProto(type, value, maxBytes = LIMITS.maxFrameBytes) {
	const normalized = normalize(type, value, {fields: 0, bytes: 0, maxBytes});
	const message = type.fromObject(normalized);
	const invalid = type.verify(message);
	if (invalid) throw new TypeError(`${type.name}: ${invalid}`);
	const encoded = Buffer.from(type.encode(message).finish());
	if (encoded.length > maxBytes) throw new RangeError('Protobuf byte limit exceeded');
	return encoded;
}

// Schema-aware bounds pass: protobufjs alone can cross a nested message boundary
// or silently discard high bits. Unknown length-delimited fields remain opaque.
function varint(buffer, cursor, end, bits = 64) {
	const count = bits === 32 ? 5 : 10;
	let value = 0;
	for (let i = 0; i < count; i++) {
		if (cursor.offset >= end) throw new RangeError('Truncated protobuf varint');
		const byte = buffer[cursor.offset++];
		if (i === count - 1 && byte > (bits === 32 ? 15 : 1)) throw new RangeError('Protobuf varint overflow');
		if (bits === 32) value += (byte & 127) * (2 ** (7 * i));
		if (!(byte & 128)) return value;
	}
	throw new RangeError('Protobuf varint overflow');
}

function validateWire(type, buffer, start, end, budget, depth = 0) {
	if (depth > LIMITS.maxProtoDepth) throw new RangeError('Protobuf nesting limit exceeded');
	const cursor = {offset: start};
	while (cursor.offset < end) {
		countField(budget);
		const tag = varint(buffer, cursor, end, 32);
		const id = tag >>> 3;
		const wire = tag & 7;
		if (!id) throw new Error('Invalid protobuf field number zero');
		const field = type.fieldsById[id];
		const expected = field ? (field.resolvedType ? 2 : wireTypes[field.type]) : undefined;
		const packed = field && field.repeated && expected !== 2 && wire === 2;
		if (field && wire !== expected && !packed) throw new Error(`Wrong protobuf wire type for ${type.name}.${field.name}`);
		if (wire === 0) {
			varint(buffer, cursor, end, field?.type === 'uint32' ? 32 : 64);
		} else if (wire === 1 || wire === 5) {
			cursor.offset += wire === 1 ? 8 : 4;
		} else if (wire === 2) {
			const length = varint(buffer, cursor, end, 32);
			const limit = cursor.offset + length;
			if (limit > end) throw new RangeError('Truncated protobuf length-delimited field');
			if (field?.resolvedType) validateWire(field.resolvedType, buffer, cursor.offset, limit, budget, depth + 1);
			if (packed) {
				while (cursor.offset < limit) {
					countField(budget);
					if (expected === 0) varint(buffer, cursor, limit, field.type === 'uint32' ? 32 : 64);
					else cursor.offset += expected === 1 ? 8 : 4;
				}
				if (cursor.offset !== limit) throw new RangeError('Truncated packed protobuf field');
			}
			cursor.offset = limit;
		} else {
			throw new Error(`Unsupported protobuf wire type ${wire}`);
		}
		if (cursor.offset > end) throw new RangeError('Truncated protobuf fixed-width field');
	}
}

function decodeProto(type, input) {
	const buffer = bytes(input, 'Protobuf body');
	if (buffer.length > LIMITS.maxFrameBytes) throw new RangeError('Protobuf byte limit exceeded');
	validateWire(type, buffer, 0, buffer.length, {fields: 0});
	return type.toObject(type.decode(buffer), {defaults: true, longs: String, bytes: Buffer});
}

function unifiedType(serviceName, direction) {
	if (direction !== 'request' && direction !== 'response') throw new TypeError('Unified direction must be request or response');
	const types = unifiedTypes.get(serviceName);
	if (!types) throw new Error(`Unsupported unified service: ${serviceName}`);
	return types[direction === 'request' ? 0 : 1];
}

function encodeUnified(serviceName, body, direction = 'request') {
	return encodeProto(unifiedType(serviceName, direction), body);
}

function decodeUnified(serviceName, buffer, direction = 'response') {
	return decodeProto(unifiedType(serviceName, direction), buffer);
}

function bodyType(emsg, header) {
	if (messageTypes.has(emsg)) return messageTypes.get(emsg);
	const types = unifiedTypes.get(header.target_job_name);
	if (!types) return undefined;
	if (emsg === EMsg.ServiceMethodResponse) return types[1];
	if (emsg === EMsg.ServiceMethodCallFromClient || emsg === EMsg.ServiceMethodCallFromClientNonAuthed) return types[0];
	return undefined;
}

/** Encode one WebSocket binary message, including the 4-byte header length. */
function encodeMessage(emsg, header = {}, body = {}) {
	uint32(emsg, 'EMsg');
	if (!emsg || emsg >= PROTO_MASK) throw new RangeError('EMsg must be nonzero and unflagged');
	const encodedHeader = encodeProto(headerType, header, LIMITS.maxHeaderBytes);
	const type = bodyType(emsg, header);
	if (!(body instanceof Uint8Array) && !type) throw new Error(`No protobuf schema for EMsg ${emsg}; supply an encoded body Buffer`);
	const encodedBody = body instanceof Uint8Array ? bytes(body, 'Message body') : encodeProto(type, body);
	const length = 8 + encodedHeader.length + encodedBody.length;
	if (length > LIMITS.maxFrameBytes) throw new RangeError('CM frame byte limit exceeded');
	const frame = Buffer.allocUnsafe(length);
	frame.writeUInt32LE((emsg | PROTO_MASK) >>> 0, 0);
	frame.writeUInt32LE(encodedHeader.length, 4);
	encodedHeader.copy(frame, 8);
	encodedBody.copy(frame, 8 + encodedHeader.length);
	return frame;
}

function splitFrame(input, maxBytes = LIMITS.maxFrameBytes) {
	const buffer = bytes(input, 'CM frame');
	if (buffer.length < 8) throw new RangeError('Truncated CM frame');
	if (buffer.length > maxBytes) throw new RangeError('CM frame byte limit exceeded');
	const flagged = buffer.readUInt32LE(0);
	if (!(flagged & PROTO_MASK)) throw new Error('Non-protobuf CM frame is unsupported');
	const emsg = flagged & 0x7fffffff;
	if (!emsg) throw new Error('Invalid CM EMsg zero');
	const headerLength = buffer.readUInt32LE(4);
	if (headerLength > LIMITS.maxHeaderBytes) throw new RangeError('CM header byte limit exceeded');
	if (headerLength > buffer.length - 8) throw new RangeError('Truncated CM header');
	return {emsg, headerBytes: buffer.subarray(8, 8 + headerLength), bodyBytes: buffer.subarray(8 + headerLength)};
}

/** Returned byte buffers are views; the input buffer is never modified. */
function decodeMessage(input) {
	const {emsg, headerBytes, bodyBytes} = splitFrame(input);
	const header = decodeProto(headerType, headerBytes);
	const type = bodyType(emsg, header);
	return {emsg, header, body: type ? decodeProto(type, bodyBytes) : bodyBytes, bodyBytes};
}

/**
 * Expand a decoded CMsgMulti (or its encoded protobuf body) into ordered LEAF
 * frame Buffers. Nested Multi envelopes are flattened, preserving wire order.
 * Limits count intermediate containers too, so nested gzip cannot reset budgets.
 * options can lower maxDepth, maxMessages, maxFrameBytes or maxExpandedBytes.
 * Leaf envelopes are checked here; decodeMessage checks their protobuf contents.
 * Non-protobuf leaves require the fixed 36-byte extended header (version 2,
 * canary 239) and stay opaque for the caller to ignore or dispatch separately.
 */
function unpackMulti(body, options = {}) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Multi options must be an object');
	const limits = {...LIMITS};
	for (const name of Object.keys(options)) {
		if (!['maxDepth', 'maxMessages', 'maxFrameBytes', 'maxExpandedBytes'].includes(name)) throw new TypeError(`Unknown Multi limit: ${name}`);
		if (!Number.isSafeInteger(options[name]) || options[name] < 1 || options[name] > LIMITS[name]) throw new RangeError(`Invalid Multi limit: ${name}`);
		limits[name] = options[name];
	}
	const output = [];
	let expanded = 0;
	let messages = 0;
	function visit(input, depth) {
		if (depth > limits.maxDepth) throw new RangeError('Multi nesting limit exceeded');
		const value = input instanceof Uint8Array ? decodeProto(messageTypes.get(EMsg.Multi), input) : input;
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Multi body must be an object or encoded protobuf Buffer');
		const size = uint32(value.size_unzipped ?? 0, 'size_unzipped');
		let payload = bytes(value.message_body ?? Buffer.alloc(0), 'message_body');
		if (payload.length > limits.maxFrameBytes) throw new RangeError('Multi input byte limit exceeded');
		const remaining = limits.maxExpandedBytes - expanded;
		if ((size || payload.length) > remaining) throw new RangeError('Multi expanded byte limit exceeded');
		if (size) {
			try {
				payload = gunzipSync(payload, {maxOutputLength: size});
			} catch (cause) {
				throw new Error('Invalid or oversized Multi gzip payload', {cause});
			}
			if (payload.length !== size) throw new Error('Multi gzip size_unzipped mismatch');
		}
		expanded += payload.length;
		let offset = 0;
		while (offset < payload.length) {
			if (payload.length - offset < 4) throw new RangeError('Truncated Multi child length');
			const length = payload.readUInt32LE(offset);
			offset += 4;
			if (length < 8 || length > limits.maxFrameBytes) throw new RangeError('Invalid Multi child length');
			if (length > payload.length - offset) throw new RangeError('Truncated Multi child frame');
			if (++messages > limits.maxMessages) throw new RangeError('Multi message count limit exceeded');
				const child = payload.subarray(offset, offset + length);
				offset += length;
				if (!(child.readUInt32LE(0) & PROTO_MASK)) {
					// Legacy layout: EMsg[0], size[4], version[5], job ids[7,15],
					// canary[23], SteamID[24], session[32]. Never decode its body.
					if (child.length < 36 || !child.readUInt32LE(0) || child[4] !== 36 ||
						child.readUInt16LE(5) !== 2 || child[23] !== 239) {
						throw new Error('Invalid legacy CM header in Multi leaf');
					}
					output.push(child);
					continue;
				}
				const parts = splitFrame(child, limits.maxFrameBytes);
			if (parts.emsg === EMsg.Multi) {
				decodeProto(headerType, parts.headerBytes);
				visit(parts.bodyBytes, depth + 1);
			} else output.push(child);
		}
	}
	visit(body, 1);
	return output;
}

module.exports = {EMsg, PROTO_MASK, JOBID_NONE, ANON_STEAM_ID, PROTOCOL_VERSION, LIMITS,
	encodeMessage, decodeMessage, encodeUnified, decodeUnified, unpackMulti};
