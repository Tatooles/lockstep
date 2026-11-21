import { describe, expect, it } from 'vitest';
import { lz77 } from './gfx.ts';
import { Gen3Reader, monKey } from './reader.ts';
import type { Gen3Data } from './rom.ts';
import { RAM_SYMBOLS } from './symbols.ts';
import { decodeText, prettyName } from './text.ts';

const enc = (s: string) =>
  [...s].map((c) => (c >= 'A' && c <= 'Z' ? 0xbb + c.charCodeAt(0) - 65 : c >= 'a' && c <= 'z' ? 0xd5 + c.charCodeAt(0) - 97 : c === ' ' ? 0 : 0xad));

describe('gen 3 text', () => {
  it('decodes up to the terminator', () => {
    expect(decodeText([...enc('PIDGEY'), 0xff, 0xbb], 0, 10)).toBe('PIDGEY');
  });
  it('title-cases names', () => {
    expect(prettyName('ROUTE 101')).toBe('Route 101');
    expect(prettyName('MT. PYRE')).toBe('Mt. Pyre');
    expect(prettyName('POKéMON TOWER')).toBe('Pokémon Tower');
    expect(prettyName('DOUBLE-EDGE')).toBe('Double-Edge');
    expect(prettyName('S.S. ANNE')).toBe('S.S. Anne');
  });
});

describe('lz77', () => {
  it('copies literals and back-references', () => {
    // "ABCABCABCX": 3 literals, a 6-byte copy from 3 back, then a literal.
    const src = Uint8Array.of(0x10, 10, 0, 0, 0b00010000, 0x41, 0x42, 0x43, 0x30, 0x02, 0x58);
    expect(new TextDecoder().decode(lz77(src, 0))).toBe('ABCABCABCX');
  });
});

/** Builds a 100-byte party Pokémon with encrypted substructures and a valid checksum. */
function partyMon(o: { pid: number; otId: number; species: number; exp: number; moves: number[]; level: number; hp: number; maxHp: number; nick: string }): Uint8Array {
  const b = new Uint8Array(100);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, o.pid, true);
  dv.setUint32(4, o.otId, true);
  b.fill(0xff, 8, 18);
  b.set(enc(o.nick), 8);
  b[19] = 2; // has species
  b.fill(0xff, 20, 27);
  const plain = new Uint8Array(48);
  const p = new DataView(plain.buffer);
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][o.pid % 24];
  const G = order.indexOf('G') * 12;
  const A = order.indexOf('A') * 12;
  p.setUint16(G, o.species, true);
  p.setUint32(G + 4, o.exp, true);
  o.moves.forEach((m, i) => {
    p.setUint16(A + i * 2, m, true);
    plain[A + 8 + i] = 10;
  });
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum += p.getUint16(i, true);
  dv.setUint16(28, sum & 0xffff, true);
  const key = (o.pid ^ o.otId) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(32 + i, (p.getUint32(i, true) ^ key) >>> 0, true);
  b[84] = o.level;
  dv.setUint16(86, o.hp, true);
  dv.setUint16(88, o.maxHp, true);
  return b;
}

describe('gen 3 Pokémon decoding', () => {
  const data = {
    species: Object.assign([], { 16: { types: [0, 2], growth: 3 } }),
    gameFamily: 'frlg',
    ram: RAM_SYMBOLS.frlg,
    levelFor: () => 3,
  } as unknown as Gen3Data;
  const reader = new Gen3Reader(data);
  const decode = (b: Uint8Array, party: boolean) => reader['decodeBytes'](b, party);

  it('decrypts the substructures in personality order', () => {
    for (const pid of [0x0b16800d, 0x12345678, 24 * 1000 + 23]) {
      const m = decode(partyMon({ pid, otId: 0x0ed8e347, species: 16, exp: 57, moves: [33, 28], level: 3, hp: 15, maxHp: 15, nick: 'PIDGEY' }), true);
      expect(m).not.toBe('bad');
      expect(m && m !== 'bad' && { species: m.species, exp: m.exp, moves: m.moves, nick: m.nickname, key: m.key, types: m.types, hp: m.hp }).toEqual({
        species: 16, exp: 57, moves: [33, 28, 0, 0], nick: 'PIDGEY', key: monKey(pid, 0x0ed8e347), types: [0, 2], hp: 15,
      });
    }
  });

  it('rejects a bad checksum and skips eggs and empty slots', () => {
    const b = partyMon({ pid: 7, otId: 9, species: 16, exp: 57, moves: [33], level: 3, hp: 15, maxHp: 15, nick: 'PIDGEY' });
    const bad = b.slice();
    bad[40] ^= 1;
    expect(decode(bad, true)).toBe('bad');
    const egg = b.slice();
    egg[19] |= 4;
    expect(decode(egg, true)).toBeNull();
    expect(decode(new Uint8Array(100), true)).toBeNull();
  });

  it('works out a PC Pokémon’s level from its experience', () => {
    const b = partyMon({ pid: 7, otId: 9, species: 16, exp: 57, moves: [33], level: 3, hp: 15, maxHp: 15, nick: 'PIDGEY' });
    const m = decode(b.subarray(0, 80), false);
    expect(m && m !== 'bad' && [m.level, m.hp, m.stats]).toEqual([3, 0, null]);
  });
});
