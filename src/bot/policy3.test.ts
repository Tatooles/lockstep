import { describe, expect, it } from 'vitest';
import { ABILITY, STAGE, TYPE, type BattleField, type Battler, type TypeTable } from '../gen3/damage.ts';
import { chooseAction3, foeThreats3, hasUsableMove3, scoreMoves3, type Duel3, type Move3Info } from './policy3.ts';
import { classify3, OP, type Probe3 } from './screen3.ts';

const CHART: TypeTable = {
  rows: [
    [TYPE.FIRE, TYPE.GRASS, 20],
    [TYPE.GRASS, TYPE.FIRE, 5],
    [TYPE.GROUND, TYPE.FLYING, 0],
    [TYPE.NORMAL, TYPE.GHOST, 0],
  ],
  foresight: 3,
};

// Move table indexed by id, like Gen3Data.moves (effects from battle_move_effects.h).
const MOVES: Move3Info[] = [];
const add = (id: number, p: Partial<Move3Info>) => (MOVES[id] = { id, effect: 0, power: 40, type: TYPE.NORMAL, accuracy: 100, priority: 0, ...p });
add(1, { power: 35, accuracy: 95 }); // Tackle
add(2, { power: 0 }); // Growl
add(3, { type: TYPE.FIRE }); // Ember
add(4, { power: 200, effect: 7 }); // Explosion
add(5, { power: 90, effect: 27 }); // Thrash
add(6, { power: 80, accuracy: 75 }); // Slam
add(7, { power: 40, effect: 101 }); // False Swipe
add(8, { power: 1, effect: 38, accuracy: 30 }); // Fissure
add(9, { power: 40, priority: 1 }); // Quick Attack
add(10, { power: 150, effect: 170 }); // Focus Punch
add(11, { power: 100, type: TYPE.GROUND }); // Earthquake
add(12, { power: 150, effect: 80, accuracy: 90 }); // Hyper Beam
add(13, { power: 90 }); // Strength

const mon = (p: Partial<Battler> = {}): Battler => ({
  species: 1, level: 10, hp: 30, maxHp: 30, types: [TYPE.NORMAL, TYPE.NORMAL],
  atk: 20, def: 20, spe: 20, spa: 20, spd: 20, stages: [0, 0, 0, 0, 0, 0, 0, 0],
  ability: 0, holdEffect: 0, holdParam: 0, status: 0, status2: 0, ivs: 0, friendship: 0, weight: 0, player: false, ...p,
});
const FIELD: BattleField = { weather: 0, badges: 0, link: false, defenderSide: 0 };

const duel = (p: Partial<Duel3> = {}): Duel3 => ({
  me: mon({ player: true }),
  foe: mon(),
  myMoves: [1, 2, 0, 0],
  myPp: [35, 40, 0, 0],
  foeMoves: [2, 0, 0, 0],
  moves: MOVES,
  chart: CHART,
  vsFoe: FIELD,
  vsMe: FIELD,
  ...p,
});
const slots = (d: Duel3) => scoreMoves3(d).map((s) => s.slot);

describe('Gen 3 auto-grind battle policy', () => {
  it('picks the strongest usable move and skips status moves', () => {
    const d = duel({ myMoves: [1, 2, 3, 0], myPp: [35, 40, 25, 0], foe: mon({ types: [TYPE.GRASS, TYPE.GRASS], hp: 100, maxHp: 100 }) });
    expect(slots(d)).toEqual([2, 0]);
  });

  it('never picks moves that faint the user, lock it in, need setup, spare the foe or rarely hit', () => {
    const d = duel({ myMoves: [4, 5, 7, 8], myPp: [5, 5, 5, 5], foe: mon({ hp: 100, maxHp: 100 }) });
    expect(slots(d)).toEqual([]);
    expect(slots(duel({ myMoves: [10, 1, 0, 0], myPp: [5, 5, 0, 0] }))).toEqual([1]);
  });

  it('skips moves without PP and moves the game refused this turn', () => {
    expect(slots(duel({ myMoves: [1, 3, 0, 0], myPp: [10, 0, 0, 0] }))).toEqual([0]);
    expect(slots(duel({ myMoves: [1, 3, 0, 0], myPp: [10, 10, 0, 0], exclude: new Set([1]) }))).toEqual([0]);
  });

  it('skips moves the foe is immune to, by type or ability', () => {
    expect(slots(duel({ myMoves: [11, 1, 0, 0], myPp: [5, 5, 0, 0], foe: mon({ ability: ABILITY.LEVITATE }) }))).toEqual([1]);
    expect(slots(duel({ myMoves: [1, 3, 0, 0], myPp: [5, 5, 0, 0], foe: mon({ types: [TYPE.GHOST, TYPE.GHOST] }) }))).toEqual([1]);
  });

  it('prefers an accurate sure knockout over a bigger but shakier hit', () => {
    const d = duel({ myMoves: [6, 1, 0, 0], myPp: [5, 5, 0, 0], me: mon({ player: true, atk: 40 }), foe: mon({ hp: 5 }) });
    expect(chooseAction3(d)).toMatchObject({ kind: 'fight', slot: 1 });
  });

  it('halves recharge moves unless they knock out', () => {
    const tough = duel({ myMoves: [12, 13, 0, 0], myPp: [5, 5, 0, 0], foe: mon({ hp: 300, maxHp: 300 }) });
    expect(slots(tough)).toEqual([1, 0]);
    const weak = duel({ myMoves: [12, 13, 0, 0], myPp: [5, 5, 0, 0], foe: mon({ hp: 8 }), me: mon({ player: true, atk: 40 }) });
    expect(scoreMoves3(weak).every((m) => m.sureKo)).toBe(true);
  });

  it('runs when the foe could knock it out, critical hits included', () => {
    const d = duel({ me: mon({ player: true, hp: 4, def: 5 }), foe: mon({ atk: 30 }), foeMoves: [1, 0, 0, 0] });
    expect(foeThreats3(d)).toEqual([0]);
    expect(chooseAction3(d)).toMatchObject({ kind: 'run', why: 'too dangerous' });
  });

  it('stays to finish a dangerous foe when it moves first with a sure, accurate KO', () => {
    const d = duel({
      me: mon({ player: true, hp: 4, def: 5, spe: 50 }),
      foe: mon({ hp: 3, atk: 30 }),
      myMoves: [3, 0, 0, 0],
      myPp: [5, 0, 0, 0],
      foeMoves: [1, 0, 0, 0],
    });
    expect(chooseAction3(d)).toMatchObject({ kind: 'fight', slot: 0, why: 'finish it first' });
    // Evasion up: the knockout is no longer sure.
    expect(chooseAction3({ ...d, foe: { ...d.foe, stages: [0, 0, 0, 0, 0, 0, 0, 1] } })).toMatchObject({ kind: 'run' });
  });

  it('counts priority both ways', () => {
    const base = duel({ me: mon({ player: true, hp: 4, def: 5, spe: 50 }), foe: mon({ hp: 3, atk: 30 }), myMoves: [3, 0, 0, 0], myPp: [5, 0, 0, 0] });
    // Faster, but the foe's Quick Attack goes first and could knock us out.
    expect(chooseAction3({ ...base, foeMoves: [9, 0, 0, 0] })).toMatchObject({ kind: 'run' });
    // Slower, but our Quick Attack goes first and finishes it.
    const slow = { ...base, me: { ...base.me, spe: 5 }, myMoves: [9, 0, 0, 0], foeMoves: [1, 0, 0, 0] };
    expect(chooseAction3(slow)).toMatchObject({ kind: 'fight', slot: 0 });
  });

  it('fights a harmless foe and runs when nothing can do damage', () => {
    expect(chooseAction3(duel())).toMatchObject({ kind: 'fight', slot: 0 });
    expect(chooseAction3(duel({ myMoves: [2, 0, 0, 0] }))).toMatchObject({ kind: 'run', why: 'no usable moves' });
  });

  it('knows when the lead is out of usable PP', () => {
    expect(hasUsableMove3([1, 2, 0, 0], [0, 40, 0, 0], MOVES)).toBe(false);
    expect(hasUsableMove3([4, 1, 0, 0], [5, 1, 0, 0], MOVES)).toBe(true);
    expect(hasUsableMove3([4, 2, 0, 0], [5, 40, 0, 0], MOVES)).toBe(false);
  });

  it('reads accuracy stages', () => {
    const accDown = duel({ me: mon({ player: true, stages: [0, 0, 0, 0, 0, 0, -1, 0] }), foe: mon({ hp: 300, maxHp: 300 }) });
    expect(scoreMoves3(accDown)[0].hitChance).toBeCloseTo(0.95 * 0.75);
    expect(STAGE.ACC).toBe(6);
  });
});

const probe = (p: Partial<Probe3>): Probe3 => ({
  main: 'other', fieldInput: false, controller: 'other', scriptOp: -1, textWaiting: false,
  startMenu: false, bag: false, itemContext: false, party: false, itemAnim: false, evolution: false, ...p,
});

describe('Gen 3 auto-grind screen detection', () => {
  it('reads the battle menus from the player controller', () => {
    expect(classify3(probe({ main: 'battle', controller: 'action' }))).toBe('battleMenu');
    expect(classify3(probe({ main: 'battle', controller: 'move' }))).toBe('moveMenu');
    expect(classify3(probe({ main: 'battle', controller: 'text' }))).toBe('text');
    expect(classify3(probe({ main: 'battle', controller: 'chooseMon' }))).toBe('monFainted');
    expect(classify3(probe({ main: 'battle' }))).toBe('busy');
  });

  it('spots the learn-move prompt and the level-up box from the battle script', () => {
    expect(classify3(probe({ main: 'battle', scriptOp: OP.YESNO_LEARN_MOVE }))).toBe('learnMove');
    expect(classify3(probe({ main: 'battle', scriptOp: OP.YESNO_STOP_LEARNING, controller: 'text' }))).toBe('learnMove');
    expect(classify3(probe({ main: 'battle', scriptOp: OP.DRAW_LVLUP_BOX }))).toBe('text');
  });

  it('tells evolution, the field, its menus and text apart', () => {
    expect(classify3(probe({ main: 'evolution' }))).toBe('evolution');
    expect(classify3(probe({ evolution: true }))).toBe('evolution');
    expect(classify3(probe({ main: 'overworld', fieldInput: true }))).toBe('overworld');
    expect(classify3(probe({ main: 'overworld', fieldInput: true, startMenu: true }))).toBe('startMenu');
    expect(classify3(probe({ main: 'overworld', fieldInput: true, textWaiting: true }))).toBe('text');
    expect(classify3(probe({ bag: true }))).toBe('bagList');
    expect(classify3(probe({ itemContext: true }))).toBe('itemAction');
    expect(classify3(probe({ party: true }))).toBe('partyMenu');
    expect(classify3(probe({ itemAnim: true }))).toBe('text');
    expect(classify3(probe({ main: 'overworld' }))).toBe('busy');
  });
});
