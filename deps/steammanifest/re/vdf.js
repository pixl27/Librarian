'use strict';

// Text KeyValues as returned in PICS app buffers. No file directives or evaluation.
function parseVdf(input, { maxDepth = 64, maxTokens = 1000000 } = {}) {
	let source = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
	source = source.replace(/^\uFEFF/, '').replace(/\0+$/, '');
	if (source.includes('\0')) throw new Error('VDF contains an interior NUL');
	let pos = 0;
	let tokens = 0;
	const fail = (message) => { throw new Error(`VDF ${message} at offset ${pos}`); };
	function next() {
		while (pos < source.length) {
			if (/\s/.test(source[pos])) { pos++; continue; }
			if (source.startsWith('//', pos)) {
				const end = source.indexOf('\n', pos + 2);
				pos = end < 0 ? source.length : end + 1;
				continue;
			}
			break;
		}
		if (pos === source.length) return null;
		if (++tokens > maxTokens) fail('token limit exceeded');
		const char = source[pos++];
		if (char === '{' || char === '}') return { kind: char };
		if (char === '"') {
			let value = '';
			while (pos < source.length) {
				const c = source[pos++];
				if (c === '"') return { kind: 'text', value };
				if (c === '\\') {
					if (pos === source.length) fail('unfinished escape');
					const escaped = source[pos++];
					const escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
					value += Object.hasOwn(escapes, escaped) ? escapes[escaped] : '\\' + escaped;
				} else {
					value += c;
				}
			}
			fail('unterminated quoted string');
		}
		const start = pos - 1;
		while (pos < source.length && !/[\s{}"]/.test(source[pos])) pos++;
		return { kind: 'text', value: source.slice(start, pos) };
	}
	function object(depth) {
		if (depth > maxDepth) fail('nesting limit exceeded');
		const out = Object.create(null);
		for (;;) {
			const key = next();
			if (key === null) {
				if (depth) fail('missing closing brace');
				return out;
			}
			if (key.kind === '}') {
				if (!depth) fail('unexpected closing brace');
				return out;
			}
			if (key.kind !== 'text') fail('expected a key');
			if (key.value.startsWith('#') || key.value.startsWith('[')) fail('unsupported directive or conditional');
			const value = next();
			if (!value || value.kind === '}') fail(`missing value for ${JSON.stringify(key.value)}`);
			// Duplicate keys use the last value, matching the existing PICS consumer.
			out[key.value] = value.kind === '{' ? object(depth + 1) : value.value;
		}
	}
	return object(0);
}

module.exports = { parseVdf };
