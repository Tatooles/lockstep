// Works out which screen a Gen 3 game is on, for auto-grind.
//
// Gen 3 has no call stack worth walking: it runs a main callback each frame,
// a list of tasks, and in battle a controller function per battler. All of
// them are function pointers in RAM, and the decompilations name every one,
// so the bot reads them and knows which menu is up (and where its cursor is)
// without guessing from pixels.

import type { Mem } from '../gen3/reader.ts';
import type { Gen3Data } from '../gen3/rom.ts';
import type { Screen } from './screen.ts';

/** What the game is running this frame, named. */
export interface Probe3 {
  /** gMain.callback2: the field, a battle, the evolution scene, or anything else (bag, party menu…). */
  main: 'overworld' | 'battle' | 'evolution' | 'other';
  /** gMain.callback1 is the field's input handler. */
  fieldInput: boolean;
  /** The player's battle controller function. */
  controller: 'action' | 'move' | 'target' | 'text' | 'chooseMon' | 'other';
  /** The battle script command about to run, or -1. */
  scriptOp: number;
  /** A text box is waiting for a button press. */
  textWaiting: boolean;
  startMenu: boolean;
  bag: boolean;
  itemContext: boolean;
  party: boolean;
  /** FR/LG's item-use animation and R/S's "HP was restored" message: both wait for A (and skip ahead on A). */
  itemAnim: boolean;
  evolution: boolean;
}

// Battle script commands (asm/macros/battle_script.inc, the same in all three families).
export const OP = { YESNO_LEARN_MOVE: 0x5a, YESNO_STOP_LEARNING: 0x5b, DRAW_LVLUP_BOX: 0x6c } as const;

export function classify3(p: Probe3): Screen {
  if (p.main === 'evolution' || p.evolution) return 'evolution';
  if (p.main === 'battle') {
    if (p.scriptOp === OP.YESNO_LEARN_MOVE || p.scriptOp === OP.YESNO_STOP_LEARNING) return 'learnMove';
    switch (p.controller) {
      case 'action':
        return 'battleMenu';
      case 'move':
        return 'moveMenu';
      case 'chooseMon':
        return 'monFainted';
      case 'target':
        return 'menu';
      case 'text':
        return 'text';
    }
    // The level-up stats box waits for A outside any controller.
    if (p.scriptOp === OP.DRAW_LVLUP_BOX || p.textWaiting) return 'text';
    return 'busy';
  }
  if (p.textWaiting || p.itemAnim) return 'text';
  if (p.party) return 'partyMenu';
  if (p.itemContext) return 'itemAction';
  if (p.bag) return 'bagList';
  if (p.main === 'overworld') {
    if (p.startMenu) return 'startMenu';
    if (p.fieldInput) return 'overworld';
  }
  return 'busy';
}

// Struct layouts (include/text.h, task.h).
const TEXT_PRINTERS = 32;
const TEXT_PRINTER_SIZE = 0x24;
const TASKS = 16;
const TASK_SIZE = 0x28;
const RENDER_STATE_WAIT = 1;
const RENDER_STATE_CLEAR = 2;

const fn = (p: number) => p & ~1;

/** Read the probe from RAM. */
export function probe3(mem: Mem, data: Gen3Data): Probe3 {
  const s = data.sym;
  const r = data.ram;
  const cb1 = fn(mem.u32(r.main!));
  const cb2 = fn(mem.u32(r.main! + 4));
  const main = cb2 === s.cb2Overworld ? 'overworld' : cb2 === s.cb2Battle ? 'battle' : cb2 === s.cb2Evolution ? 'evolution' : 'other';

  let controller: Probe3['controller'] = 'other';
  let scriptOp = -1;
  if (main === 'battle') {
    const c = fn(mem.u32(r.battlerControllerFuncs!));
    controller =
      c === s.chooseAction ? 'action'
      : c === s.chooseMove ? 'move'
      : c === s.chooseTarget ? 'target'
      : c === s.textWait || c === s.textWait2 ? 'text'
      : c === s.chooseMon ? 'chooseMon'
      : 'other';
    const ip = mem.u32(r.battleScriptPtr!);
    if (ip >= 0x08000000 && ip < 0x08000000 + data.rom.length) scriptOp = data.u8(ip);
  }

  let textWaiting = false;
  if (r.textPrinters) {
    for (let i = 0; i < TEXT_PRINTERS && !textWaiting; i++) {
      const b = r.textPrinters + i * TEXT_PRINTER_SIZE;
      const state = mem.u8(b + 0x1c);
      textWaiting = mem.u8(b + 0x1b) !== 0 && (state === RENDER_STATE_WAIT || state === RENDER_STATE_CLEAR);
    }
  }

  const tasks = new Set<number>();
  for (let i = 0; i < TASKS; i++) {
    const b = r.tasks! + i * TASK_SIZE;
    if (mem.u8(b + 4)) tasks.add(fn(mem.u32(b)));
  }
  const has = (a: number | undefined) => a !== undefined && tasks.has(a);

  return {
    main,
    fieldInput: cb1 === s.cb1Overworld,
    controller,
    scriptOp,
    textWaiting,
    startMenu: has(s.startMenuTask) && fn(mem.u32(r.startMenuCallback!)) === s.startMenuInput,
    bag: has(s.bagInput),
    itemContext: has(s.itemContext) || has(s.itemContext2),
    party: has(s.partyInput),
    itemAnim: has(s.itemUseAnim) || has(s.partyMessage),
    evolution: has(s.evolutionTask),
  };
}

export function readScreen3(mem: Mem, data: Gen3Data): Screen {
  return classify3(probe3(mem, data));
}
