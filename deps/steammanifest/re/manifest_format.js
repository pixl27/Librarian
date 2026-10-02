'use strict';

/**
 * Independent Steam protobuf-manifest decoder. Production uses Node crypto/zlib
 * and generic protobufjs, never steam-user's manifest, ZIP or crypto code.
 * Read-only format references: steam-user 5.3.0 content_manifest.proto,
 * components/content_manifest.js and cdn_compression.js, steam-crypto's AES
 * contract, and re/output/1007/1004_5612541580377302256.{raw,manifest}.
 * Tests pin the original fixture bytes and use installed implementations as oracles.
 *
 * Supported ZIP: exactly one classic STORE/DEFLATE entry, central directory and
 * EOCD; bit-3 descriptors may have or omit their signature. ZIP64, split or
 * encrypted ZIPs, unsupported flags/methods, missing directories and gaps fail.
 * VZip, Zstd and the legacy non-protobuf manifest layout are not implemented.
 * Plain paths use forward slashes, without resolving dot components or absolutes.
 * Signature bytes are preserved without authentication; CRC does not prove trust.
 */

const zlib = require('zlib');
const crypto = require('crypto');
const protobuf = require('protobufjs');
const { constants: BUFFER_CONSTANTS } = require('buffer');
const { TextDecoder } = require('util');

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAGIC = Object.freeze({
	PAYLOAD: 0x71f617d0,
	METADATA: 0x1f4812be,
	SIGNATURE: 0x1b81b817,
	END: 0x32c415ab,
	STEAM2: 0x16349781, // Compatibility export: legacy non-protobuf layout.
});

// Field numbers and types from Valve's content_manifest.proto, shipped with
// steam-user. Runtime framing and validation below are independently implemented.
const MANIFEST_PROTO = `
message ContentManifestPayload {
	message FileMapping {
		message ChunkData {
			optional bytes sha = 1;
			optional fixed32 crc = 2;
			optional uint64 offset = 3;
			optional uint32 cb_original = 4;
			optional uint32 cb_compressed = 5;
		}
		optional string filename = 1;
		optional uint64 size = 2;
		optional uint32 flags = 3;
		optional bytes sha_filename = 4;
		optional bytes sha_content = 5;
		repeated ContentManifestPayload.FileMapping.ChunkData chunks = 6;
		optional string linktarget = 7;
	}
	repeated ContentManifestPayload.FileMapping mappings = 1;
}
message ContentManifestMetadata {
	optional uint32 depot_id = 1;
	optional uint64 gid_manifest = 2;
	optional uint32 creation_time = 3;
	optional bool filenames_encrypted = 4;
	optional uint64 cb_disk_original = 5;
	optional uint64 cb_disk_compressed = 6;
	optional uint32 unique_chunks = 7;
	optional uint32 crc_encrypted = 8;
	optional uint32 crc_clear = 9;
}
message ContentManifestSignature {
	optional bytes signature = 1;
}
`;

const root = protobuf.parse(MANIFEST_PROTO, { keepCase: true }).root.resolveAll();
const ContentManifestPayload = root.lookupType('ContentManifestPayload');
const ContentManifestMetadata = root.lookupType('ContentManifestMetadata');
const ContentManifestSignature = root.lookupType('ContentManifestSignature');

function decompress(blob, options) {
	blob = asBuffer(blob, 'CDN container');
	const limit = outputLimit(options);
	requireBytes(blob, 0, 4, 'container header');
	if (blob.readUInt32LE(0) === 0x04034b50) {
		return inflateZip(blob, limit);
	}
	const header = blob.subarray(0, 4).toString('latin1');
	throw new Error(`Unsupported container header ${JSON.stringify(header)} (${blob.subarray(0, 4).toString('hex')}); only classic ZIP is supported`);
}

function inflateZip(buf, limit) {
	requireBytes(buf, 0, 30, 'ZIP local header');
	const endAt = findZipEnd(buf);
	const disk = buf.readUInt16LE(endAt + 4);
	const centralDisk = buf.readUInt16LE(endAt + 6);
	const diskEntries = buf.readUInt16LE(endAt + 8);
	const entries = buf.readUInt16LE(endAt + 10);
	const centralSize = buf.readUInt32LE(endAt + 12);
	const centralAt = buf.readUInt32LE(endAt + 16);
	if (diskEntries === 0xffff || entries === 0xffff || centralSize === 0xffffffff || centralAt === 0xffffffff) {
		throw new Error('ZIP64 is not supported');
	}
	if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries) {
		throw new Error('Multi-disk ZIP archives are not supported');
	}
	if (entries !== 1) {
		throw new Error(`ZIP must contain exactly one entry; found ${entries}`);
	}
	if (centralSize < 46 || centralAt < 30 || centralAt + centralSize !== endAt) {
		throw new Error('Invalid ZIP central directory bounds or unsupported trailing records');
	}
	requireBytes(buf, centralAt, centralSize, 'ZIP central directory');
	if (buf.readUInt32LE(centralAt) !== 0x02014b50) {
		throw new Error('Missing ZIP central directory entry');
	}
	const version = buf.readUInt16LE(centralAt + 6);
	const flags = buf.readUInt16LE(centralAt + 8);
	const method = buf.readUInt16LE(centralAt + 10);
	const crcExpected = buf.readUInt32LE(centralAt + 16);
	const compressedSize = buf.readUInt32LE(centralAt + 20);
	const uncompressedSize = buf.readUInt32LE(centralAt + 24);
	const nameLen = buf.readUInt16LE(centralAt + 28);
	const extraLen = buf.readUInt16LE(centralAt + 30);
	const commentLen = buf.readUInt16LE(centralAt + 32);
	const localDisk = buf.readUInt16LE(centralAt + 34);
	const localAt = buf.readUInt32LE(centralAt + 42);
	if (version >= 45 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localAt === 0xffffffff || localDisk === 0xffff) {
		throw new Error('ZIP64 or ZIP version 4.5+ is not supported');
	}
	if (localDisk !== 0) {
		throw new Error('Multi-disk ZIP entries are not supported');
	}
	if (version > 20) {
		throw new Error(`Unsupported ZIP version needed ${version}`);
	}
	if (flags & 0x2041) {
		throw new Error('Encrypted ZIP entries are not supported');
	}
	if (method !== 0 && method !== 8) {
		throw new Error(`Unsupported ZIP compression method ${method}`);
	}
	// Bit 3 = descriptor; bit 11 = UTF-8; bits 1/2 = DEFLATE tuning.
	const allowedFlags = 0x0808 | (method === 8 ? 0x0006 : 0);
	if (flags & ~allowedFlags) {
		throw new Error(`Unsupported ZIP flags ${hex32(flags)}`);
	}
	if (localAt !== 0 || nameLen === 0 || 46 + nameLen + extraLen + commentLen !== centralSize) {
		throw new Error('Invalid single-entry ZIP central directory layout');
	}
	validateZipExtra(buf.subarray(centralAt + 46 + nameLen, centralAt + 46 + nameLen + extraLen));
	if (uncompressedSize > limit) {
		throw new Error(`ZIP output size ${uncompressedSize} exceeds maxOutputBytes ${limit}`);
	}

	const localNameLen = buf.readUInt16LE(26);
	const localExtraLen = buf.readUInt16LE(28);
	const dataStart = 30 + localNameLen + localExtraLen;
	if (dataStart > centralAt || !buf.subarray(30, 30 + localNameLen).equals(buf.subarray(centralAt + 46, centralAt + 46 + nameLen))) {
		throw new Error('ZIP local filename or extra field bounds disagree with the central directory');
	}
	if (buf.readUInt16LE(4) !== version || buf.readUInt16LE(6) !== flags || buf.readUInt16LE(8) !== method) {
		throw new Error('ZIP local header disagrees with central directory version, flags or method');
	}
	validateZipExtra(buf.subarray(30 + localNameLen, dataStart));
	const localValues = [buf.readUInt32LE(14), buf.readUInt32LE(18), buf.readUInt32LE(22)];
	const expectedValues = [crcExpected, compressedSize, uncompressedSize];
	const hasDescriptor = !!(flags & 8);
	for (let i = 0; i < expectedValues.length; i++) {
		if (localValues[i] !== expectedValues[i] && !(hasDescriptor && localValues[i] === 0)) {
			throw new Error('ZIP local CRC or size disagrees with the central directory');
		}
	}
	const dataEnd = dataStart + compressedSize;
	if (dataEnd > centralAt) {
		throw new Error('Truncated ZIP compressed data or overlapping central directory');
	}
	if (hasDescriptor) {
		const descriptorSize = centralAt - dataEnd;
		if (descriptorSize !== 12 && descriptorSize !== 16) {
			throw new Error(`Unsupported or missing ZIP data descriptor (${descriptorSize} bytes); ZIP64 descriptors are not supported`);
		}
		let descriptorAt = dataEnd;
		if (descriptorSize === 16) {
			if (buf.readUInt32LE(descriptorAt) !== 0x08074b50) {
				throw new Error('Invalid ZIP data descriptor signature');
			}
			descriptorAt += 4;
		}
		for (let i = 0; i < expectedValues.length; i++) {
			if (buf.readUInt32LE(descriptorAt + 4 * i) !== expectedValues[i]) {
				throw new Error('ZIP data descriptor CRC or size disagrees with the central directory');
			}
		}
	} else if (dataEnd !== centralAt) {
		throw new Error('Unexpected bytes or additional entries before the ZIP central directory');
	}

	const compressed = buf.subarray(dataStart, dataEnd);
	let out;
	if (method === 0) {
		if (compressedSize !== uncompressedSize) {
			throw new Error('ZIP STORE compressed and uncompressed sizes must match');
		}
		out = Buffer.from(compressed);
	} else {
		let inflated;
		try {
			// zlib requires a positive bound even for empty streams. Exact size zero
			// is still checked below, and lying sizes cannot bypass allocation limits.
			inflated = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize), info: true });
		} catch (err) {
			throw new Error(`Invalid ZIP DEFLATE data or output exceeds declared size: ${err.message}`, { cause: err });
		}
		if (inflated.engine.bytesWritten !== compressedSize) {
			throw new Error('ZIP compressed data contains trailing bytes or another DEFLATE stream');
		}
		out = inflated.buffer;
	}
	if (out.length !== uncompressedSize) {
		throw new Error(`ZIP size mismatch: expected ${uncompressedSize}, inflated ${out.length}`);
	}
	const crcActual = crc32(out);
	if (crcActual !== crcExpected) {
		throw new Error(`ZIP CRC mismatch: expected ${hex32(crcExpected)}, computed ${hex32(crcActual)}`);
	}
	return { data: out, method, compressedSize, crc: crcActual };
}

function findZipEnd(buf) {
	let found = -1;
	for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at--) {
		if (buf.readUInt32LE(at) === 0x06054b50 && at + 22 + buf.readUInt16LE(at + 20) === buf.length) {
			if (found !== -1) {
				throw new Error('Ambiguous ZIP end-of-central-directory records');
			}
			found = at;
		}
	}
	if (found === -1) {
		throw new Error('Missing or truncated ZIP end-of-central-directory record, or trailing bytes; local-header-only ZIP is unsupported');
	}
	return found;
}

function validateZipExtra(extra) {
	let at = 0;
	while (at < extra.length) {
		requireBytes(extra, at, 4, 'ZIP extra field header');
		const id = extra.readUInt16LE(at);
		const size = extra.readUInt16LE(at + 2);
		at += 4;
		requireBytes(extra, at, size, 'ZIP extra field body');
		if (id === 0x0001) {
			throw new Error('ZIP64 extra fields are not supported');
		}
		if (id === 0x9901 || id === 0x0017) {
			throw new Error('Encrypted ZIP extra fields are not supported');
		}
		at += size;
	}
}

function parseManifest(buf, options) {
	buf = asBuffer(buf, 'Manifest');
	const limit = outputLimit(options);
	if (buf.length > limit) {
		throw new Error(`Manifest size ${buf.length} exceeds maxOutputBytes ${limit}`);
	}
	const sections = [];
	const seen = new Map();
	let offset = 0;
	let ended = false;
	while (offset < buf.length) {
		const at = offset;
		requireBytes(buf, offset, 4, 'manifest section magic');
		const magic = buf.readUInt32LE(offset);
		offset += 4;
		if (magic === MAGIC.END) {
			sections.push({ name: 'ENDOFMANIFEST', at, len: 0 });
			ended = true;
			if (offset !== buf.length) {
				throw new Error('Trailing bytes after manifest END marker');
			}
			break;
		}
		if (magic === MAGIC.STEAM2) {
			throw new Error('Legacy non-protobuf manifest (0x16349781) is not supported');
		}
		const name = magic === MAGIC.PAYLOAD ? 'PAYLOAD' : magic === MAGIC.METADATA ? 'METADATA' : magic === MAGIC.SIGNATURE ? 'SIGNATURE' : null;
		if (!name) {
			throw new Error(`Unknown section magic ${hex32(magic)} at offset ${at}`);
		}
		if (seen.has(magic)) {
			throw new Error(`Duplicate manifest ${name} section at offset ${at}`);
		}
		requireBytes(buf, offset, 4, `manifest ${name} length`);
		const len = buf.readUInt32LE(offset);
		offset += 4;
		requireBytes(buf, offset, len, `manifest ${name} body`);
		seen.set(magic, buf.subarray(offset, offset + len));
		sections.push({ name, at, len });
		offset += len;
	}
	if (!ended) {
		throw new Error('Manifest is missing its END marker');
	}
	for (const name of ['PAYLOAD', 'METADATA', 'SIGNATURE']) {
		if (!seen.has(MAGIC[name])) {
			throw new Error(`Manifest is missing its ${name} section`);
		}
	}
	const payload = decodeSection(seen.get(MAGIC.PAYLOAD), ContentManifestPayload);
	const m = decodeSection(seen.get(MAGIC.METADATA), ContentManifestMetadata);
	const signature = decodeSection(seen.get(MAGIC.SIGNATURE), ContentManifestSignature);
	const encrypted = !!m.filenames_encrypted;
	const files = payload.mappings.map((f) => ({
		filename: encrypted ? f.filename : normalizePath(f.filename),
		size: longStr(f.size),
		flags: f.flags >>> 0,
		sha_content: toHex(f.sha_content),
		sha_filename: toHex(f.sha_filename),
		linktarget: f.linktarget ? (encrypted ? f.linktarget : normalizePath(f.linktarget)) : undefined,
		chunks: (f.chunks || []).map((c) => ({
			sha: toHex(c.sha),
			crc: c.crc >>> 0,
			offset: longStr(c.offset),
			cb_original: c.cb_original >>> 0,
			cb_compressed: c.cb_compressed >>> 0,
		})),
	}));
	return {
		depot_id: m.depot_id,
		gid_manifest: longStr(m.gid_manifest),
		creation_time: m.creation_time,
		filenames_encrypted: encrypted,
		cb_disk_original: longStr(m.cb_disk_original),
		cb_disk_compressed: longStr(m.cb_disk_compressed),
		unique_chunks: m.unique_chunks,
		crc_clear: m.crc_clear >>> 0,
		crc_encrypted: m.crc_encrypted >>> 0,
		files,
		sections,
		signature: Buffer.from(signature.signature),
		signature_section: Buffer.from(seen.get(MAGIC.SIGNATURE)),
		signature_verified: false,
	};
}

// Validate protobuf wire bounds and integer widths before generic decoding.
// Unknown fields of ordinary wire types are allowed; deprecated groups are not.
function decodeSection(body, type) {
	try {
		validateMessage(body, type);
		return type.decode(body);
	} catch (err) {
		throw new Error(`Invalid ${type.name} protobuf: ${err.message}`, { cause: err });
	}
}

function validateMessage(body, type) {
	const cursor = { at: 0 };
	while (cursor.at < body.length) {
		const tag = Number(readVarint(body, cursor, 32));
		const fieldId = tag >>> 3;
		const wire = tag & 7;
		if (fieldId === 0) {
			throw new Error('Invalid protobuf field number zero');
		}
		const field = type.fieldsById[fieldId];
		if (field) {
			const expectedWire = field.resolvedType instanceof protobuf.Type || ['string', 'bytes'].includes(field.type) ? 2 : field.type === 'fixed32' ? 5 : 0;
			if (wire !== expectedWire) {
				throw new Error(`Wrong protobuf wire type for ${type.name}.${field.name}`);
			}
		}
		if (wire === 0) {
			readVarint(body, cursor, field && ['uint32', 'bool'].includes(field.type) ? 32 : 64);
		} else if (wire === 1 || wire === 5) {
			const size = wire === 1 ? 8 : 4;
			requireBytes(body, cursor.at, size, 'protobuf fixed field');
			cursor.at += size;
		} else if (wire === 2) {
			const size = Number(readVarint(body, cursor, 32));
			requireBytes(body, cursor.at, size, 'protobuf length-delimited field');
			const value = body.subarray(cursor.at, cursor.at + size);
			if (field && field.resolvedType instanceof protobuf.Type) {
				validateMessage(value, field.resolvedType);
			} else if (field && field.type === 'string') {
				UTF8.decode(value);
			}
			cursor.at += size;
		} else {
			throw new Error(`Unsupported protobuf wire type ${wire}; groups are not supported`);
		}
	}
}

function readVarint(body, cursor, bits) {
	let value = 0n;
	const count = Math.ceil(bits / 7);
	for (let i = 0; i < count; i++) {
		requireBytes(body, cursor.at, 1, 'protobuf varint');
		const byte = body[cursor.at++];
		if (i === count - 1 && (byte & 0x7f) >= 2 ** (bits - 7 * i)) {
			throw new Error(`Protobuf uint${bits} varint overflow`);
		}
		value |= BigInt(byte & 0x7f) << BigInt(7 * i);
		if (!(byte & 0x80)) {
			return value;
		}
	}
	throw new Error(`Overlong protobuf uint${bits} varint`);
}

// Steam AES: ECB-decrypt the first block to obtain the IV, then CBC-decrypt the
// remaining blocks with PKCS#7 padding. This primitive does not authenticate data.
function steamSymmetricDecrypt(input, key) {
	input = asBuffer(input, 'AES ciphertext');
	key = asBuffer(key, 'AES key');
	if (key.length !== 32) {
		throw new Error('Steam AES key must contain exactly 32 bytes');
	}
	if (input.length < 32 || input.length % 16 !== 0) {
		throw new Error('Steam AES ciphertext must contain an encrypted IV and complete CBC blocks');
	}
	const ecb = crypto.createDecipheriv('aes-256-ecb', key, null);
	ecb.setAutoPadding(false);
	const iv = Buffer.concat([ecb.update(input.subarray(0, 16)), ecb.final()]);
	const cbc = crypto.createDecipheriv('aes-256-cbc', key, iv);
	return Buffer.concat([cbc.update(input.subarray(16)), cbc.final()]);
}

function decryptFilenames(manifest, key) {
	if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
		throw new TypeError('Manifest must have a files array');
	}
	if (!manifest.filenames_encrypted) {
		return manifest;
	}
	key = asBuffer(key, 'AES key');
	if (key.length !== 32) {
		throw new Error('Steam AES key must contain exactly 32 bytes');
	}
	assertWritableField(manifest, 'filenames_encrypted');
	// Stage before mutating, including checking all writable data properties.
	// Array.from visits sparse slots too, so a hole cannot fail during commit.
	const staged = Array.from(manifest.files, (file, index) => {
		if (!file || typeof file !== 'object') {
			throw new TypeError(`Invalid manifest file at index ${index}`);
		}
		assertWritableField(file, 'filename');
		const filename = decryptPath(file.filename, key, `file ${index} filename`);
		let linktarget;
		if (file.linktarget != null && file.linktarget !== '') {
			assertWritableField(file, 'linktarget');
			linktarget = decryptPath(file.linktarget, key, `file ${index} linktarget`);
		}
		return { file, filename, linktarget };
	});
	for (const { file, filename, linktarget } of staged) {
		file.filename = filename;
		if (linktarget !== undefined) {
			file.linktarget = linktarget;
		}
	}
	manifest.filenames_encrypted = false;
	return manifest;
}

function decryptPath(value, key, label) {
	try {
		if (typeof value !== 'string') {
			throw new Error('Encrypted path must be a base64 string');
		}
		// All native fixture names end in LF. Fold ASCII whitespace only; Node's
		// Buffer base64 decoder alone would also silently discard invalid bytes.
		const base64 = value.replace(/[\x09-\x0d\x20]/g, '');
		if (base64.length === 0 || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
			throw new Error('Encrypted path must be canonical padded base64 with optional ASCII whitespace');
		}
		const cipher = Buffer.from(base64, 'base64');
		if (cipher.toString('base64') !== base64) {
			throw new Error('Encrypted path has noncanonical base64 padding bits');
		}
		const clear = steamSymmetricDecrypt(cipher, key);
		const nul = clear.indexOf(0);
		if (nul < 0 || clear.subarray(nul + 1).some((byte) => byte !== 0)) {
			throw new Error('Decrypted path must be NUL-terminated with only zero bytes after the terminator');
		}
		return normalizePath(UTF8.decode(clear.subarray(0, nul)));
	} catch (err) {
		throw new Error(`Cannot decrypt ${label}: ${err.message}`, { cause: err });
	}
}

function assertWritableField(target, key) {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.writable) {
		throw new TypeError(`Manifest ${key} must be an own writable data property`);
	}
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let value = n;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[n] = value >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let value = 0xffffffff;
	for (const byte of buf) {
		value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
	}
	return (value ^ 0xffffffff) >>> 0;
}

function toHex(value) {
	return value && value.length ? Buffer.from(value).toString('hex') : undefined;
}

function longStr(value) {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) {
		throw new Error('Exact uint64 decoding requires protobufjs Long support');
	}
	return value == null ? '0' : value.toString();
}

function normalizePath(value) {
	return value.replace(/\\/g, '/');
}

function asBuffer(value, label) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	}
	throw new TypeError(`${label} must be a Buffer or Uint8Array`);
}

function outputLimit(options = {}) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('Options must be an object');
	}
	const limit = options.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : options.maxOutputBytes;
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > BUFFER_CONSTANTS.MAX_LENGTH) {
		throw new RangeError(`maxOutputBytes must be an integer from 0 to ${BUFFER_CONSTANTS.MAX_LENGTH}`);
	}
	return limit;
}

function requireBytes(buf, at, count, label) {
	if (at < 0 || count < 0 || at > buf.length || count > buf.length - at) {
		throw new Error(`Truncated ${label} at offset ${at}: need ${count} bytes, have ${Math.max(0, buf.length - at)}`);
	}
}

function hex32(value) {
	return '0x' + (value >>> 0).toString(16).padStart(8, '0');
}

module.exports = {
	MAGIC,
	DEFAULT_MAX_OUTPUT_BYTES,
	decompress,
	parseManifest,
	steamSymmetricDecrypt,
	decryptFilenames,
	crc32,
};
