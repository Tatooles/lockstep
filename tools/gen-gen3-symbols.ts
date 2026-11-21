// Generates src/gen3/symbols.ts from the pret decompilations' symbol files
// (the `symbols` branch of pret/pokeemerald, pokefirered and pokeruby).
//   node tools/gen-gen3-symbols.ts
// Downloads the .sym files into tools/out/sym on first run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIR = join(ROOT, 'tools/out/sym');
mkdirSync(DIR, { recursive: true });

// Variant key is game code + revision byte (header 0xAC and 0xBC).
const VARIANTS: { key: string; repo: string; file: string; family: 'rs' | 'e' | 'frlg' }[] = [
  { key: 'AXVE0', repo: 'pokeruby', file: 'pokeruby', family: 'rs' },
  { key: 'AXVE1', repo: 'pokeruby', file: 'pokeruby_rev1', family: 'rs' },
  { key: 'AXVE2', repo: 'pokeruby', file: 'pokeruby_rev2', family: 'rs' },
  { key: 'AXPE0', repo: 'pokeruby', file: 'pokesapphire', family: 'rs' },
  { key: 'AXPE1', repo: 'pokeruby', file: 'pokesapphire_rev1', family: 'rs' },
  { key: 'AXPE2', repo: 'pokeruby', file: 'pokesapphire_rev2', family: 'rs' },
  { key: 'BPEE0', repo: 'pokeemerald', file: 'pokeemerald', family: 'e' },
  { key: 'BPRE0', repo: 'pokefirered', file: 'pokefirered', family: 'frlg' },
  { key: 'BPRE1', repo: 'pokefirered', file: 'pokefirered_rev1', family: 'frlg' },
  { key: 'BPGE0', repo: 'pokefirered', file: 'pokeleafgreen', family: 'frlg' },
  { key: 'BPGE1', repo: 'pokefirered', file: 'pokeleafgreen_rev1', family: 'frlg' },
];

// Output name -> candidate symbol names (first found wins).
const ROM: Record<string, string[]> = {
  speciesNames: ['gSpeciesNames'],
  baseStats: ['gSpeciesInfo', 'gBaseStats'],
  evolutions: ['gEvolutionTable'],
  dexNums: ['sSpeciesToNationalPokedexNum', 'gSpeciesToNationalPokedexNum'],
  trainers: ['gTrainers'],
  trainerClassNames: ['gTrainerClassNames'],
  frontPics: ['gMonFrontPicTable'],
  palettes: ['gMonPaletteTable'],
  moveNames: ['gMoveNames'],
  moves: ['gBattleMoves'],
  expTables: ['gExperienceTables'],
  wildHeaders: ['gWildMonHeaders'],
  items: ['gItems'],
  regionMapEntries: ['gRegionMapEntries'],
  kantoMapName0: ['sMapsecName_PALLET_TOWN'],
  typeEffectiveness: ['gTypeEffectiveness'],
  abilityNames: ['gAbilityNames'],
  mapGroups: ['gMapGroups'],
  pokedexEntries: ['gPokedexEntries'],
  // Auto-grind: which screen is up (function pointers the game keeps in RAM).
  cb1Overworld: ['CB1_Overworld'],
  cb2Overworld: ['CB2_Overworld'],
  cb2Battle: ['BattleMainCB2'],
  cb2Evolution: ['CB2_EvolutionSceneUpdate'],
  evolutionTask: ['Task_EvolutionScene'],
  // The player's battle controller (the first definition is battle_controller_player.c's).
  chooseAction: ['HandleInputChooseAction'],
  chooseMove: ['HandleInputChooseMove'],
  chooseTarget: ['HandleInputChooseTarget'],
  textWait: ['CompleteOnInactiveTextPrinter'],
  textWait2: ['CompleteOnInactiveTextPrinter2'],
  chooseMon: ['WaitForMonSelection'],
  startMenuInput: ['HandleStartMenuInput', 'StartCB_HandleInput', 'StartMenu_InputProcessCallback'],
  startMenuTask: ['Task_ShowStartMenu', 'Task_StartMenuHandleInput', 'sub_80712B4'],
  // Ruby/Sapphire's are unnamed in pokeruby: sub_80A50C8 is the bag list, sub_80A5414 the item's
  // USE/GIVE menu, sub_808B0C0 the party menu's input and sub_806FB44 its "HP was restored" wait.
  bagInput: ['Task_BagMenu_HandleInput', 'sub_80A50C8'],
  itemContext: ['Task_ItemContext_MultipleRows', 'Task_FieldItemContextMenuHandleInput', 'sub_80A5414'],
  itemContext2: ['Task_ItemContext_SingleRow'],
  partyInput: ['Task_HandleChooseMonInput', 'sub_808B0C0'],
  partyMessage: ['sub_806FB44'],
  // FR/LG's item-use animation (waits for A after "POTION was used on…").
  itemUseAnim: ['Task_UseItem_Normal'],
  tileBitAttributes: ['sTileBitAttributes'],
};
// RAM symbols (the same for every revision of a family; checked below).
const RAM: Record<string, string[]> = {
  playerParty: ['gPlayerParty'],
  playerPartyCount: ['gPlayerPartyCount'],
  enemyParty: ['gEnemyParty'],
  saveBlock1Ptr: ['gSaveBlock1Ptr'],
  saveBlock2Ptr: ['gSaveBlock2Ptr'],
  storagePtr: ['gPokemonStoragePtr'],
  saveBlock1: ['gSaveBlock1'],
  saveBlock2: ['gSaveBlock2'],
  storage: ['gPokemonStorage'],
  battleTypeFlags: ['gBattleTypeFlags'],
  battleOutcome: ['gBattleOutcome'],
  main: ['gMain'],
  mapHeader: ['gMapHeader'],
  battleMons: ['gBattleMons'],
  battlerPartyIndexes: ['gBattlerPartyIndexes'],
  trainerOpponent: ['gTrainerBattleOpponent_A', 'gTrainerBattleOpponent'],
  battleWeather: ['gBattleWeather'],
  sideStatuses: ['gSideStatuses'],
  battlerControllerFuncs: ['gBattlerControllerFuncs'],
  actionCursor: ['gActionSelectionCursor'],
  moveCursor: ['gMoveSelectionCursor'],
  battleScriptPtr: ['gBattlescriptCurrInstr'],
  tasks: ['gTasks'],
  textPrinters: ['sTextPrinters'],
  backupMapLayout: ['gBackupMapLayout', 'VMap'],
  specialVarItemId: ['gSpecialVar_ItemId'],
  bagPosition: ['gBagPosition', 'gBagMenuState'],
  bagPocket: ['sCurrentBagPocket'],
  bagScroll: ['gBagPocketScrollStates'],
  partyMenu: ['gPartyMenu'],
  sprites: ['gSprites'],
  startMenuCallback: ['gMenuCallback', 'sStartMenuCallback'],
  startMenuCursor: ['sStartMenuCursorPos'],
  startMenuCount: ['sNumStartMenuActions', 'sNumStartMenuItems'],
  startMenuActions: ['sCurrentStartMenuActions', 'sStartMenuOrder'],
};

function load(repo: string, file: string): Map<string, number> {
  const path = join(DIR, `${file}.sym`);
  if (!existsSync(path)) throw new Error(`Missing ${path}: download https://raw.githubusercontent.com/pret/${repo}/symbols/${file}.sym`);
  const m = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 4 && !m.has(p[3])) m.set(p[3], parseInt(p[0], 16));
  }
  return m;
}

async function ensure(repo: string, file: string): Promise<void> {
  const path = join(DIR, `${file}.sym`);
  if (existsSync(path)) return;
  const res = await fetch(`https://raw.githubusercontent.com/pret/${repo}/symbols/${file}.sym`);
  if (!res.ok) throw new Error(`${file}.sym: HTTP ${res.status}`);
  writeFileSync(path, await res.text());
}

const hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;
const out: string[] = [];
/** ROM symbols some variant lacks: optional in the interface. */
const partial = new Set<string>();
const ramByFamily = new Map<string, Record<string, number>>();
for (const v of VARIANTS) {
  await ensure(v.repo, v.file);
  const sym = load(v.repo, v.file);
  const pick = (names: string[]) => names.map((n) => sym.get(n)).find((a) => a !== undefined);
  const rom: string[] = [];
  for (const [k, names] of Object.entries(ROM)) {
    const a = pick(names);
    if (a !== undefined) rom.push(`${k}: ${hex(a)}`);
    else partial.add(k);
  }
  out.push(`  ${v.key}: { ${rom.join(', ')} },`);
  const ram: Record<string, number> = {};
  for (const [k, names] of Object.entries(RAM)) {
    const a = pick(names);
    if (a !== undefined) ram[k] = a;
  }
  const prev = ramByFamily.get(v.family);
  if (prev && JSON.stringify(prev) !== JSON.stringify(ram)) throw new Error(`${v.key}: RAM layout differs from its family`);
  ramByFamily.set(v.family, ram);
}

const ramOut = [...ramByFamily].map(
  ([f, r]) => `  ${f}: { ${Object.entries(r).map(([k, a]) => `${k}: ${hex(a)}`).join(', ')} },`,
);

writeFileSync(
  join(ROOT, 'src/gen3/symbols.ts'),
  `// Generated by tools/gen-gen3-symbols.ts from the pret decompilations' symbol files. Do not edit.

export type Gen3Family = 'rs' | 'e' | 'frlg';

export interface Gen3RomSymbols {
  ${Object.keys(ROM).map((k) => `${k}${partial.has(k) ? '?' : ''}: number;`).join('\n  ')}
}

export interface Gen3RamSymbols {
  ${Object.keys(RAM).map((k) => `${k}?: number;`).join('\n  ')}
}

/** ROM addresses by game code + revision (e.g. BPEE0 is Emerald, BPRE1 FireRed v1.1). */
export const ROM_SYMBOLS: Record<string, Gen3RomSymbols> = {
${out.join('\n')}
};

/** RAM addresses by family (identical across revisions and across paired versions). */
export const RAM_SYMBOLS: Record<Gen3Family, Gen3RamSymbols> = {
${ramOut.join('\n')}
};
`,
);
console.log(`wrote src/gen3/symbols.ts (${VARIANTS.length} variants)`);
