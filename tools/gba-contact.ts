// Tiles 240x160 screenshots into one contact sheet, for reviewing a
// tools/gba-play.ts run at a glance.
//   node tools/gba-contact.ts out.png a.png b.png ... (6 per row)
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [out, ...files] = process.argv.slice(2);
const cols = Math.min(6, files.length);
const rows = Math.ceil(files.length / cols);
const sheet = new PNG({ width: cols * 242, height: rows * 162 });
sheet.data.fill(255);
files.forEach((f, i) => {
  const img = PNG.sync.read(readFileSync(f));
  const ox = (i % cols) * 242;
  const oy = Math.floor(i / cols) * 162;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = ((oy + y) * sheet.width + ox + x) * 4;
      sheet.data.set(img.data.subarray(s, s + 4), d);
    }
});
writeFileSync(out, PNG.sync.write(sheet));
