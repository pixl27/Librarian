'use strict';

function unsigned(value, bits, label, allowZero = false) {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) {
		throw new Error(`${label} must be an exact integer; pass large IDs as decimal strings`);
	}
	if (!['string', 'number', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) {
		throw new Error(`${label} must be a positive decimal integer`);
	}
	const n = BigInt(value);
	if (n < (allowZero ? 0n : 1n) || n >= (1n << BigInt(bits))) {
		throw new Error(`${label} is outside the uint${bits} range`);
	}
	return n.toString();
}

const uint32 = (value, label = 'ID', allowZero = false) => Number(unsigned(value, 32, label, allowZero));
const uint64 = (value, label = 'ID', allowZero = false) => unsigned(value, 64, label, allowZero);

module.exports = { uint32, uint64 };
