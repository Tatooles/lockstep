export interface Palette {
  id: string;
  name: string;
  colors: [string, string, string, string]; // lightest -> darkest
}

export const PALETTES: Palette[] = [
  { id: 'dusk', name: 'Dusk', colors: ['#f4efe6', '#b9a7c7', '#6a5585', '#241a33'] },
  { id: 'pea', name: 'Pea soup', colors: ['#dfeec4', '#94bd72', '#40734f', '#152b1c'] },
  { id: 'paper', name: 'Paper', colors: ['#f6f4ee', '#aeaca6', '#5d5b57', '#1a1918'] },
  { id: 'ember', name: 'Ember', colors: ['#fff0d2', '#e9a85b', '#9b4b2a', '#2c1209'] },
  { id: 'tide', name: 'Tide', colors: ['#eef6f9', '#9cc6d8', '#3f7997', '#112838'] },
];

export function paletteById(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** ABGR packed colors for writing into an ImageData Uint32 view (little-endian). */
export function packPalette(p: Palette): Uint32Array {
  const out = new Uint32Array(4);
  p.colors.forEach((hex, i) => {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    out[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
  });
  return out;
}
