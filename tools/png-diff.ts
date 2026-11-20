// Compares two 240x160 screenshots in GBA color space (5 bits per channel, so
// emulators that expand 5->8 bits differently still match) and writes a diff
// image (red = differs).
//   node tools/png-diff.ts a.png b.png [diff.png]
// Also counts pixels off by more than one 5-bit step, since emulators that do
// color effects at 8-bit precision (mGBA) differ from 5-bit math by one step.
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [a, b, out] = process.argv.slice(2);
const pa = PNG.sync.read(readFileSync(a));
const pb = PNG.sync.read(readFileSync(b));
if (pa.width !== pb.width || pa.height !== pb.height) {
  console.log(`size differs: ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`);
  process.exit(1);
}
const diff = new PNG({ width: pa.width, height: pa.height });
let n = 0;
let big = 0;
for (let i = 0; i < pa.width * pa.height; i++) {
  let same = true;
  let far = false;
  for (let c = 0; c < 3; c++) {
    const d = Math.abs((pa.data[i * 4 + c] >> 3) - (pb.data[i * 4 + c] >> 3));
    if (d > 0) same = false;
    if (d > 1) far = true;
  }
  if (far) big++;
  const g = (pa.data[i * 4] + pa.data[i * 4 + 1] + pa.data[i * 4 + 2]) / 6;
  diff.data.set(same ? [g, g, g, 255] : [255, 0, 0, 255], i * 4);
  if (!same) n++;
}
console.log(`${n} of ${pa.width * pa.height} pixels differ (${((n / (pa.width * pa.height)) * 100).toFixed(2)}%), ${big} by more than one step`);
if (out) writeFileSync(out, PNG.sync.write(diff));
