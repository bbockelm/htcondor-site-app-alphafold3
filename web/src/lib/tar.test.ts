import { describe, it, expect } from 'vitest';
import { readTar, entryText } from './tar';

/** A tar entry, built the way tar builds one. */
function entry(name: string, body: string): Uint8Array {
  const data = new TextEncoder().encode(body);
  const blocks = Math.ceil(data.length / 512);
  const out = new Uint8Array(512 + blocks * 512);
  out.set(new TextEncoder().encode(name), 0);
  // Size: 11 octal digits and a NUL, at offset 124.
  out.set(
    new TextEncoder().encode(data.length.toString(8).padStart(11, '0') + '\0'),
    124,
  );
  out.set(data, 512);
  return out;
}

function archive(...parts: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024); // two zero blocks
  const all = [...parts, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('reading a job’s output sandbox', () => {
  it('reads every file, with its contents', () => {
    const tar = readTar(
      archive(entry('results-q0.json', '{"a":1}'), entry('hits-q0.tsv', 'x\ty\n')),
    );
    expect(tar.map((e) => e.name)).toEqual(['results-q0.json', 'hits-q0.tsv']);
    expect(entryText(tar[0])).toBe('{"a":1}');
    expect(entryText(tar[1])).toBe('x\ty\n');
  });

  it('handles a file that exactly fills its blocks', () => {
    // An off-by-one in the padding puts the next header half a block
    // out, and every later entry is lost. 512 is where it shows.
    const body = 'z'.repeat(512);
    const tar = readTar(archive(entry('exact.txt', body), entry('after.txt', 'ok')));
    expect(tar.map((e) => e.name)).toEqual(['exact.txt', 'after.txt']);
    expect(entryText(tar[0])).toBe(body);
    expect(entryText(tar[1])).toBe('ok');
  });

  it('keeps empty files, which is how a failed node looks', () => {
    // hits.tsv comes back zero-length when a search found nothing. It
    // is a real entry and dropping it would lose the node entirely.
    const tar = readTar(archive(entry('hits-q0.tsv', ''), entry('results-q0.json', '{}')));
    expect(tar.map((e) => e.name)).toEqual(['hits-q0.tsv', 'results-q0.json']);
    expect(entryText(tar[0])).toBe('');
  });

  it('stops at the end-of-archive blocks rather than reading padding', () => {
    expect(readTar(archive(entry('one.txt', 'a')))).toHaveLength(1);
  });

  it('returns what it has when the archive is cut short', () => {
    // A truncated download should show the results that did arrive.
    const full = archive(entry('one.txt', 'a'), entry('two.txt', 'b'));
    expect(readTar(full.subarray(0, 512 + 512 + 300)).map((e) => e.name)).toEqual(['one.txt']);
  });

  it('is empty for an empty archive', () => {
    expect(readTar(new Uint8Array(1024))).toEqual([]);
    expect(readTar(new Uint8Array(0))).toEqual([]);
  });
});
