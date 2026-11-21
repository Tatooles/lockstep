// Auto-grind for Gen 3 (Ruby, Sapphire, Emerald, FireRed, LeafGreen): the
// GBA counterpart of grinder.ts, with the same behaviour.
//
// It walks back and forth in tall grass, fights wild Pokémon with the best
// move (by the Gen 3 damage formula), runs from anything that could knock its
// lead out, heals with Potions between battles, and hands control back for
// anything worth a human: a first encounter, a trainer, a move to learn, an
// evolution, a faint.
//
// Call `step()` once after every emulated frame and feed `keys` to the core
// before the next one. It reads RAM, and which screen is up from the game's
// callbacks, tasks and battle controller (see screen3.ts).

import { Key } from '../gba/gba.ts';
import { toBattler } from '../gen3/battle.ts';
import type { BattleField } from '../gen3/damage.ts';
import { Gen3Reader, type Mem } from '../gen3/reader.ts';
import type { Gen3Data } from '../gen3/rom.ts';
import type { BattleExtras, MonData, Snapshot } from '../run/events.ts';
import type { GrindEnd, GrindEndKind, GrindOptions, GrindProgress } from './grinder.ts';
import type { BattleAction } from './policy.ts';
import { chooseAction3, hasUsableMove3, type Duel3 } from './policy3.ts';
import { readScreen3 } from './screen3.ts';
import type { Screen } from './screen.ts';

/** Healing items the bot may use, weakest first (Gen 3 item ids). */
const HEALS: { id: number; amount: number }[] = [
  { id: 13, amount: 20 }, // Potion
  { id: 22, amount: 50 }, // Super Potion
  { id: 21, amount: 200 }, // Hyper Potion
];
const HEAL_BELOW = 0.5;
const HEAL_TO = 0.8;

const PRESS_FRAMES = 3;
const GAP_FRAMES = 3;
/** Give up on a step after this many frames without moving (turning to face a new way comes first). */
const STEP_TIMEOUT = 64;
const MAX_STEPS_WITHOUT_BATTLE = 600;
/** Hand back if the game shows the same non-walking screen this long (about a minute). */
const STUCK_FRAMES = 3600;
const MAX_RUN_STREAK = 5;
const SETTLE_FRAMES = 2;
const CONFIRM_FRAMES = 30;

/** Start menu action id of the Bag (MENU_ACTION_BAG / STARTMENU_BAG). */
const START_MENU_BAG = 2;
const BATTLE_TYPE_IS_MASTER = 1 << 2;

// Save block layouts per family.
const LAYOUT = {
  rs: { mainFlags: 0x43d, items: [0x560, 20], repel: 0x1340 + 0x21 * 2 },
  e: { mainFlags: 0x439, items: [0x560, 30], repel: 0x139c + 0x21 * 2 },
  frlg: { mainFlags: 0x439, items: [0x310, 42], repel: 0x1000 + 0x20 * 2 },
} as const;
/** SaveBlock2 options: text speed in bits 0–2, battle scene off in bit 10. */
const OPTIONS = 0x14;
/** SaveBlock2 Pokédex "owned" flags, by national dex number − 1. */
const DEX_OWNED = 0x28;
/** gBattleMons[0]: HP and PP offsets. */
const BATTLE_MON_HP = 0x28;
const BATTLE_MON_PP = 0x24;

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: Dir[] = ['left', 'right', 'up', 'down'];
const DIR_KEY: Record<Dir, number> = { up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right };
const DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

const NO_EXTRAS: BattleExtras = { ability: 0, item: 0, stages: [0, 0, 0, 0, 0, 0, 0, 0], status: 0, status2: 0, ivs: 0, friendship: 0 };

function saveBlocks(mem: Mem, data: Gen3Data): { sb1: number; sb2: number } | null {
  const r = data.ram;
  const sb1 = r.saveBlock1Ptr ? mem.u32(r.saveBlock1Ptr) : r.saveBlock1!;
  const sb2 = r.saveBlock2Ptr ? mem.u32(r.saveBlock2Ptr) : r.saveBlock2!;
  const ok = (a: number) => a >>> 24 === 2 && (a & 0xffffff) < 0x40000;
  return ok(sb1) && ok(sb2) ? { sb1, sb2 } : null;
}

/** Address of the repel step counter (VAR_REPEL_STEP_COUNT), or null before the save blocks are set up. */
export function repelCounter(mem: Mem, data: Gen3Data): number | null {
  const b = saveBlocks(mem, data);
  return b ? b.sb1 + LAYOUT[data.gameFamily].repel : null;
}

/** Whether a Pokémon of this species is registered as caught in the Pokédex. */
export function dexOwned(mem: Mem, data: Gen3Data, species: number): boolean | null {
  const b = saveBlocks(mem, data);
  const dex = data.species[species]?.dex ?? 0;
  if (!b || dex <= 0) return null;
  return (mem.u8(b.sb2 + DEX_OWNED + ((dex - 1) >> 3)) & (1 << ((dex - 1) & 7))) !== 0;
}

/**
 * Whether stepping onto map tile (x, y) can start a wild battle: FR/LG keep an
 * encounter type in each metatile's attributes, R/S/E flag metatile behaviours.
 */
export function isWildTile(mem: Mem, data: Gen3Data, x: number, y: number): boolean {
  const r = data.ram;
  const vmap = r.backupMapLayout!;
  const width = mem.u32(vmap) | 0;
  const height = mem.u32(vmap + 4) | 0;
  const gx = x + 7;
  const gy = y + 7;
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return false;
  const id = mem.u16(mem.u32(vmap + 8) + 2 * (gx + gy * width)) & 0x3ff;
  const layout = mem.u32(r.mapHeader!);
  if (layout >>> 24 !== 8) return false;
  const frlg = data.gameFamily === 'frlg';
  const primaryCount = frlg ? 640 : 512;
  const tileset = data.u32(layout + (id < primaryCount ? 0x10 : 0x14));
  const index = id < primaryCount ? id : id - primaryCount;
  if (tileset >>> 24 !== 8) return false;
  if (frlg) {
    const attr = data.u32(data.u32(tileset + 0x14) + index * 4);
    return ((attr >>> 24) & 7) === 1; // TILE_ENCOUNTER_LAND
  }
  const behavior = data.u16(data.u32(tileset + 0x10) + index * 2) & 0xff;
  const flags = data.u8(data.sym.tileBitAttributes + behavior);
  return (flags & 1) !== 0 && (flags & 2) === 0; // has encounters, not surfable
}

export class Grinder3 {
  /** Buttons to hold for the next frame (GBA KEYINPUT bits, 1 = pressed). */
  keys = 0;

  private readonly mem: Mem;
  private readonly data: Gen3Data;
  private readonly write: (addr: number, v: number) => void;
  private readonly opts: GrindOptions;
  private readonly reader: Gen3Reader;
  private readonly layout: (typeof LAYOUT)[keyof typeof LAYOUT];
  private readonly savedOptions: number | null = null;

  private tapKey = 0;
  private pressLeft = 0;
  private gapLeft = 0;

  private home: { x: number; y: number; map: number };
  private dirs: Dir[] = [];
  private dir: Dir | null = null;
  private held: Dir | null = null;
  private heldFrom = { x: 0, y: 0 };
  private heldFrames = 0;
  private blocked = new Map<Dir, number>();
  private stepsSinceBattle = 0;

  private wasInBattle = false;
  private battleChecked = false;
  private decision: BattleAction | null = null;
  private committed = false;
  /** A move was picked; if the move menu comes back before the next turn, the game refused it. */
  private pickedSlot = -1;
  private leftMoveMenu = false;
  private refused = new Set<number>();
  private runStreak = 0;
  private fled = false;
  private lastScreen: Screen = 'busy';
  private stableFrames = 0;

  private wantHeal = false;
  private ended: GrindEnd | null = null;
  private progress: GrindProgress;

  constructor(mem: Mem, data: Gen3Data, write: (addr: number, v: number) => void, opts: GrindOptions) {
    this.mem = mem;
    this.data = data;
    this.write = write;
    this.opts = opts;
    this.reader = new Gen3Reader(data);
    this.layout = LAYOUT[data.gameFamily];
    const snap = this.reader.read(mem);
    this.home = { x: snap.x, y: snap.y, map: snap.mapId };
    const lead = snap.party[0];
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
    const b = saveBlocks(mem, data);
    if (b) {
      this.savedOptions = mem.u16(b.sb2 + OPTIONS);
      this.setOptions(((this.savedOptions & ~7) | 2 | (1 << 10)) & 0xffff);
    }
  }

  /** Whether this game's bag and party menus are mapped well enough to use Potions. */
  static canUsePotions(data: Gen3Data): boolean {
    const s = data.sym;
    const r = data.ram;
    const bag = r.bagPosition || (r.bagPocket && r.bagScroll);
    const party = r.partyMenu || r.sprites;
    return !!(s.bagInput && s.itemContext && s.partyInput && bag && party && r.specialVarItemId);
  }

  /** Why the bot can't start here, or null if it can. */
  static problem(mem: Mem, data: Gen3Data, targetLevel: number): string | null {
    const snap = new Gen3Reader(data).read(mem);
    if (!snap.valid || snap.party.length === 0) return 'Load a save with a Pokémon first.';
    const lead = snap.party[0];
    if (lead.hp === 0) return `${lead.nickname} has fainted. Put a healthy Pokémon first.`;
    if (lead.level >= targetLevel) return `${lead.nickname} is already level ${lead.level}.`;
    if (!hasUsableMove3(lead.moves, lead.pp, data.moves)) return `${lead.nickname} is out of PP. Heal at a Pokémon Center first.`;
    if (snap.inBattle === 2) return 'Finish this trainer battle first.';
    if (!snap.inBattle && !data.hasLandWild(snap.mapId)) return 'No wild Pokémon here. Go to a route with tall grass.';
    if (!snap.inBattle && Grinder3.pacingDirs(mem, data, snap.x, snap.y).length === 0) return 'Stand in or next to tall grass.';
    return null;
  }

  getProgress(): GrindProgress {
    return this.progress;
  }

  /** Release every button and restore the game's options. */
  dispose(): void {
    this.keys = 0;
    if (this.savedOptions === null) return;
    const b = saveBlocks(this.mem, this.data);
    if (!b) return;
    // Put back text speed and battle scene; keep anything else that changed (Set mode).
    const now = this.mem.u16(b.sb2 + OPTIONS);
    const mask = 7 | (1 << 10);
    this.setOptions((now & ~mask) | (this.savedOptions & mask));
  }

  private setOptions(v: number): void {
    const b = saveBlocks(this.mem, this.data);
    if (!b) return;
    this.write(b.sb2 + OPTIONS, v & 0xff);
    this.write(b.sb2 + OPTIONS + 1, v >> 8);
  }

  step(): GrindEnd | null {
    if (this.ended) return this.ended;
    this.progress.frames++;
    const mem = this.mem;
    const r = this.data.ram;
    const inBattleFlag = (mem.u8(r.main! + this.layout.mainFlags) & 2) !== 0;
    const trainer = inBattleFlag && (mem.u32(r.battleTypeFlags!) & (1 << 3)) !== 0;
    if (trainer) return this.end('handback', 'A trainer wants to battle.');
    if (inBattleFlag && !this.wasInBattle) {
      this.releaseHeld();
      this.decision = null;
      this.progress.battles++;
      this.battleChecked = false;
      this.stepsSinceBattle = 0;
    }
    this.wasInBattle = inBattleFlag;
    // Hand back the moment the lead faints, before any A press could skip past a whiteout.
    if (inBattleFlag && this.activeFainted()) return this.end('handback', `${this.progress.nickname} fainted.`);

    let screen = readScreen3(mem, this.data);
    if (screen === 'overworld' && inBattleFlag) screen = 'busy';
    if (screen !== this.lastScreen) {
      if (this.lastScreen === 'moveMenu') this.leftMoveMenu = true;
      this.lastScreen = screen;
      this.stableFrames = 0;
    } else {
      this.stableFrames++;
    }
    if (screen !== 'overworld') this.releaseHeld();

    if (this.pressLeft > 0) {
      if (--this.pressLeft === 0) {
        this.keys &= ~this.tapKey;
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
        this.tap(Key.A);
        return null;
      case 'battleMenu':
        return this.battleMenu();
      case 'moveMenu':
        return this.moveMenu();
      case 'learnMove':
        if (this.stableFrames < CONFIRM_FRAMES) return null;
        return this.end('handback', `${this.progress.nickname} wants to learn a new move. Your call.`);
      case 'evolution':
        if (this.stableFrames < CONFIRM_FRAMES) return null;
        return this.end('handback', `${this.progress.nickname} is evolving! Press B to stop it, or let it happen.`);
      case 'monFainted':
        // The battle's party menu, which the bot never opens itself.
        this.tap(Key.B);
        return null;
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
        this.tap(Key.B);
        return null;
      case 'busy':
        return null;
    }
  }

  /** The Pokémon out in battle is our lead and has no HP left. */
  private activeFainted(): boolean {
    const bm = this.data.ram.battleMons!;
    return this.mem.u16(bm) === this.progress.species && this.mem.u16(bm + BATTLE_MON_HP) === 0;
  }

  // ---- overworld ----

  private overworld(): GrindEnd | null {
    if (this.held) return this.walk();
    const snap = this.reader.read(this.mem);
    if (!snap.valid) return null;
    const lead = snap.party[0];
    if (!lead) return this.end('problem', 'No Pokémon in the party.');
    this.progress.level = lead.level;
    this.progress.nickname = lead.nickname;
    this.progress.species = lead.species;
    if (lead.hp === 0) return this.end('handback', `${lead.nickname} fainted.`);
    if (lead.level >= this.opts.targetLevel) return this.end('done', `${lead.nickname} reached level ${lead.level}.`);
    if (!hasUsableMove3(lead.moves, lead.pp, this.data.moves)) {
      return this.end('problem', `${lead.nickname} is out of PP. A Pokémon Center will fix that.`);
    }
    const potions = this.opts.usePotions && Grinder3.canUsePotions(this.data);
    const hp = lead.maxHp ? lead.hp / lead.maxHp : 1;
    if (this.wantHeal && (hp >= HEAL_TO || !this.healItem(snap))) this.wantHeal = false;
    if (this.fled && !this.wantHeal && potions && hp < HEAL_TO && this.healItem(snap)) this.wantHeal = true;
    this.fled = false;
    if (!this.wantHeal && hp < HEAL_BELOW) {
      if (!potions) return this.end('problem', `${lead.nickname} is low on HP. Heal up and start again.`);
      if (!this.healItem(snap)) return this.end('problem', `${lead.nickname} is low on HP and the bag has no Potions.`);
      this.wantHeal = true;
    }
    if (this.wantHeal) {
      this.progress.activity = 'Healing';
      this.tap(Key.Start);
      return null;
    }
    return this.walk();
  }

  /** Directions whose neighbouring tile can have wild Pokémon, best first. */
  private static pacingDirs(mem: Mem, data: Gen3Data, x: number, y: number): Dir[] {
    const wild = (dx: number, dy: number) => isWildTile(mem, data, x + dx, y + dy);
    const near = DIRS.filter((d) => wild(...DELTA[d]));
    if (near.length) return near;
    return wild(0, 0) ? [...DIRS] : [];
  }

  private position(): { x: number; y: number; map: number } {
    const b = saveBlocks(this.mem, this.data);
    if (!b) return { x: -1, y: -1, map: -1 };
    const s16 = (v: number) => (v << 16) >> 16;
    return { x: s16(this.mem.u16(b.sb1)), y: s16(this.mem.u16(b.sb1 + 2)), map: (this.mem.u8(b.sb1 + 4) << 8) | this.mem.u8(b.sb1 + 5) };
  }

  private walk(): GrindEnd | null {
    const { x, y, map } = this.position();
    if (map !== this.home.map) return this.end('problem', 'The bot left the area, so it stopped.');

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
          this.dirs = this.dirs.filter((n) => n !== d && n !== OPPOSITE[d]);
          this.dir = null;
          if (this.dirs.length === 0 && this.atHome(x, y)) return this.end('problem', "The bot can't find room to walk here.");
        }
      }
      return null;
    }

    if (this.dir === null) {
      if (this.dirs.length === 0 && this.atHome(x, y)) this.dirs = Grinder3.pacingDirs(this.mem, this.data, x, y);
      this.dir = this.dirs[0] ?? null;
      if (this.dir === null && this.atHome(x, y)) return this.end('problem', 'Stand in or next to tall grass.');
    }
    let next: Dir | null;
    if (this.atHome(x, y)) next = this.dir;
    else if (this.dir && x === this.home.x + DELTA[this.dir][0] && y === this.home.y + DELTA[this.dir][1]) next = OPPOSITE[this.dir];
    else {
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
    this.keys |= DIR_KEY[next];
    return null;
  }

  private atHome(x: number, y: number): boolean {
    return x === this.home.x && y === this.home.y;
  }

  private releaseHeld(): void {
    if (this.held) this.keys &= ~DIR_KEY[this.held];
    this.held = null;
  }

  // ---- battle ----

  private battleMenu(): GrindEnd | null {
    // A new turn: anything the game refused last turn may work again.
    this.pickedSlot = -1;
    this.refused.clear();
    if (!this.decision || this.committed) {
      this.committed = false;
      const snap = this.reader.read(this.mem);
      if (!snap.valid || !snap.enemy || !snap.battleMon) return null;
      const foeName = this.data.speciesName(snap.enemy.species);
      if (!this.battleChecked) {
        this.battleChecked = true;
        // BATTLE_TYPE_IS_MASTER is always set outside link battles; any other flag is a special battle.
        if ((snap.battleType & ~BATTLE_TYPE_IS_MASTER) !== 0) return this.end('handback', 'This is a special battle. Over to you.');
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
    // FIGHT BAG / POKéMON RUN: the cursor is 0…3, row-major.
    const want = this.decision.kind === 'fight' ? 0 : 3;
    const cur = this.mem.u8(this.data.ram.actionCursor!) & 3;
    if ((cur & 1) !== (want & 1)) this.tap(want & 1 ? Key.Right : Key.Left);
    else if (cur >> 1 !== want >> 1) this.tap(want >> 1 ? Key.Down : Key.Up);
    else {
      this.tap(Key.A);
      if (this.decision.kind === 'run') this.committed = true;
    }
    return null;
  }

  private moveMenu(): GrindEnd | null {
    if (this.pickedSlot >= 0 && this.leftMoveMenu) {
      // Back in the move menu before the turn ran: the game refused that move.
      this.refused.add(this.pickedSlot);
      this.pickedSlot = -1;
      const snap = this.reader.read(this.mem);
      if (snap.valid && snap.enemy && snap.battleMon) this.decision = this.decide(snap);
    }
    const d = this.decision;
    if (!d || d.kind !== 'fight') {
      this.tap(Key.B);
      return null;
    }
    // Moves are a 2×2 grid, slot 0…3 row-major.
    const cur = this.mem.u8(this.data.ram.moveCursor!) & 3;
    if ((cur & 1) !== (d.slot & 1)) this.tap(d.slot & 1 ? Key.Right : Key.Left);
    else if (cur >> 1 !== d.slot >> 1) this.tap(d.slot >> 1 ? Key.Down : Key.Up);
    else {
      this.tap(Key.A);
      this.committed = true;
      this.pickedSlot = d.slot;
      this.leftMoveMenu = false;
    }
    return null;
  }

  private decide(snap: Snapshot): BattleAction {
    const data = this.data;
    const me = snap.battleMon!;
    const foe = snap.enemy!;
    const bm = data.ram.battleMons!;
    const pp = [0, 1, 2, 3].map((i) => this.mem.u8(bm + BATTLE_MON_PP + i));
    const f = snap.field ?? { weather: 0, sides: [0, 0] as [number, number], double: false };
    const field = (defenderIsPlayer: boolean): BattleField => ({
      weather: f.weather,
      badges: snap.badges,
      link: false,
      defenderSide: f.sides[defenderIsPlayer ? 0 : 1],
    });
    const lead = snap.party[snap.activeSlot];
    const duel: Duel3 = {
      me: toBattler(data, me, me.extra ?? (lead ? this.partyExtras(lead) : NO_EXTRAS), true),
      foe: toBattler(data, foe, foe.extra ?? NO_EXTRAS, false),
      myMoves: me.moves,
      myPp: pp,
      foeMoves: foe.moves,
      moves: data.moves,
      chart: data.typeTable,
      vsFoe: field(false),
      vsMe: field(true),
      exclude: this.refused,
    };
    return chooseAction3(duel);
  }

  private partyExtras(m: MonData): BattleExtras {
    return { ...NO_EXTRAS, ability: m.ability ?? 0, item: m.item ?? 0, status: m.status, ivs: m.ivs ?? 0, friendship: m.friendship ?? 0 };
  }

  // ---- healing (Emerald, FireRed and LeafGreen menus) ----

  private healItem(snap: Snapshot): number | null {
    for (const h of HEALS) if ((snap.bag[h.id] ?? 0) > 0) return h.id;
    return null;
  }

  private heal(screen: Screen): GrindEnd | null {
    if (!this.wantHeal) {
      this.tap(Key.B);
      return null;
    }
    const mem = this.mem;
    const r = this.data.ram;
    switch (screen) {
      case 'startMenu': {
        const n = mem.u8(r.startMenuCount!);
        let target = -1;
        for (let i = 0; i < n && i < 9; i++) if (mem.u8(r.startMenuActions! + i) === START_MENU_BAG) target = i;
        if (target < 0) return this.end('problem', "Couldn't find the bag in the menu.");
        const cur = mem.u8(r.startMenuCursor!);
        this.tap(cur < target ? Key.Down : cur > target ? Key.Up : Key.A);
        return null;
      }
      case 'bagList': {
        const snap = this.reader.read(mem);
        const lead = snap.party[0];
        const id = this.healItem(snap);
        if (!lead || !lead.maxHp || lead.hp / lead.maxHp >= HEAL_TO || id === null) {
          // Done (or out of Potions): close the bag.
          this.wantHeal = false;
          this.tap(Key.B);
          return null;
        }
        const { pocket, at } = this.bagCursor();
        if (pocket !== 0) {
          // The Items pocket is the leftmost.
          this.tap(Key.Left);
          return null;
        }
        const target = this.itemsIndex(id);
        if (target < 0) {
          this.wantHeal = false;
          this.tap(Key.B);
          return null;
        }
        this.tap(at < target ? Key.Down : at > target ? Key.Up : Key.A);
        return null;
      }
      case 'itemAction': {
        // USE is the first entry, where the cursor starts.
        const chosen = mem.u16(r.specialVarItemId!);
        this.tap(HEALS.some((h) => h.id === chosen) ? Key.A : Key.B);
        return null;
      }
      case 'partyMenu': {
        const slot = this.partySlot();
        this.tap(slot === 0 ? Key.A : slot >= 1 && slot <= 5 ? Key.Left : Key.Up);
        return null;
      }
    }
    return null;
  }

  /** The party menu slot under the cursor (6 or 7 for the buttons below the party). */
  private partySlot(): number {
    const mem = this.mem;
    const r = this.data.ram;
    if (r.partyMenu) return (mem.u8(r.partyMenu + 9) << 24) >> 24; // gPartyMenu.slotId
    // R/S: the cursor is a sprite whose data[0] is the slot; the menu task's data[3] high byte is its id.
    for (let i = 0; i < 16; i++) {
      const t = r.tasks! + i * 0x28;
      if (!mem.u8(t + 4) || (mem.u32(t) & ~1) !== this.data.sym.partyInput) continue;
      const sprite = mem.u16(t + 8 + 3 * 2) >> 8;
      return (mem.u16(r.sprites! + sprite * 0x44 + 0x2e) << 16) >> 16;
    }
    return 0;
  }

  /** The bag's open pocket and the list position its cursor is on. */
  private bagCursor(): { pocket: number; at: number } {
    const mem = this.mem;
    const r = this.data.ram;
    if (r.bagPocket !== undefined && r.bagScroll !== undefined) {
      // R/S: sCurrentBagPocket and gBagPocketScrollStates[pocket] = { cursorPos, scrollTop, numSlots, cursorMax }.
      const pocket = mem.u8(r.bagPocket);
      return { pocket, at: mem.u8(r.bagScroll + pocket * 4) + mem.u8(r.bagScroll + pocket * 4 + 1) };
    }
    const b = r.bagPosition!;
    if (this.data.gameFamily === 'frlg') {
      // gBagMenuState: u16 pocket, itemsAbove[3], cursorPos[3].
      const pocket = mem.u16(b + 6);
      return { pocket, at: mem.u16(b + 8 + pocket * 2) + mem.u16(b + 0xe + pocket * 2) };
    }
    // gBagPosition: u8 pocket, cursorPosition[5], scrollPosition[5].
    const pocket = mem.u8(b + 5);
    return { pocket, at: mem.u16(b + 8 + pocket * 2) + mem.u16(b + 0x12 + pocket * 2) };
  }

  /** The item's row in the Items pocket list (the pocket keeps its items packed in order). */
  private itemsIndex(id: number): number {
    const b = saveBlocks(this.mem, this.data);
    if (!b) return -1;
    const [off, count] = this.layout.items;
    let row = 0;
    for (let i = 0; i < count; i++) {
      const item = this.mem.u16(b.sb1 + off + i * 4);
      if (!item) continue;
      if (item === id) return row;
      row++;
    }
    return -1;
  }

  // ---- input ----

  private tap(key: number): void {
    this.tapKey = key;
    this.pressLeft = PRESS_FRAMES;
    this.keys |= key;
  }

  private end(kind: GrindEndKind, message: string): GrindEnd {
    const lead = this.reader.read(this.mem).party[0];
    if (lead && lead.species === this.progress.species) this.progress.level = lead.level;
    this.releaseHeld();
    this.keys = 0;
    this.pressLeft = 0;
    this.ended = { kind, message };
    this.progress.activity = message;
    return this.ended;
  }
}
