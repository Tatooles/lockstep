// Gen 1 type ids (see pret constants/type_constants.asm).

export const TYPE_NAMES: Record<number, string> = {
  0x00: 'Normal', 0x01: 'Fighting', 0x02: 'Flying', 0x03: 'Poison', 0x04: 'Ground', 0x05: 'Rock',
  0x07: 'Bug', 0x08: 'Ghost', 0x14: 'Fire', 0x15: 'Water', 0x16: 'Grass', 0x17: 'Electric',
  0x18: 'Psychic', 0x19: 'Ice', 0x1a: 'Dragon',
};

export const ALL_TYPES = [0x00, 0x14, 0x15, 0x17, 0x16, 0x19, 0x01, 0x03, 0x04, 0x02, 0x18, 0x07, 0x05, 0x08, 0x1a];

/** CSS color token per type (used for chips). */
export const TYPE_COLORS: Record<number, string> = {
  0x00: '#a8a77a', 0x01: '#c22e28', 0x02: '#a98ff3', 0x03: '#a33ea1', 0x04: '#e2bf65', 0x05: '#b6a136',
  0x07: '#a6b91a', 0x08: '#735797', 0x14: '#ee8130', 0x15: '#6390f0', 0x16: '#7ac74c', 0x17: '#f7d02c',
  0x18: '#f95587', 0x19: '#96d9d6', 0x1a: '#6f35fc',
};

export function typeName(t: number): string {
  return TYPE_NAMES[t] ?? `Type ${t}`;
}
