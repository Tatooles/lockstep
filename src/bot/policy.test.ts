import { describe, expect, it } from 'vitest';
import type { Move } from '../gen1/rom.ts';
import { chooseAction, foeCanKo, scoreMoves, type Fighter } from './policy.ts';
import { classify } from './screen.ts';

const NORMAL = 0x00;
const FIRE = 0x14;
const GRASS = 0x16;
const chart = (atk: number, def: [number, number]) => (atk === FIRE && def.includes(GRASS) ? 2 : 1);

// Move table indexed by id, like Gen1Data.moves.
const MOVES: Move[] = [];
const add = (id: number, p: Partial<Move>) => (MOVES[id] = { id, name: `m${id}`, effect: 0, power: 40, type: NORMAL, accuracy: 100, pp: 35, ...p });
add(1, { name: 'Tackle', power: 35, accuracy: 95 });
add(2, { name: 'Growl', power: 0 });
add(3, { name: 'Ember', power: 40, type: FIRE });
add(4, { name: 'Selfdestruct', power: 130, effect: 0x07 });
add(5, { name: 'Hyper Beam', power: 150, effect: 0x50, accuracy: 90 });
add(6, { name: 'Thrash', power: 90, effect: 0x1b });
add(7, { name: 'Slam', power: 80, accuracy: 75 });

const fighter = (p: Partial<Fighter>): Fighter => ({
  level: 10, hp: 30, maxHp: 30, atk: 20, def: 20, spd: 20, spc: 20, types: [NORMAL, NORMAL], moves: [1, 2, 0, 0], ...p,
});

describe('auto-grind battle policy', () => {
  it('picks the strongest usable move and skips status moves', () => {
    const me = fighter({ moves: [1, 2, 3, 0] });
    const foe = fighter({ types: [GRASS, GRASS], hp: 100, maxHp: 100 });
    const s = scoreMoves(me, foe, MOVES, chart);
    expect(s[0].move.name).toBe('Ember');
    expect(s.map((x) => x.move.name)).not.toContain('Growl');
  });

  it('never picks moves that faint the user or lock it in', () => {
    const me = fighter({ moves: [4, 6, 1, 0] });
    const s = scoreMoves(me, fighter({ hp: 100, maxHp: 100 }), MOVES, chart);
    expect(s.map((x) => x.move.name)).toEqual(['Tackle']);
  });

  it('skips moves without PP', () => {
    const me = fighter({ moves: [1, 3, 0, 0], pp: [10, 0, 0, 0] });
    expect(scoreMoves(me, fighter({}), MOVES, chart).map((x) => x.move.name)).toEqual(['Tackle']);
  });

  it('prefers an accurate sure knockout over a bigger but shakier hit', () => {
    const me = fighter({ moves: [7, 1, 0, 0], atk: 40 });
    const foe = fighter({ hp: 5 });
    expect(chooseAction(me, foe, MOVES, chart)).toMatchObject({ kind: 'fight', slot: 1 });
  });

  it('runs when the foe could knock it out, crits included', () => {
    const me = fighter({ hp: 4, def: 5 });
    const foe = fighter({ hp: 30, atk: 30 });
    expect(foeCanKo(me, foe, MOVES, chart)).toBe(true);
    expect(chooseAction(me, foe, MOVES, chart)).toMatchObject({ kind: 'run' });
  });

  it('stays to finish a dangerous foe when it moves first with a sure KO', () => {
    const me = fighter({ hp: 4, def: 5, spd: 50, moves: [3, 0, 0, 0] });
    const foe = fighter({ hp: 3, atk: 30 });
    expect(chooseAction(me, foe, MOVES, chart)).toMatchObject({ kind: 'fight', slot: 0 });
  });

  it('fights when the foe is harmless', () => {
    expect(chooseAction(fighter({}), fighter({ moves: [2, 0, 0, 0] }), MOVES, chart)).toMatchObject({ kind: 'fight' });
  });

  it('runs when nothing can do damage', () => {
    expect(chooseAction(fighter({ moves: [2, 0, 0, 0] }), fighter({ moves: [2, 0, 0, 0] }), MOVES, chart)).toMatchObject({ kind: 'run' });
  });
});

describe('auto-grind screen detection', () => {
  // Call chains captured from Pokémon Red (innermost first).
  it('reads the battle menus', () => {
    expect(classify(['HandleMenuInput_', 'DisplayBattleMenu', 'OverworldLoopLessDelay'])).toBe('battleMenu');
    expect(classify(['HandleMenuInput_', 'SelectMenuItem', 'OverworldLoopLessDelay'])).toBe('moveMenu');
  });

  it('spots the move-learning prompt before the generic yes/no', () => {
    expect(classify(['HandleMenuInput_', 'DisplayTwoOptionMenu', 'TryingToLearn', 'DontAbandonLearning', 'OverworldLoopLessDelay'])).toBe('learnMove');
    expect(classify(['HandleMenuInput_', 'DisplayTwoOptionMenu', 'OverworldLoopLessDelay'])).toBe('yesNo');
  });

  it('reads the bag flow by its innermost owner', () => {
    expect(classify(['HandleMenuInput_', 'DisplayListMenuIDLoop', 'StartMenu_Item', 'OverworldLoopLessDelay'])).toBe('bagList');
    expect(classify(['HandleMenuInput_', 'StartMenu_Item', 'OverworldLoopLessDelay'])).toBe('itemAction');
    expect(classify(['HandleMenuInput_', 'RedisplayStartMenu', 'OverworldLoopLessDelay'])).toBe('startMenu');
  });

  it('tells text, evolution, walking and busy apart', () => {
    expect(classify(['WaitForTextScrollButtonPress', 'ManualTextScroll', 'OverworldLoopLessDelay'])).toBe('text');
    expect(classify(['WaitForTextScrollButtonPress', 'Evolution_PartyMonLoop', 'OverworldLoopLessDelay'])).toBe('evolution');
    expect(classify(['OverworldLoopLessDelay'])).toBe('overworld');
    expect(classify(['DisplayBattleMenu', 'OverworldLoopLessDelay'])).toBe('busy');
  });
});
