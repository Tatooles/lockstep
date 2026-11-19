// Auto-grind: plays the real game to level up the lead Pokémon.
//
// It walks back and forth in tall grass, fights wild Pokémon with the best
// move, runs from anything that could knock its lead out, heals with Potions
// between battles, and hands control back for anything worth a human: a first
// encounter, a trainer, a move to learn, an evolution, a faint.
//
// Call `step()` once after every emulated frame. It reads RAM and the call
// stack (see screen.ts) and presses buttons with `gb.setButton`.

import { Button } from '../core/constants.ts';
import type { GameBoy } from '../core/gameboy.ts';
import type { Gen1Data } from '../gen1/rom.ts';
import type { Gen1Symbols } from '../gen1/symbols.ts';
import { decodeText } from '../gen1/text.ts';
import { Gen1Reader, type Snapshot } from '../gen1/watcher.ts';
import { chooseAction, hasUsableMove, type BattleAction, type Fighter } from './policy.ts';
import { readScreen, type Screen } from './screen.ts';

export interface GrindOptions {
  /** Stop once the lead reaches this level. */
  targetLevel: number;
  /** Use Potions from the bag between battles. */
  usePotions: boolean;
  /**
   * Asked at the start of each wild battle; return a message to hand control
   * back (for example, the area's first encounter).
   */
  handBack?: (snap: Snapshot) => string | null;
}

export type GrindEndKind = 'done' | 'handback' | 'problem';

export interface GrindEnd {
  kind: GrindEndKind;
  message: string;
}

export interface GrindProgress {
  nickname: string;
  species: number;
  startLevel: number;
  level: number;
  targetLevel: number;
  battles: number;
  ran: number;
  frames: number;
  activity: string;
}

/** Healing items the bot may use, weakest first. Drinks are left alone: the Saffron guards want one. */
const HEALS: { id: number; amount: number }[] = [
  { id: 0x14, amount: 20 }, // Potion
  { id: 0x13, amount: 50 }, // Super Potion
  { id: 0x12, amount: 200 }, // Hyper Potion
];
/** Heal below this share of max HP, up to HEAL_TO. */
const HEAL_BELOW = 0.5;
const HEAL_TO = 0.8;

const PRESS_FRAMES = 3;
const GAP_FRAMES = 3;
/** Give up on a step after this many frames without moving. */
const STEP_TIMEOUT = 48;
/** Hand back if this many steps pass without a wild battle. */
const MAX_STEPS_WITHOUT_BATTLE = 600;
/** Hand back if the game shows the same non-walking screen this long (about a minute). */
const STUCK_FRAMES = 3600;
/** Hand back after running from this many battles in a row. */
const MAX_RUN_STREAK = 5;
/** Frames a screen must hold before the bot presses anything on it. */
const SETTLE_FRAMES = 2;
/** Frames a screen must hold before the bot hands control back because of it. */
const CONFIRM_FRAMES = 30;

/** First map id that counts as indoors: wild Pokémon appear on any floor tile there. */
const FIRST_INDOOR_MAP = 0x25;

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: Dir[] = ['left', 'right', 'up', 'down'];
const DIR_BUTTON: Record<Dir, number> = { up: Button.Up, down: Button.Down, left: Button.Left, right: Button.Right };
const DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

export class Grinder {
  private readonly gb: GameBoy;
  private readonly data: Gen1Data;
  private readonly sym: Gen1Symbols;
  private readonly opts: GrindOptions;
  private readonly reader: Gen1Reader;
  private readonly ram: { u8: (a: number) => number };
  private readonly savedOptions: number;

  // Button timing.
  private tapButton = -1;
  private pressLeft = 0;
  private gapLeft = 0;

  // Walking.
  private home: { x: number; y: number; map: number };
  private dirs: Dir[] = [];
  private dir: Dir | null = null;
  private held: Dir | null = null;
  private heldFrom = { x: 0, y: 0 };
  private heldFrames = 0;
  private blocked = new Map<Dir, number>();
  private stepsSinceBattle = 0;

  // Battle.
  private wasInBattle = false;
  private battleChecked = false;
  private decision: BattleAction | null = null;
  /** The decision was carried out (move picked or Run pressed); decide again next turn. */
  private committed = false;
  /** Battles in a row the bot ran from. */
  private runStreak = 0;
  /** The last battle ended with the bot fleeing from danger. */
  private fled = false;
  private lastScreen: Screen = 'busy';
  private stableFrames = 0;

  private wantHeal = false;
  private ended: GrindEnd | null = null;
  private progress: GrindProgress;

  constructor(gb: GameBoy, data: Gen1Data, opts: GrindOptions) {
    this.gb = gb;
    this.data = data;
    this.sym = data.sym;
    this.opts = opts;
    this.reader = new Gen1Reader(this.sym);
    this.ram = { u8: (a: number) => gb.peek(a) };
    const s = this.sym;
    this.home = { x: gb.peek(s.wXCoord), y: gb.peek(s.wYCoord), map: gb.peek(s.wCurMap) };
    const lead = this.reader.read(this.ram).party[0];
    this.progress = {
      nickname: lead?.nickname ?? '',
      species: lead?.species ?? 0,
      startLevel: lead?.level ?? 0,
      level: lead?.level ?? 0,
      targetLevel: opts.targetLevel,
      battles: 0,
      ran: 0,
      frames: 0,
      activity: 'Starting',
    };
    // Fast text and no battle animations while the bot plays; restored on dispose.
    this.savedOptions = gb.peek(s.wOptions);
    gb.bus.write(s.wOptions, (this.savedOptions & 0x40) | 0x80 | 0x01);
  }

  /** Why the bot can't start here, or null if it can. */
  static problem(gb: GameBoy, data: Gen1Data, targetLevel: number): string | null {
    const sym = data.sym;
    const snap = new Gen1Reader(sym).read({ u8: (a) => gb.peek(a) });
    if (!snap.valid || snap.party.length === 0) return 'Load a save with a Pokémon first.';
    const lead = snap.party[0];
    if (lead.hp === 0) return `${lead.nickname} has fainted. Put a healthy Pokémon first.`;
    if (lead.level >= targetLevel) return `${lead.nickname} is already level ${lead.level}.`;
    if (!hasUsableMove(lead.moves, lead.pp, data.moves)) return `${lead.nickname} is out of PP. Heal at a Pokémon Center first.`;
    if (snap.inBattle === 2) return 'Finish this trainer battle first.';
    if (!snap.inBattle && !data.wild(snap.mapId)) return 'No wild Pokémon here. Go to a route with tall grass.';
    if (!snap.inBattle && Grinder.pacingDirs(gb, sym, snap.mapId).length === 0) return 'Stand in or next to tall grass.';
    return null;
  }

  getProgress(): GrindProgress {
    return this.progress;
  }

  /** Release every button and restore the game's options. */
  dispose(): void {
    for (let i = 0; i < 8; i++) this.gb.setButton(i, false);
    const a = this.sym.wOptions;
    this.gb.bus.write(a, (this.gb.peek(a) & 0x40) | (this.savedOptions & ~0x40 & 0xff));
  }

  step(): GrindEnd | null {
    if (this.ended) return this.ended;
    this.progress.frames++;
    const s = this.sym;
    const rawBattle = this.gb.peek(s.wIsInBattle);
    const inBattle = rawBattle === 0xff ? 0 : rawBattle;
    if (inBattle === 2) return this.end('handback', 'A trainer wants to battle.');
    if (inBattle && !this.wasInBattle) {
      this.releaseHeld();
      this.decision = null;
      this.progress.battles++;
      this.battleChecked = false;
      this.stepsSinceBattle = 0;
    }
    this.wasInBattle = !!inBattle;

    // Sample every frame: the bot only acts on a screen once it holds steady,
    // which filters out stale stack words that match for a frame.
    let screen = readScreen(this.gb, s) ?? this.lastScreen;
    if (screen === 'overworld' && inBattle) screen = 'busy';
    if (screen !== this.lastScreen) {
      this.lastScreen = screen;
      this.stableFrames = 0;
    } else {
      this.stableFrames++;
    }
    if (screen !== 'overworld') this.releaseHeld();

    if (this.pressLeft > 0) {
      if (--this.pressLeft === 0) {
        this.gb.setButton(this.tapButton, false);
        this.gapLeft = GAP_FRAMES;
      }
      return null;
    }
    if (this.gapLeft > 0) {
      this.gapLeft--;
      return null;
    }
    if (screen !== 'overworld' && this.stableFrames > STUCK_FRAMES) {
      return this.end('problem', 'The bot got stuck, so it handed control back.');
    }
    if (screen !== 'overworld' && this.stableFrames < SETTLE_FRAMES) return null;

    switch (screen) {
      case 'overworld':
        return this.overworld();
      case 'text':
        this.tap(Button.A);
        return null;
      case 'battleMenu':
        return this.battleMenu();
      case 'moveMenu':
        return this.moveMenu();
      case 'learnMove':
        if (this.stableFrames < CONFIRM_FRAMES) return null;
        return this.end('handback', `${this.progress.nickname} wants to learn a new move. Your call.`);
      case 'evolution':
        if (this.stableFrames < CONFIRM_FRAMES || !this.leadCanEvolve()) return null;
        return this.end('handback', `${this.progress.nickname} is evolving! Press B to stop it, or let it happen.`);
      case 'monFainted':
        if (this.stableFrames < CONFIRM_FRAMES || !inBattle || this.u16(s.wBattleMonHP) !== 0) return null;
        return this.end('handback', `${this.progress.nickname} fainted.`);
      case 'yesNo':
        if (this.stableFrames < CONFIRM_FRAMES) return null;
        return this.end('handback', 'The game is asking you something.');
      case 'startMenu':
      case 'bagList':
      case 'itemAction':
      case 'partyMenu':
        return this.heal(screen);
      case 'quantity':
      case 'menu':
        this.tap(Button.B);
        return null;
      case 'busy':
        return null;
    }
  }

  private u16(addr: number): number {
    return (this.gb.peek(addr) << 8) | this.gb.peek(addr + 1);
  }

  /** Whether the lead has reached a level that evolves it (so an evolution screen is real). */
  private leadCanEvolve(): boolean {
    const lead = this.reader.read(this.ram).party[0];
    const sp = lead && this.data.species.get(lead.species);
    return !!sp && sp.evolutions.some((e) => e.method === 'level' && lead.level >= e.level);
  }

  // ---- overworld ----

  private overworld(): GrindEnd | null {
    if (this.held) return this.walk();
    const snap = this.reader.read(this.ram);
    if (!snap.valid) return null;
    const lead = snap.party[0];
    if (!lead) return this.end('problem', 'No Pokémon in the party.');
    this.progress.level = lead.level;
    this.progress.nickname = lead.nickname;
    this.progress.species = lead.species;
    if (lead.hp === 0) return this.end('handback', `${lead.nickname} fainted.`);
    if (lead.level >= this.opts.targetLevel) {
      return this.end('done', `${lead.nickname} reached level ${lead.level}.`);
    }
    if (!hasUsableMove(lead.moves, lead.pp, this.data.moves)) {
      return this.end('problem', `${lead.nickname} is out of PP. A Pokémon Center will fix that.`);
    }
    const hp = lead.maxHp ? lead.hp / lead.maxHp : 1;
    if (this.wantHeal && (hp >= HEAL_TO || !this.healItem(snap))) this.wantHeal = false;
    // After fleeing from danger, top up before the next fight.
    if (this.fled && !this.wantHeal && this.opts.usePotions && hp < HEAL_TO && this.healItem(snap)) this.wantHeal = true;
    this.fled = false;
    if (!this.wantHeal && hp < HEAL_BELOW) {
      if (!this.opts.usePotions) return this.end('problem', `${lead.nickname} is low on HP. Heal up and start again.`);
      if (!this.healItem(snap)) return this.end('problem', `${lead.nickname} is low on HP and the bag has no Potions.`);
      this.wantHeal = true;
    }
    if (this.wantHeal) {
      this.progress.activity = 'Healing';
      this.tap(Button.Start);
      return null;
    }
    return this.walk();
  }

  /** Directions whose neighbouring tile can have wild Pokémon, best first. */
  private static pacingDirs(gb: GameBoy, sym: Gen1Symbols, mapId: number): Dir[] {
    const anyTile = mapId >= FIRST_INDOOR_MAP && gb.peek(sym.wGrassRate) > 0;
    const grass = gb.peek(sym.wGrassTile);
    // The player stands on screen tiles (8..9, 8..9); the game checks (8, 9).
    const wild = (dx: number, dy: number) => anyTile || gb.peek(sym.wTileMap + (9 + 2 * dy) * 20 + 8 + 2 * dx) === grass;
    const here = wild(0, 0);
    const near = DIRS.filter((d) => wild(...DELTA[d]));
    if (near.length) return near;
    // On grass with none next to it: still pace, half the steps can find something.
    return here ? [...DIRS] : [];
  }

  private walk(): GrindEnd | null {
    const s = this.sym;
    const x = this.gb.peek(s.wXCoord);
    const y = this.gb.peek(s.wYCoord);
    if (this.gb.peek(s.wCurMap) !== this.home.map) return this.end('problem', 'The bot left the area, so it stopped.');

    if (this.held) {
      if (x !== this.heldFrom.x || y !== this.heldFrom.y) {
        this.releaseHeld();
        this.stepsSinceBattle++;
        if (this.stepsSinceBattle > MAX_STEPS_WITHOUT_BATTLE) {
          return this.end('problem', 'No wild Pokémon showed up. Endless Repel may be keeping them away.');
        }
        return null;
      }
      if (++this.heldFrames > STEP_TIMEOUT) {
        const d = this.held;
        this.releaseHeld();
        this.blocked.set(d, (this.blocked.get(d) ?? 0) + 1);
        if ((this.blocked.get(d) ?? 0) >= 3) {
          // Walls and ledges: pick another pacing direction.
          this.dirs = this.dirs.filter((n) => n !== d && n !== OPPOSITE[d]);
          this.dir = null;
          if (this.dirs.length === 0 && this.atHome(x, y)) return this.end('problem', "The bot can't find room to walk here.");
        }
      }
      return null;
    }

    if (this.dir === null) {
      if (this.dirs.length === 0 && this.atHome(x, y)) this.dirs = Grinder.pacingDirs(this.gb, s, this.home.map);
      this.dir = this.dirs[0] ?? null;
      if (this.dir === null && this.atHome(x, y)) return this.end('problem', 'Stand in or next to tall grass.');
    }
    let next: Dir | null;
    if (this.atHome(x, y)) next = this.dir;
    else if (this.dir && x === this.home.x + DELTA[this.dir][0] && y === this.home.y + DELTA[this.dir][1]) next = OPPOSITE[this.dir];
    else {
      // Pushed off the pacing line (a ledge, a battle mid-step): head back home.
      const dx = this.home.x - x;
      const dy = this.home.y - y;
      if (Math.abs(dx) + Math.abs(dy) > 6) return this.end('problem', 'The bot wandered off, so it stopped.');
      next = dx !== 0 ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    }
    if (!next) return null;
    this.progress.activity = 'Looking for wild Pokémon';
    this.held = next;
    this.heldFrom = { x, y };
    this.heldFrames = 0;
    this.gb.setButton(DIR_BUTTON[next], true);
    return null;
  }

  private atHome(x: number, y: number): boolean {
    return x === this.home.x && y === this.home.y;
  }

  private releaseHeld(): void {
    if (this.held) this.gb.setButton(DIR_BUTTON[this.held], false);
    this.held = null;
  }

  // ---- battle ----

  private battleMenu(): GrindEnd | null {
    const s = this.sym;
    if (!this.decision || this.committed) {
      this.committed = false;
      const snap = this.reader.read(this.ram);
      if (!snap.valid || !snap.enemy || !snap.battleMon) return null;
      const foeName = this.data.speciesName(snap.enemy.species);
      if (!this.battleChecked) {
        this.battleChecked = true;
        if (snap.battleType !== 0) return this.end('handback', 'This is a special battle. Over to you.');
        const reason = this.opts.handBack?.(snap);
        if (reason) return this.end('handback', reason);
      }
      this.decision = this.decide(snap);
      this.progress.level = snap.battleMon.level;
      if (this.decision.kind === 'run') {
        this.progress.ran++;
        this.fled = this.decision.why === 'too dangerous';
        if (this.fled && ++this.runStreak > MAX_RUN_STREAK) {
          const worn = snap.battleMon.hp < snap.battleMon.maxHp * HEAL_TO;
          return this.end(
            'problem',
            worn
              ? `${this.progress.nickname} is too worn out to fight safely here. Heal up and grind again.`
              : `Wild Pokémon here are too strong for ${this.progress.nickname} right now.`,
          );
        }
      } else {
        this.runStreak = 0;
      }
      this.progress.activity = this.decision.kind === 'run' ? `Running from ${foeName}` : `Battling ${foeName}`;
    }
    // FIGHT is top left, RUN bottom right. The cursor's column is its X.
    const wantCol = this.decision.kind === 'fight' ? 0 : 1;
    const wantItem = this.decision.kind === 'fight' ? 0 : 1;
    const col = this.gb.peek(s.wTopMenuItemX) === 9 ? 0 : 1;
    const item = this.gb.peek(s.wCurrentMenuItem);
    if (col !== wantCol) this.tap(wantCol === 0 ? Button.Left : Button.Right);
    else if (item !== wantItem) this.tap(wantItem === 0 ? Button.Up : Button.Down);
    else {
      this.tap(Button.A);
      if (this.decision.kind === 'run') this.committed = true;
    }
    return null;
  }

  private moveMenu(): GrindEnd | null {
    const d = this.decision;
    if (!d || d.kind !== 'fight') {
      this.tap(Button.B);
      return null;
    }
    // The move list's first entry is menu item 1.
    const cur = this.gb.peek(this.sym.wCurrentMenuItem) - 1;
    if (cur < d.slot) this.tap(Button.Down);
    else if (cur > d.slot) this.tap(Button.Up);
    else {
      this.tap(Button.A);
      this.committed = true;
    }
    return null;
  }

  private decide(snap: Snapshot): BattleAction {
    const me = snap.battleMon!;
    const foe = snap.enemy!;
    const pp = [0, 1, 2, 3].map((i) => this.gb.peek(this.sym.wBattleMonPP + i) & 0x3f);
    const mine: Fighter = { level: me.level, hp: me.hp, maxHp: me.maxHp, types: me.types, ...me.stats, moves: me.moves, pp };
    const theirs: Fighter = { level: foe.level, hp: foe.hp, maxHp: foe.maxHp, types: foe.types, ...foe.stats, moves: foe.moves };
    return chooseAction(mine, theirs, this.data.moves, (a, d) => this.data.effectiveness(a, d));
  }

  // ---- healing ----

  /** The weakest healing item in the bag (its item id), or null. */
  private healItem(snap: Snapshot): number | null {
    for (const h of HEALS) {
      if ((snap.bag[h.id] ?? 0) > 0) return h.id;
    }
    return null;
  }

  private heal(screen: Screen): GrindEnd | null {
    if (!this.wantHeal) {
      this.tap(Button.B);
      return null;
    }
    const s = this.sym;
    const cur = this.gb.peek(s.wCurrentMenuItem);
    switch (screen) {
      case 'startMenu': {
        const target = this.startMenuIndex('ITEM');
        if (target < 0) return this.end('problem', "Couldn't find the bag in the menu.");
        this.tap(cur < target ? Button.Down : cur > target ? Button.Up : Button.A);
        return null;
      }
      case 'bagList': {
        const snap = this.reader.read(this.ram);
        const id = this.healItem(snap);
        const target = id === null ? -1 : this.bagIndex(id);
        if (target < 0) {
          this.wantHeal = false;
          this.tap(Button.B);
          return null;
        }
        const at = this.gb.peek(s.wListScrollOffset) + cur;
        this.tap(at < target ? Button.Down : at > target ? Button.Up : Button.A);
        return null;
      }
      case 'itemAction':
        // USE is the first option.
        this.tap(cur > 0 ? Button.Up : Button.A);
        return null;
      case 'partyMenu':
        this.tap(cur > 0 ? Button.Up : Button.A);
        return null;
    }
    return null;
  }

  /** Index of a start menu entry, read from the screen (the Pokédex entry only shows once you have it). */
  private startMenuIndex(label: string): number {
    const s = this.sym;
    const top = this.gb.peek(s.wTopMenuItemY);
    const left = this.gb.peek(s.wTopMenuItemX);
    const max = this.gb.peek(s.wMaxMenuItem);
    for (let i = 0; i <= max; i++) {
      const row = s.wTileMap + (top + 2 * i) * 20 + left + 1;
      const bytes: number[] = [];
      for (let x = 0; x < 19 - left; x++) bytes.push(this.gb.peek(row + x));
      if (decodeText(bytes, 0, bytes.length).trim().toUpperCase().startsWith(label)) return i;
    }
    return -1;
  }

  private bagIndex(id: number): number {
    const s = this.sym;
    const n = this.gb.peek(s.wNumBagItems);
    for (let i = 0; i < n && i < 20; i++) if (this.gb.peek(s.wBagItems + 2 * i) === id) return i;
    return -1;
  }

  // ---- input ----

  private tap(button: number): void {
    this.tapButton = button;
    this.pressLeft = PRESS_FRAMES;
    this.gb.setButton(button, true);
  }

  private end(kind: GrindEndKind, message: string): GrindEnd {
    this.releaseHeld();
    if (this.pressLeft > 0) this.gb.setButton(this.tapButton, false);
    this.pressLeft = 0;
    this.ended = { kind, message };
    this.progress.activity = message;
    return this.ended;
  }
}
