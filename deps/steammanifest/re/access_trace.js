'use strict';

// Whitelisted observations from already-decoded CM replies. Never retain a whole
// header/body: those can contain account identifiers, request codes or depot keys.
const { Reader } = require('protobufjs');
const { EMsg } = require('./cm_wire');
const MANIFEST_SERVICE = 'ContentServerDirectory.GetManifestRequestCode#1';
const SERVER_SERVICE = 'ContentServerDirectory.GetServersForSteamPipe#1';

function statusField(buffer, number) {
	const reader = Reader.create(buffer);
	let hex = null;
	let occurrences = 0;
	while (reader.pos < reader.len) {
		const start = reader.pos;
		const tag = reader.uint32();
		reader.skipType(tag & 7);
		if ((tag >>> 3) === number) {
			// cm_wire has validated the type and bounds. Preserve the last occurrence,
			// matching protobuf singular-field semantics, including noncanonical bytes.
			hex = buffer.subarray(start, reader.pos).toString('hex');
			occurrences++;
		}
	}
	return { number, present: occurrences > 0, occurrences, hex };
}

function summarizeCMResult(packet, frame) {
	const { emsg, header, body, bodyBytes } = frame;
	let source;
	let stage;
	if (emsg === EMsg.ServiceMethodResponse && [MANIFEST_SERVICE, SERVER_SERVICE].includes(header.target_job_name)) {
		source = 'header';
		stage = header.target_job_name === MANIFEST_SERVICE ? 'manifest-request-code' : 'content-directory';
	} else if (emsg === EMsg.ClientGetDepotDecryptionKeyResponse) {
		source = 'body'; stage = 'depot-key';
	} else if (emsg === EMsg.ClientLogOnResponse) {
		source = 'body'; stage = 'login';
	} else if (emsg === EMsg.ClientLoggedOff) {
		source = 'body'; stage = 'logoff';
	} else return undefined;
	const headerBytes = packet.subarray(8, 8 + packet.readUInt32LE(4));
	const result = {
		stage,
		eresult: (source === 'header' ? header : body).eresult,
		statusField: { source, ...statusField(source === 'header' ? headerBytes : bodyBytes, source === 'header' ? 13 : 1) },
		bodyBytes: bodyBytes.length,
		errorMessagePresent: Boolean(header.error_message),
	};
	if (stage === 'manifest-request-code') result.requestCodePresent = Boolean(body.manifest_request_code && body.manifest_request_code !== '0');
	if (stage === 'depot-key') result.depotKeyBytes = body.depot_encryption_key?.length || 0;
	return result;
}

module.exports = { summarizeCMResult };
