import { inflateRawSync } from "node:zlib";

/**
 * A minimal zip reader for EPUB import (fork plan 05; agent-selected, no
 * dependency): the central directory, stored and deflated entries, UTF-8
 * names. No zip64, encryption or multi-disk archives; those are refused.
 * Entries inflate on demand, each and all together under a size cap, so a
 * crafted archive can't exhaust memory.
 */

export class ZipError extends Error {}

export interface ZipReader {
	names: string[];
	/** The entry's bytes, or null when the archive has no such entry. */
	read(name: string): Buffer | null;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function openZip(data: Uint8Array, limits: { entryBytes: number; totalBytes: number }): ZipReader {
	const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
		if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
	}
	if (eocd < 0) throw new ZipError("Not a zip archive.");
	const count = buf.readUInt16LE(eocd + 10);
	const dirSize = buf.readUInt32LE(eocd + 12);
	const dirOffset = buf.readUInt32LE(eocd + 16);
	if (count === 0xffff || dirOffset === 0xffffffff || dirOffset + dirSize > buf.length) throw new ZipError("Unsupported zip archive.");
	const entries = new Map<string, { method: number; compressed: number; size: number; local: number; flags: number }>();
	let at = dirOffset;
	for (let k = 0; k < count; k++) {
		if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError("Damaged zip directory.");
		const flags = buf.readUInt16LE(at + 8);
		const method = buf.readUInt16LE(at + 10);
		const compressed = buf.readUInt32LE(at + 20);
		const size = buf.readUInt32LE(at + 24);
		const nameLength = buf.readUInt16LE(at + 28);
		const extraLength = buf.readUInt16LE(at + 30);
		const commentLength = buf.readUInt16LE(at + 32);
		const local = buf.readUInt32LE(at + 42);
		const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		entries.set(name, { method, compressed, size, local, flags });
		at += 46 + nameLength + extraLength + commentLength;
	}
	let total = 0;
	return {
		names: [...entries.keys()],
		read(name) {
			const entry = entries.get(name);
			if (!entry) return null;
			if (entry.flags & 1) throw new ZipError("Encrypted zip entries aren't supported.");
			if (entry.size > limits.entryBytes || entry.size === 0xffffffff) throw new ZipError("A file inside the archive is too large.");
			if (entry.local + 30 > buf.length || buf.readUInt32LE(entry.local) !== LOCAL) throw new ZipError("Damaged zip entry.");
			const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
			const raw = buf.subarray(start, start + entry.compressed);
			if (raw.length !== entry.compressed) throw new ZipError("Damaged zip entry.");
			let out: Buffer;
			if (entry.method === 0) out = Buffer.from(raw);
			else if (entry.method === 8) {
				try { out = inflateRawSync(raw, { maxOutputLength: limits.entryBytes }); }
				catch { throw new ZipError("Damaged zip entry."); }
			} else throw new ZipError("Unsupported zip compression.");
			total += out.length;
			if (total > limits.totalBytes) throw new ZipError("The archive expands to too much data.");
			return out;
		},
	};
}
