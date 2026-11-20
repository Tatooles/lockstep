// Uncapped emulation-speed measurement shared by tools/bench-gba.ts (Node)
// and bench-gba.html (browsers). Starts from a save state in the overworld and
// walks left and right so the map scrolls and the game does real work.

import { GBA_FPS, Key, type Gba } from './gba.ts';

/** Hold Left, then Right, 64 frames each (about four tiles), forever. */
export function walk(frame: number): number {
  return frame % 128 < 64 ? Key.Left : Key.Right;
}

export interface Pass {
  frames: number;
  ms: number;
  /** Multiples of real time (59.73 fps). */
  speed: number;
  msPerFrame: number;
}

function pass(frames: number, ms: number): Pass {
  return { frames, ms, speed: frames / (ms / 1000) / GBA_FPS, msPerFrame: ms / frames };
}

/**
 * Run `frames` frames from `state` as fast as possible. `chunk` lets a browser
 * yield between slices (only time inside runFrame is counted).
 */
export async function measure(
  gba: Gba,
  state: Uint8Array | null,
  frames: number,
  opts: { render: boolean; chunk?: (done: number) => Promise<void>; chunkFrames?: number },
): Promise<Pass> {
  if (state) gba.loadState(state);
  gba.render = opts.render;
  const chunkFrames = opts.chunkFrames ?? frames;
  let ms = 0;
  let done = 0;
  while (done < frames) {
    const n = Math.min(chunkFrames, frames - done);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      gba.setKeys(walk(done + i));
      gba.runFrame();
    }
    ms += performance.now() - t0;
    done += n;
    if (opts.chunk) await opts.chunk(done);
  }
  gba.render = true;
  return pass(frames, ms);
}

export interface BenchResult {
  full: Pass;
  cpuOnly: Pass;
  /** Share of frame time spent drawing scanlines. */
  graphicsShare: number;
}

export async function bench(
  gba: Gba,
  state: Uint8Array | null,
  frames: number,
  opts: { chunk?: (phase: string, done: number) => Promise<void>; chunkFrames?: number } = {},
): Promise<BenchResult> {
  const chunk = (phase: string) => (opts.chunk ? (d: number) => opts.chunk!(phase, d) : undefined);
  // Warm up the JIT and caches.
  await measure(gba, state, Math.min(300, frames), { render: true, chunk: chunk('warm-up'), chunkFrames: opts.chunkFrames });
  const full = await measure(gba, state, frames, { render: true, chunk: chunk('full'), chunkFrames: opts.chunkFrames });
  const cpuOnly = await measure(gba, state, frames, { render: false, chunk: chunk('cpu-only'), chunkFrames: opts.chunkFrames });
  if (state) gba.loadState(state);
  return { full, cpuOnly, graphicsShare: 1 - cpuOnly.msPerFrame / full.msPerFrame };
}

export function formatResult(r: BenchResult): string {
  const f = (p: Pass) => `${p.speed.toFixed(1)}x realtime (${p.msPerFrame.toFixed(3)} ms/frame, ${p.frames} frames)`;
  return [
    `full:      ${f(r.full)}`,
    `cpu only:  ${f(r.cpuOnly)}`,
    `graphics:  ${(r.graphicsShare * 100).toFixed(0)}% of frame time`,
  ].join('\n');
}
