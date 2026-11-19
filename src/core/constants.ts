export const INT_VBLANK = 1;
export const INT_STAT = 2;
export const INT_TIMER = 4;
export const INT_SERIAL = 8;
export const INT_JOYPAD = 16;

export const SCREEN_W = 160;
export const SCREEN_H = 144;
/** T-cycles per frame. */
export const CYCLES_PER_FRAME = 70224;
/** CPU clock in T-cycles per second. */
export const CLOCK_HZ = 4194304;
export const FRAME_RATE = CLOCK_HZ / CYCLES_PER_FRAME; // ~59.7275

export const Button = {
  Right: 0,
  Left: 1,
  Up: 2,
  Down: 3,
  A: 4,
  B: 5,
  Select: 6,
  Start: 7,
} as const;
export type ButtonId = (typeof Button)[keyof typeof Button];
export type ButtonName = keyof typeof Button;
