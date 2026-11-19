// Works out what the game is waiting for by walking its call stack.
//
// Gen 1 runs one routine at a time and parks in a wait loop while it waits for
// a button. The return addresses on the stack name the routines in that loop
// (battle menu, move menu, a text box, …), so the bot always knows which screen
// is up and where its cursor is, without guessing from pixels or timing.

import type { Emulator } from '../core/emulator.ts';
import type { Gen1Symbols } from '../gen1/symbols.ts';

export type Screen =
  /** Free to walk. */
  | 'overworld'
  /** A text box waiting for A or B. */
  | 'text'
  | 'battleMenu'
  | 'moveMenu'
  | 'yesNo'
  | 'startMenu'
  | 'bagList'
  /** The USE / TOSS choice after picking a bag item. */
  | 'itemAction'
  | 'partyMenu'
  | 'quantity'
  /** Any other menu. */
  | 'menu'
  /** The "delete an older move?" prompt or the list of moves to forget. */
  | 'learnMove'
  | 'evolution'
  /** The player's Pokémon fainted and the game wants a replacement. */
  | 'monFainted'
  /** Animations, transitions, scrolling text: nothing to press. */
  | 'busy';

type Range = [number, number, number];

/** Routines on the call stack, innermost first, from the PC up to the overworld loop. */
export function callChain(gb: Emulator, sym: Gen1Symbols): string[] {
  const routines = Object.entries(sym.routines) as [string, Range][];
  const lookup = (bank: number, addr: number): string | null => {
    for (const [name, [b, start, end]] of routines) {
      if (addr >= start && addr < end && (addr < 0x4000 ? b === 0 : b === bank)) return name;
    }
    return null;
  };
  let bank = gb.cart.currentRomBank;
  const out: string[] = [];
  const atPc = lookup(bank, gb.cpu.pc);
  if (atPc) out.push(atPc);
  let sp = gb.cpu.sp;
  for (let i = 0; i < 48 && sp < 0xfffe; i++, sp += 2) {
    const word = gb.peek(sp) | (gb.peek(sp + 1) << 8);
    if (word >= 0x8000) continue;
    const name = lookup(bank, word);
    if (!name) continue;
    if (name === 'Bankswitch' || name === 'Predef') {
      // Both push AF (A = the caller's ROM bank) right above their return address.
      bank = gb.peek(sp + 3);
      sp += 2;
      continue;
    }
    out.push(name);
    // The overworld loop is the bottom of every call chain; past it is stale data.
    if (name === 'OverworldLoop' || name === 'OverworldLoopLessDelay') break;
  }
  return out;
}

const MENU_OWNERS: [string, Screen][] = [
  ['DisplayBattleMenu', 'battleMenu'],
  ['SelectMenuItem', 'moveMenu'],
  ['DisplayTwoOptionMenu', 'yesNo'],
  ['HandlePartyMenuInput', 'partyMenu'],
  ['DisplayListMenuIDLoop', 'bagList'],
  ['DisplayChooseQuantityMenu', 'quantity'],
  ['StartMenu_Item', 'itemAction'],
  ['DisplayStartMenu', 'startMenu'],
  ['RedisplayStartMenu', 'startMenu'],
];
const OWNER_NAMES = new Set(MENU_OWNERS.map(([n]) => n));

export function classify(chain: string[]): Screen {
  const has = (n: string) => chain.includes(n);
  if (has('HandlePlayerMonFainted') || has('ChooseNextMon')) return 'monFainted';
  const menu = chain.indexOf('HandleMenuInput_');
  if (menu >= 0 && (has('TryingToLearn') || has('AbandonLearning') || has('DontAbandonLearning'))) return 'learnMove';
  if (has('EvolveMon')) return 'evolution';
  if (menu >= 0) {
    const owner = chain.slice(menu + 1).find((n) => OWNER_NAMES.has(n));
    return MENU_OWNERS.find(([n]) => n === owner)?.[1] ?? 'menu';
  }
  if (has('WaitForTextScrollButtonPress') || has('ManualTextScroll')) {
    // "What? X is evolving!" is printed before the animation starts.
    return has('Evolution_PartyMonLoop') ? 'evolution' : 'text';
  }
  if (chain[0] === 'OverworldLoop' || chain[0] === 'OverworldLoopLessDelay') return 'overworld';
  return 'busy';
}

/**
 * The screen the game is on, or null when this frame can't tell: the game's
 * input loops all live in the home bank, and while the CPU is off in banked
 * code (often a helper reached by an inline bank switch the walk can't see)
 * the outer frames resolve against the wrong bank.
 */
export function readScreen(gb: Emulator, sym: Gen1Symbols): Screen | null {
  if (gb.cpu.pc >= 0x4000 && gb.cpu.pc < 0x8000) return null;
  return classify(callChain(gb, sym));
}
