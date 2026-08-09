'use strict';
/* voxiCraft — structures: capture, save, and spawn prefabs.

   ================================================================================================
   HOW THE WHOLE THING FITS TOGETHER
   ================================================================================================
   1. AUTHORING. Place a Structure Block, right-click it, type a size + a name, press Save. The
      block reads the volume out of the world and writes a JSON prefab. The prefab holds every
      non-air cell as [x, y, z, id, variant] — variant is what preserves double slabs, stair
      facings, log widths, door hinges and everything else that lives in the high byte.

   2. STORAGE. Saved prefabs go to localStorage immediately (so they work the moment you press
      Save) AND can be downloaded as a .json to drop into structures/ and ship with the game.
      At boot both sources are merged; a file in structures/ wins over a localStorage draft of
      the same id, so a shipped prefab can't be shadowed by an old local experiment.

   3. SPAWNING. Prefabs carry a `spawn` block naming biomes, a per-chunk chance and a height band.
      When a chunk finishes generating, a seeded hash decides whether that chunk gets a structure,
      and the prefab is stamped in with setBlock.

      Placement runs on the MAIN THREAD, not in the generator. The generator lives in a worker
      that only ever sees raw chunk data, so shipping prefabs into it would mean a whole new
      transfer path and a save-format change. Stamping afterwards costs one pass over the prefab's
      cells, reuses the existing edit/persistence machinery for free, and means a structure that
      spawns is saved exactly like something the player built.

   4. LOOT. A prefab may mark cells as loot containers. Nothing is generated at spawn time — the
      chest records which table it owes, and the roll happens the first time it is OPENED. That
      keeps a hundred untouched chests from costing anything, and it is what makes the contents
      feel rolled-for-you rather than baked into the map.
   ================================================================================================ */

const STRUCT_LS_KEY = 'vc_structures';
const STRUCT_DIR = 'structures/';
const STRUCT_MANIFEST = STRUCT_DIR + 'manifest.json';

const STRUCTURES = new Map();          // id -> prefab
const STRUCT_GROUPS = new Map();       // group name -> settlement/dungeon config from the manifest
const STRUCT_MAX_SPAN = 48;            // per-axis clamp; a prefab is stamped in one frame

/* ---------------------------------- loot ---------------------------------- */
/* A table is { rolls: [min, max], entries: [{ id, min, max, chance }] }. A roll picks one entry
   at random, tests its chance, and on success drops a stack of min..max into a free slot. Entries
   are referenced by NAME so several chests can share one table and a prefab stays readable. */
const DEFAULT_LOOT = {
  '1': {
    name: 'basic',
    rolls: [3, 6],
    entries: [
      { id: 'WOODEN_PICKAXE', min: 1, max: 1, chance: 0.35 },
      { id: 'WOODEN_HATCHET', min: 1, max: 1, chance: 0.35 },
      { id: 'WOODEN_SHOVEL',  min: 1, max: 1, chance: 0.35 },
      { id: 'WOODEN_SWORD',   min: 1, max: 1, chance: 0.30 },
      { id: 'APPLE',          min: 1, max: 3, chance: 0.60 },
      { id: 'BREAD',          min: 1, max: 2, chance: 0.50 },
      { id: 'STRING',         min: 1, max: 4, chance: 0.30 },
      { id: 'GUNPOWDER',      min: 1, max: 2, chance: 0.25 },
      { id: 'FLINT',          min: 1, max: 3, chance: 0.30 },
      { id: 'BRICK',          min: 1, max: 4, chance: 0.25 },
      { id: 'FEATHER',        min: 1, max: 3, chance: 0.30 },
      { id: 'FLOUR',          min: 1, max: 2, chance: 0.25 },
      { id: 'B:LOG',          min: 1, max: 5, chance: 0.45 },
    ],
  },
};

/* Entries name their contents rather than hardcoding numbers, so a prefab stays valid when block
   and item ids shift around. "B:NAME" is a block from the B enum, anything else an ITEM. */
function resolveLootId(name) {
  if (typeof name === 'number') return name;
  if (typeof name !== 'string') return null;
  if (name.startsWith('B:')) { const v = B[name.slice(2)]; return v == null ? null : v; }
  const v = ITEM[name];
  return v == null ? null : v;
}

// NOT `_ri` — 28-entities.js already owns that name, and these are classic scripts sharing one
// global lexical scope, so a duplicate top-level const throws and takes the whole file with it
const _lootRange = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/* Roll a table into a slot array, scattering stacks across random EMPTY slots. Returns how many
   stacks landed. Slots already holding something are left alone, so re-rolling is harmless. */
function rollLootInto(slots, table) {
  if (!table || !Array.isArray(table.entries) || !table.entries.length) return 0;
  const [rMin, rMax] = Array.isArray(table.rolls) ? table.rolls : [1, 3];
  const rolls = _lootRange(Math.max(0, rMin | 0), Math.max(rMin | 0, rMax | 0));
  let placed = 0;
  for (let r = 0; r < rolls; r++) {
    const e = table.entries[Math.floor(Math.random() * table.entries.length)];
    if (!e || Math.random() >= (e.chance ?? 1)) continue;
    const id = resolveLootId(e.id);
    if (id == null) continue;
    // pick a free slot at random rather than filling front-to-back, so a chest looks looted
    const free = [];
    for (let i = 0; i < slots.length; i++) if (!slots[i]) free.push(i);
    if (!free.length) break;
    const at = free[Math.floor(Math.random() * free.length)];
    const n = Math.max(1, Math.min(stackSize(id), _lootRange(e.min ?? 1, e.max ?? 1)));
    slots[at] = mkSlot(id, n);
    placed++;
  }
  return placed;
}

/* Cells owing a loot roll: "x,y,z" -> table name. Populated when a structure is stamped, consumed
   the first time that container is opened, and persisted with the world so an unopened chest is
   still full after a reload. */
const PENDING_LOOT = new Map();
const lootKey = (x, y, z) => x + ',' + y + ',' + z;

function markPendingLoot(x, y, z, tableName, structId) {
  PENDING_LOOT.set(lootKey(x, y, z), { table: tableName, struct: structId });
}
/* Called from openChest. Fills the chest the first time it is opened and clears the marker, so a
   player who empties a chest and walks away does not find it refilled. */
/* Resolve a table reference against a prefab's own tables. A chest may name either the KEY
   ("1", "2") or the table's human `name` ("basic", "super good"), so a prefab stays readable
   whichever convention its author prefers. Falls back to the built-in tables. */
function resolveLootTable(prefab, ref) {
  const tables = (prefab && prefab.lootTables) || DEFAULT_LOOT;
  if (tables[ref]) return tables[ref];
  for (const k in tables) if (tables[k] && tables[k].name === ref) return tables[k];
  return DEFAULT_LOOT[ref] || null;
}
function fillPendingLoot(x, y, z, slots) {
  const k = lootKey(x, y, z);
  const rec = PENDING_LOOT.get(k);
  if (!rec) return false;
  PENDING_LOOT.delete(k);
  rollLootInto(slots, resolveLootTable(STRUCTURES.get(rec.struct), rec.table));
  return true;
}
function serializePendingLoot() {
  return [...PENDING_LOOT].map(([k, v]) => [k, v.table, v.struct]);
}
function restorePendingLoot(list) {
  PENDING_LOOT.clear();
  if (!Array.isArray(list)) return;
  for (const rec of list)
    if (Array.isArray(rec) && typeof rec[0] === 'string') PENDING_LOOT.set(rec[0], { table: rec[1], struct: rec[2] });
}

/* ---------------------------------- prefab store ---------------------------------- */
function _lsStructures() {
  try {
    const raw = JSON.parse(localStorage.getItem(STRUCT_LS_KEY));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function _saveLsStructure(prefab) {
  const all = _lsStructures();
  all[prefab.id] = prefab;
  try { localStorage.setItem(STRUCT_LS_KEY, JSON.stringify(all)); }
  catch { toast('structure too large for local storage'); }
}

/* ---------------------------------- diagnostics ---------------------------------- */
/* These files are hand-edited, so a missing comma or bracket is the normal failure — not an
   exotic one. Everything below exists to turn "nothing spawned and I don't know why" into a
   message that names the file, the line, and the character. */
function _structReport(level, src, msg) {
  const line = `[structure] ${src}: ${msg}`;
  if (level === 'error') { console.error(line); toast('structure error — see console'); }
  else console.warn(line);
}

// byte offset -> "line N col M", plus that line's text and a caret under the offending character
function _posInfo(text, pos) {
  const upto = text.slice(0, pos);
  const line = upto.split('\n').length;
  const col = pos - (upto.lastIndexOf('\n') + 1);
  const body = text.split('\n')[line - 1] ?? '';
  return { line, col, body, caret: ' '.repeat(Math.max(0, col)) + '^' };
}

/* JSON.parse messages differ between engines and rarely say WHICH bracket is unbalanced, so on
   failure we do our own scan: walk the text tracking string state, count the delimiters, and
   report the first structural problem we can actually name. */
function _diagnoseJson(text) {
  const stack = [];
  let inStr = false, esc = false, lineNo = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') lineNo++;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      else if (c === '\n') return `unterminated string starting on line ${lineNo - 1} — missing a closing "`;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') stack.push({ c, lineNo });
    else if (c === '}' || c === ']') {
      const want = c === '}' ? '{' : '[';
      const top = stack.pop();
      if (!top) return `stray '${c}' on line ${lineNo} — one closing bracket too many`;
      if (top.c !== want) return `'${c}' on line ${lineNo} closes a '${top.c}' opened on line ${top.lineNo} — brackets crossed`;
    } else if (c === ',') {
      // a comma directly before a closer is the classic trailing comma JSON rejects
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') return `trailing comma on line ${lineNo} — JSON does not allow one before '${text[j]}'`;
    }
  }
  if (inStr) return 'unterminated string — a " is missing somewhere';
  if (stack.length) {
    const t = stack[stack.length - 1];
    return `'${t.c}' opened on line ${t.lineNo} is never closed`;
  }
  return null;
}

function parseStructureText(text, src) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const hint = _diagnoseJson(text);
    const m = /position (\d+)/.exec(err.message);
    let where = '';
    if (m) {
      const p = _posInfo(text, +m[1]);
      where = `\n  line ${p.line}, col ${p.col + 1}:\n  ${p.body}\n  ${p.caret}`;
    }
    _structReport('error', src, `${hint || err.message}${where}`);
    return null;
  }
}

/* ---------------------------------- migration ---------------------------------- */
/* Prefabs are data files that outlive the code that wrote them. Rather than demanding the author
   rewrite old files whenever a field is added, normalise on load: fill in defaults, translate
   retired fields, and coerce loose types. Anything actually broken is reported and dropped rather
   than left to fail later inside the mesher. */
const STRUCT_FORMAT = 2;         // 1 = pre-modes (spawn.surface boolean), 2 = spawn.mode

function migrateStructure(raw, src) {
  if (!raw || typeof raw !== 'object') { _structReport('error', src, 'file is not a JSON object'); return null; }
  const p = raw;
  const fixes = [];

  if (typeof p.id !== 'string' || !p.id) {
    p.id = src.replace(/\.json$/i, '') || 'structure';
    fixes.push(`missing "id" — using "${p.id}"`);
  }

  if (!Array.isArray(p.blocks)) { _structReport('error', src, 'missing or non-array "blocks"'); return null; }
  // drop malformed cells rather than letting a bad tuple crash stampStructure later
  const before = p.blocks.length;
  p.blocks = p.blocks.filter(b =>
    Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every(v => Number.isFinite(v)));
  if (p.blocks.length !== before) fixes.push(`dropped ${before - p.blocks.length} malformed block entries`);
  if (!p.blocks.length) { _structReport('error', src, '"blocks" is empty after validation'); return null; }

  // size may be absent or stale — recompute it from the cells, which is always authoritative
  let mx = 0, my = 0, mz = 0;
  for (const b of p.blocks) { mx = Math.max(mx, b[0]); my = Math.max(my, b[1]); mz = Math.max(mz, b[2]); }
  const want = [mx + 1, my + 1, mz + 1];
  if (!Array.isArray(p.size) || p.size.length !== 3 || p.size.some((v, i) => v !== want[i])) {
    if (Array.isArray(p.size)) fixes.push(`size ${JSON.stringify(p.size)} did not match the blocks — corrected to ${JSON.stringify(want)}`);
    p.size = want;
  }

  // unknown block ids: a prefab built on a newer build, or an id that has since moved
  const unknown = new Set();
  for (const b of p.blocks) if (!PROPS[b[3]]) unknown.add(b[3]);
  if (unknown.size) {
    p.blocks = p.blocks.filter(b => PROPS[b[3]]);
    fixes.push(`skipped unknown block ids [${[...unknown].join(', ')}]`);
  }

  /* spawn: fill defaults and translate the retired `surface` boolean into `mode`. */
  const s = (p.spawn && typeof p.spawn === 'object') ? p.spawn : (p.spawn = {});
  if (!s.mode) {
    s.mode = s.surface === false ? 'air' : 'surface';
    if ('surface' in s) fixes.push(`converted "surface": ${s.surface} to "mode": "${s.mode}"`);
  }
  if (!STRUCT_MODES.includes(s.mode)) {
    fixes.push(`unknown mode "${s.mode}" — falling back to "surface"`);
    s.mode = 'surface';
  }
  if (p.group != null && typeof p.group !== 'string') { delete p.group; fixes.push('"group" was not a string — ignored'); }
  // a group member is positioned by its group, so it has no business rolling its own chance
  if (typeof s.chance !== 'number') {
    s.chance = 0;
    if (!p.group) fixes.push('no spawn chance — this prefab will not spawn naturally');
  }
  if (typeof s.minY !== 'number') s.minY = 0;
  if (typeof s.maxY !== 'number') s.maxY = 255;
  if (s.minY > s.maxY) { const t = s.minY; s.minY = s.maxY; s.maxY = t; fixes.push('minY was above maxY — swapped'); }
  if (s.biomes != null && !Array.isArray(s.biomes)) { delete s.biomes; fixes.push('"biomes" was not an array — ignored'); }

  /* loot: every referenced table must exist, and every marked cell must actually hold a container,
     or the marker sits on a block nothing can ever open. */
  if (p.loot && typeof p.loot === 'object') {
    const tables = (p.lootTables && typeof p.lootTables === 'object') ? p.lootTables : {};
    const names = new Set(Object.keys(tables));
    for (const k in tables) if (tables[k] && tables[k].name) names.add(tables[k].name);
    const cells = new Set(p.blocks.filter(b => PROPS[b[3]]?.model === 'chest' || b[3] === B.FURNACE)
                                  .map(b => b[0] + ',' + b[1] + ',' + b[2]));
    for (const k of Object.keys(p.loot)) {
      if (!cells.has(k)) { delete p.loot[k]; fixes.push(`loot cell "${k}" is not a chest or furnace — ignored`); continue; }
      const ref = p.loot[k];
      if (!names.has(ref) && !DEFAULT_LOOT[ref])
        fixes.push(`loot cell "${k}" points at table "${ref}", which this file does not define`);
    }
  }
  if (p.lootTables && typeof p.lootTables === 'object')
    for (const k in p.lootTables) {
      const t = p.lootTables[k];
      if (!t || !Array.isArray(t.entries)) { fixes.push(`loot table "${k}" has no entries array`); continue; }
      if (!Array.isArray(t.rolls)) { t.rolls = [1, 3]; fixes.push(`loot table "${k}" had no rolls — defaulted to [1, 3]`); }
      for (const e of t.entries)
        if (e && resolveLootId(e.id) == null) fixes.push(`loot table "${k}" references unknown item "${e.id}"`);
    }

  p.format = STRUCT_FORMAT;
  if (fixes.length) _structReport('warn', src, 'auto-fixed on load:\n  - ' + fixes.join('\n  - '));
  return p;
}

function registerStructure(prefab, src) {
  const p = migrateStructure(prefab, src || (prefab && prefab.id) || 'structure');
  if (!p) return false;
  STRUCTURES.set(p.id, p);
  return true;
}

/* Boot load: localStorage drafts first, then structures/ files overwrite them by id. A shipped
   prefab is the source of truth; a local draft is a work in progress. */
/* The manifest is either the original bare array of file names, or an object that also declares
   GROUPS. A group is a set of prefabs that spawn together as one settlement or dungeon rather
   than independently — see the group section further down for what each type does. */
function _readManifest(raw, src) {
  if (Array.isArray(raw)) return raw;                 // v1: just a file list
  if (!raw || typeof raw !== 'object') {
    _structReport('error', src, 'must be an array of file names, or an object with a "files" array');
    return null;
  }
  if (raw.groups && typeof raw.groups === 'object')
    for (const [name, g] of Object.entries(raw.groups)) {
      if (!g || typeof g !== 'object') { _structReport('error', src, `group "${name}" is not an object`); continue; }
      if (!['village', 'dungeon'].includes(g.type)) {
        _structReport('error', src, `group "${name}" has type "${g.type}" — expected "village" or "dungeon"`);
        continue;
      }
      STRUCT_GROUPS.set(name, Object.assign({ name }, g));
    }
  if (!Array.isArray(raw.files)) { _structReport('error', src, 'object manifest needs a "files" array'); return null; }
  return raw.files;
}

async function loadStructures() {
  for (const [id, p] of Object.entries(_lsStructures())) registerStructure(p, 'localStorage:' + id);

  let raw = null;
  try {
    const res = await fetch(STRUCT_MANIFEST, { cache: 'no-store' });
    if (!res.ok) return;                              // no manifest is fine — the folder is optional
    raw = parseStructureText(await res.text(), 'manifest.json');
  } catch { return; }                                 // offline / file:// — nothing to report
  if (raw === null) return;                           // parse failed; parseStructureText already said why
  const names = _readManifest(raw, 'manifest.json');
  if (!names) return;

  for (const n of names) {
    if (typeof n !== 'string') { _structReport('error', 'manifest.json', `entry ${JSON.stringify(n)} is not a file name`); continue; }
    let text;
    try {
      const r = await fetch(STRUCT_DIR + n, { cache: 'no-store' });
      if (!r.ok) { _structReport('error', n, `not found (HTTP ${r.status}) — listed in the manifest but missing from ${STRUCT_DIR}`); continue; }
      text = await r.text();
    } catch (e) { _structReport('error', n, 'could not be fetched: ' + e.message); continue; }
    const prefab = parseStructureText(text, n);
    if (prefab) registerStructure(prefab, n);
  }
  const n = STRUCTURES.size;
  console.log(`[structure] loaded ${n} prefab${n === 1 ? '' : 's'}: ${[...STRUCTURES.keys()].join(', ') || '(none)'}`);
  // a group with no members would silently never fire, which is a confusing thing to debug
  for (const [name, g] of STRUCT_GROUPS) {
    const members = groupMembers(name);
    if (!members.length) _structReport('error', 'manifest.json', `group "${name}" has no prefabs — no file sets "group": "${name}"`);
    else console.log(`[structure] group "${name}" (${g.type}): ${members.map(p => p.id).join(', ')}`);
  }
  // the mirror case: a prefab claiming a group the manifest never declares would never spawn
  for (const p of STRUCTURES.values())
    if (p.group && !STRUCT_GROUPS.has(p.group))
      _structReport('error', p.id, `"group": "${p.group}" is not declared in manifest.json — this prefab will never spawn`);
}

/* ---------------------------------- capture ---------------------------------- */
/* The volume starts ONE CELL in front of the structure block and grows +X/+Y/+Z, so the block is
   never inside its own capture and the corner is always predictable. */
function structVolume(x, y, z, size) {
  return { x0: x + 1, y0: y, z0: z, w: size.w, h: size.h, l: size.l };
}

function captureStructure(bx, by, bz, size, name) {
  const v = structVolume(bx, by, bz, size);
  const blocks = [];
  const loot = {};
  for (let dy = 0; dy < v.h; dy++)
    for (let dz = 0; dz < v.l; dz++)
      for (let dx = 0; dx < v.w; dx++) {
        const val = getBlock(v.x0 + dx, v.y0 + dy, v.z0 + dz);
        const id = val & 255;
        if (id === B.AIR || id === B.STRUCTURE_BLOCK) continue;
        blocks.push([dx, dy, dz, id, (val >> 8) & 255]);
        // every captured container is wired to the default table; edit the JSON to retarget it
        if (id === B.CHEST) loot[dx + ',' + dy + ',' + dz] = '1';
      }
  return {
    id: name,
    size: [v.w, v.h, v.l],
    blocks,
    loot,
    lootTables: DEFAULT_LOOT,
    // sensible defaults so a freshly saved prefab already spawns; tune in the JSON.
    // mode: surface | embed | air | cave | underground — see the header for what each one does
    spawn: { mode: 'embed', biomes: ['Forest', 'Plains'], chance: 0.012, minY: 60, maxY: 150 },
  };
}

function downloadStructure(prefab) {
  const blob = new Blob([JSON.stringify(prefab, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = prefab.id + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------------------------- stamping ---------------------------------- */
/* Place a prefab with its (0,0,0) corner at the given world cell. No rotation: prefabs go down in
   the orientation they were saved, which keeps every rotatable block's variant valid as-is. */
/* Stamp a SLICE of a prefab, `from` .. `from + budget`, and return where to resume.

   Every cell is a setBlock, and setBlock is not cheap: it marks the chunk dirty, rewrites the
   edit store, re-floods light and runs the per-block hooks. A dungeon is well over a thousand
   cells and a village several hundred, so doing one in a single frame is a visible freeze. The
   caller feeds this a budget and comes back next frame. */
function stampStructureSlice(prefab, ox, oy, oz, from, budget) {
  const blocks = prefab.blocks;
  const end = Math.min(blocks.length, from + budget);
  for (let i = from; i < end; i++) {
    const b = blocks[i];
    if (!Array.isArray(b) || b.length < 4) continue;
    const [dx, dy, dz, id, variant = 0] = b;
    if (!PROPS[id]) continue;                       // prefab references a block this build lacks
    const x = ox + dx, y = oy + dy, z = oz + dz;
    if (y < 1 || y > 198) continue;
    setBlock(x, y, z, id | ((variant & 255) << 8));
    if (id === B.CHEST) registerChest(x, y, z, variant & 3);
    if (id === B.DOOR && !((variant >> 3) & 1))
      registerDoor(x, y, z, variant & 3, !!(variant & 4), !!(variant & DOOR_HINGE_R));
    if (id === B.BED && !((variant >> 3) & 1)) registerBed(x, y, z, variant & 3);
  }
  return end;
}

// loot markers are keyed by prefab-local coords; translate them into the world once, at the end
function applyStructureLoot(prefab, ox, oy, oz) {
  if (!prefab.loot) return;
  for (const k in prefab.loot) {
    const p = k.split(',').map(Number);
    if (p.length !== 3 || p.some(isNaN)) continue;
    markPendingLoot(ox + p[0], oy + p[1], oz + p[2], prefab.loot[k], prefab.id);
  }
}

// whole-prefab convenience for the small single-structure path, where one frame is fine
function stampStructure(prefab, ox, oy, oz) {
  if (!prefab || !Array.isArray(prefab.blocks)) return 0;
  stampStructureSlice(prefab, ox, oy, oz, 0, prefab.blocks.length);
  applyStructureLoot(prefab, ox, oy, oz);
  return prefab.blocks.length;
}

/* ---------------------------------- natural spawning ---------------------------------- */
/* One deterministic roll per chunk. `placedChunks` stops a structure being stamped twice when a
   chunk unloads and streams back in — the blocks themselves persist as edits, so a second stamp
   would just be wasted work, and would re-arm loot in a chest the player already emptied. */
const _structPlaced = new Set();
function structChunkKey(cx, cz) { return cx + ',' + cz; }

// cheap deterministic hash of (seed, chunk, salt) -> 0..1
function _structHash(cx, cz, salt) {
  let h = Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263) ^ Math.imul(salt, 2246822519);
  for (let i = 0; i < String(SEED).length; i++) h = Math.imul(h ^ String(SEED).charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* Prefabs that spawn on their own. A prefab belonging to a group is excluded — its placement is
   the group's business, and letting it also roll independently would scatter lone village houses
   across the countryside. */
function _spawnCandidates() {
  const out = [];
  for (const p of STRUCTURES.values())
    if (!p.group && p.spawn && (p.spawn.chance || 0) > 0) out.push(p);
  return out;
}

/* ---- placement modes ----
   spawn.mode picks how a prefab meets the world:

     "surface" (default)  Sits ON the ground and demands a flat, dry footprint. Cheapest and most
                          predictable, but a lumpy site is simply rejected.
     "embed"              Blends INTO the terrain. Anchors on the LOWEST surface in the footprint,
                          carves out whatever hillside is in the way, and pillars any column that
                          would otherwise overhang. Accepts slopes that "surface" rejects and never
                          leaves a floating platform.
     "air"                Deliberately airborne: no ground contact at all, anchored at a random
                          height inside the prefab's own minY..maxY band.
     "cave"               Drops into a cave that already exists — hunts the minY..maxY band for an
                          open pocket standing on a solid floor. Nothing is carved, so the prefab
                          has to fit a natural cavern.
     "underground"        Digs its own room. Wants SOLID rock through the whole volume plus a
                          shell around it, then hollows it out — so a buried vault never opens
                          into a cave or breaches the surface by accident.

   For surface/embed the Y band filters the terrain height; for air/cave/underground it is the
   band the prefab is placed in.

   Legacy `surface: false` still reads as "air", so prefabs written before modes existed keep
   working. */
const STRUCT_MODES = ['surface', 'embed', 'air', 'cave', 'underground'];
const STRUCT_Y_TRIES = 8;        // hashed height samples per underground/cave attempt
function structMode(s) {
  if (s.mode) return s.mode;
  return s.surface === false ? 'air' : 'surface';
}

/* Real ground, not "the first thing that isn't air".

   surfaceY stops at the highest non-air/water/lava cell, which on any grassy plain is a tall-grass
   billboard, a flower or a layer of leaf litter — never the block you want to build on. That one
   discrepancy caused two separate bugs: paths refused to pave (the cell they found was a
   non-solid plant) and buildings anchored a block too high or too low depending on cover. Walk
   down past anything that is not a real full block. */
const _isCover = (id) => {
  const p = PROPS[id];
  return !p || !p.solid || p.model === 'cross' || p.model === 'carpet';
};
function structGroundY(x, z) {
  let y = surfaceY(x, z);
  for (let i = 0; i < 10 && y > 1; i++) {
    if (!_isCover(getBlock(x, y, z) & 255)) break;
    y--;
  }
  return y;
}

/* Lowest and highest ground under a footprint, plus whether any of it is fluid. One pass, reused
   by both the acceptance test and the anchor choice. */
function _footprint(ax, az, w, l) {
  let lo = 1e9, hi = -1e9, wet = false;
  for (let dz = 0; dz < l; dz++)
    for (let dx = 0; dx < w; dx++) {
      const y = structGroundY(ax + dx, az + dz);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
      const top = getBlock(ax + dx, y, az + dz) & 255;
      if (top === B.WATER || top === B.LAVA || !PROPS[top]?.solid) wet = true;
    }
  return { lo, hi, wet };
}

/* Cut the prefab's own volume out of the hillside, then prop up anything left overhanging.
   Without the carve an embedded building is packed solid with dirt; without the pillars a slope
   that falls away leaves its lower corner hanging in mid-air. */
function _blendIntoTerrain(prefab, ox, oy, oz) {
  const [w, h, l] = prefab.size || [1, 1, 1];
  const filled = new Set();
  for (const b of prefab.blocks) if (Array.isArray(b)) filled.add(b[0] + ',' + b[1] + ',' + b[2]);
  // carve: any terrain sharing a cell with the prefab's bounding box that the prefab did not fill
  for (let dy = 0; dy < h; dy++)
    for (let dz = 0; dz < l; dz++)
      for (let dx = 0; dx < w; dx++) {
        if (filled.has(dx + ',' + dy + ',' + dz)) continue;
        const x = ox + dx, y = oy + dy, z = oz + dz;
        const cur = getBlock(x, y, z) & 255;
        if (cur !== B.AIR && cur !== B.WATER) setBlock(x, y, z, B.AIR);
      }
  // pillar: every bottom-layer cell of the prefab gets solid ground beneath it
  const PILLAR_MAX = 8;
  for (let dz = 0; dz < l; dz++)
    for (let dx = 0; dx < w; dx++) {
      if (!filled.has(dx + ',0,' + dz)) continue;
      const x = ox + dx, z = oz + dz;
      for (let d = 1; d <= PILLAR_MAX; d++) {
        const y = oy - d;
        if (y < 1) break;
        const cur = getBlock(x, y, z) & 255;
        if (cur !== B.AIR && cur !== B.WATER && PROPS[cur]?.solid) break;
        setBlock(x, y, z, d === 1 ? B.DIRT : B.STONE);
      }
    }
}

/* ================================================================================================
   GROUPS — villages and dungeons
   ================================================================================================
   A prefab with `"group": "name"` no longer spawns on its own. Instead the manifest's group entry
   rolls ONCE per chunk and lays out the whole settlement: several member prefabs positioned
   relative to a common origin, plus the connective tissue between them (gravel paths above
   ground, carved corridors below).

   THE CHUNK PROBLEM, AND WHY THERE IS A QUEUE
   -------------------------------------------
   A village is 40-60 blocks across, so it spans three or four chunks. setBlock silently discards
   writes into chunks that have not generated yet, so laying the whole thing down at roll time
   would leave the far half missing forever. The layout is therefore computed up front — it is
   pure arithmetic on a seeded hash, so it never changes — and each piece is pushed onto a queue.
   Pieces are stamped when their footprint's chunks exist, retried as more terrain streams in, and
   given up on after PLACE_MAX_TRIES so a village at the edge of the render distance cannot leak
   entries forever.

   Because the layout is deterministic, a piece placed on this visit lands in exactly the spot it
   would have on any other, no matter which chunk the player approached from. */

const PLACE_QUEUE = [];              // { kind, prefab|cells, ox, oy, oz, tries }
const PLACE_MAX_TRIES = 240;
const _groupClaimed = new Set();     // "cx,cz" chunks owned by a group — lone prefabs stay out

const groupMembers = (name) => [...STRUCTURES.values()].filter(p => p.group === name);

function _chunkLoaded(x, z) {
  const c = getChunk(Math.floor(x / 16), Math.floor(z / 16));
  return !!(c && c.data);
}
// every chunk the footprint touches must exist before a piece can be stamped
function _footprintReady(ox, oz, w, l) {
  for (let z = oz; z <= oz + l; z += 8)
    for (let x = ox; x <= ox + w; x += 8) if (!_chunkLoaded(x, z)) return false;
  return _chunkLoaded(ox + w, oz + l);
}

function queuePlacement(job) { PLACE_QUEUE.push(Object.assign({ tries: 0, step: 0, phase: 0 }, job)); }

/* Cells written per drain. A settlement is thousands of setBlocks; spreading them over frames
   turns a freeze into a building that visibly assembles itself over about a second. */
const PLACE_BUDGET = 48;

/* Drain up to PLACE_BUDGET cells of work. Called from the frame loop AND on chunk arrival, so it
   keeps pace with streaming without needing a timer of its own.

   Each job is a little state machine (`phase`, `step`) rather than an all-at-once action, so a
   half-placed building simply resumes next frame. */
function processPlacementQueue(budget = PLACE_BUDGET) {
  let left = budget;
  for (let i = 0; i < PLACE_QUEUE.length && left > 0; i++) {
    const j = PLACE_QUEUE[i];
    const w = j.w ?? 1, h = j.h ?? 1, l = j.l ?? 1;
    if (j.phase === 0 && !_footprintReady(j.ox, j.oz, w, l)) {
      if (++j.tries > PLACE_MAX_TRIES) { PLACE_QUEUE.splice(i--, 1); }
      continue;
    }
    if (j.kind === 'path') {
      const before = j.step;
      j.step = _layPath(j.cells, j.block, j.step, left);
      left -= j.step - before;
      if (j.step >= j.cells.length) PLACE_QUEUE.splice(i--, 1);
      continue;
    }
    if (j.kind === 'corridor') {
      const before = j.step;
      // one corridor cell hollows the passage AND walls its shell — roughly a dozen writes
      j.step = _digCorridor(j.cells, j.height, j.step, Math.max(1, (left / 12) | 0));
      left -= (j.step - before) * 12;
      if (j.step >= j.cells.length) PLACE_QUEUE.splice(i--, 1);
      continue;
    }
    // prefab: phase 0 = carve/blend the site, phase 1 = lay the blocks, then loot + retire
    if (j.phase === 0) {
      if (j.carve) {
        const total = w * h * l;
        const end = Math.min(total, j.step + left);
        for (let k = j.step; k < end; k++) {
          const dx = k % w, dy = ((k / w) | 0) % h, dz = (k / (w * h)) | 0;
          setBlock(j.ox + dx, j.oy + dy, j.oz + dz, B.AIR);
        }
        left -= end - j.step;
        j.step = end;
        if (j.step < total) continue;
      } else if (j.blend) {
        _blendIntoTerrain(j.prefab, j.ox, j.oy, j.oz);
        left -= w * l * 2;                             // rough charge for the carve+pillar pass
      }
      j.phase = 1; j.step = 0;
      if (left <= 0) continue;
    }
    const before = j.step;
    j.step = stampStructureSlice(j.prefab, j.ox, j.oy, j.oz, j.step, left);
    left -= j.step - before;
    if (j.step >= j.prefab.blocks.length) {
      applyStructureLoot(j.prefab, j.ox, j.oy, j.oz);
      PLACE_QUEUE.splice(i--, 1);
    }
  }
}
function clearPlacementQueue() { PLACE_QUEUE.length = 0; _groupClaimed.clear(); }

/* ---- village ---- */
/* Buildings scatter around a centre on a jittered ring, each dropped onto its own local ground
   with the embed rules so slopes are fine. Paths are drawn afterwards, from each doorstep back to
   the centre, following the surface. */
function _planVillage(g, cx, cz) {
  const members = groupMembers(g.name);
  if (!members.length) return false;
  const originX = cx * 16 + 8, originZ = cz * 16 + 8;
  const gy = structGroundY(originX, originZ);
  if (gy < (g.minY ?? 0) || gy > (g.maxY ?? 255)) return false;
  if (Array.isArray(g.biomes) && g.biomes.length && !g.biomes.includes(mainGen.biomeAt(originX, originZ))) return false;

  const [nMin, nMax] = Array.isArray(g.count) ? g.count : [4, 7];
  const n = nMin + Math.floor(_structHash(cx, cz, 301) * (nMax - nMin + 1));
  const radius = g.radius ?? 24;
  const spacing = g.spacing ?? 2;
  const pathBlock = g.path == null ? B.GRAVEL : g.path;

  const taken = [];                                   // placed footprints, for overlap rejection
  const doorSteps = [];
  for (let i = 0; i < n; i++) {
    const p = members[Math.floor(_structHash(cx, cz, 400 + i * 13) * members.length)];
    const [w, h, l] = p.size;
    // ring layout: angle spread evenly with jitter, distance jittered too, so it reads organic
    const ang = (i / n) * Math.PI * 2 + (_structHash(cx, cz, 500 + i) - 0.5) * 1.1;
    const dist = radius * (0.35 + 0.65 * _structHash(cx, cz, 600 + i));
    const bx = Math.round(originX + Math.cos(ang) * dist) - (w >> 1);
    const bz = Math.round(originZ + Math.sin(ang) * dist) - (l >> 1);
    if (taken.some(t => bx < t.x + t.w + spacing && bx + w + spacing > t.x &&
                        bz < t.z + t.l + spacing && bz + l + spacing > t.z)) continue;
    /* Anchor on the HIGHEST ground under the footprint, not a centre sample. A centre sample on
       even mildly uneven ground buries the uphill half of the house — which is exactly what was
       happening. Sitting on the high point can only ever leave a gap underneath, and the blend
       pass pillars that gap into a foundation. Steep sites are skipped rather than stilted. */
    const fp = _footprint(bx, bz, w, l);
    if (fp.wet || fp.hi - fp.lo > 4) continue;
    const by = fp.hi + 1;
    taken.push({ x: bx, z: bz, w, l });
    queuePlacement({ kind: 'prefab', prefab: p, ox: bx, oy: by, oz: bz, w, h, l, blend: true });
    doorSteps.push([bx + (w >> 1), bz + (l >> 1)]);
  }
  if (!doorSteps.length) return false;

  // paths: a rough L from each building back to the village centre, drawn on whatever the surface
  // turns out to be. Queued as cell lists so they follow the buildings across chunk borders.
  for (const [dx, dz] of doorSteps) {
    const cells = [];
    const stepX = dx < originX ? 1 : -1, stepZ = dz < originZ ? 1 : -1;
    for (let x = dx; x !== originX; x += stepX) cells.push([x, dz]);
    for (let z = dz; z !== originZ; z += stepZ) cells.push([originX, z]);
    cells.push([originX, originZ]);
    const xs = cells.map(c => c[0]), zs = cells.map(c => c[1]);
    queuePlacement({ kind: 'path', cells, block: pathBlock,
                     ox: Math.min(...xs), oz: Math.min(...zs),
                     w: Math.max(...xs) - Math.min(...xs), l: Math.max(...zs) - Math.min(...zs) });
  }
  // claim the footprint so lone prefabs do not drop a shed in the middle of the square
  const rc = Math.ceil((radius + 8) / 16);
  for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) _groupClaimed.add((cx + dx) + ',' + (cz + dz));
  return true;
}

/* Replace the surface cell of each path column, and clear the one above it so a path never runs
   under a bush. Sampling the surface per cell is what lets a path climb a hill. */
function _layPath(cells, block, from, budget) {
  const end = Math.min(cells.length, from + budget);
  for (let i = from; i < end; i++) {
    const [x, z] = cells[i];
    const y = structGroundY(x, z);                 // NOT surfaceY — that lands on the grass, not the soil
    const cur = getBlock(x, y, z) & 255;
    if (cur === B.WATER || cur === B.LAVA || !PROPS[cur]?.solid) continue;
    setBlock(x, y, z, block);
    // sweep the cover off the paved cell so a path never runs underneath a bush
    for (let up = 1; up <= 3; up++) {
      const a = getBlock(x, y + up, z) & 255;
      if (a === B.AIR) break;
      if (!_isCover(a)) break;
      setBlock(x, y + up, z, B.AIR);
    }
  }
  return end;
}

/* ---- dungeon ---- */
/* Rooms grow outward from a seed room: pick an already-placed room, step off it in a cardinal
   direction by its own size plus a gap, and carve the next one there. Corridors are dug between
   the two centres afterwards. All of it is planned in one pass so nothing depends on load order. */
function _planDungeon(g, cx, cz) {
  const members = groupMembers(g.name);
  if (!members.length) return false;
  const ox0 = cx * 16 + 8, oz0 = cz * 16 + 8;
  const surf = structGroundY(ox0, oz0);
  const lo = Math.max(3, Math.min(g.minY ?? 12, g.maxY ?? 48));
  const hi = Math.min(Math.max(g.minY ?? 12, g.maxY ?? 48), surf - 8);
  if (hi < lo) return false;
  const baseY = lo + Math.floor(_structHash(cx, cz, 701) * (hi - lo + 1));

  const [rMin, rMax] = Array.isArray(g.rooms) ? g.rooms : [4, 8];
  const nRooms = rMin + Math.floor(_structHash(cx, cz, 703) * (rMax - rMin + 1));
  const gap = g.corridor ?? 5;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  const placed = [];
  for (let i = 0; i < nRooms; i++) {
    const p = members[Math.floor(_structHash(cx, cz, 800 + i * 11) * members.length)];
    const [w, h, l] = p.size;
    let rx, ry, rz;
    if (!placed.length) { rx = ox0 - (w >> 1); ry = baseY; rz = oz0 - (l >> 1); }
    else {
      const from = placed[Math.floor(_structHash(cx, cz, 900 + i * 7) * placed.length)];
      const d = DIRS[Math.floor(_structHash(cx, cz, 1000 + i * 5) * 4)];
      rx = from.x + d[0] * (from.w + gap);
      rz = from.z + d[1] * (from.l + gap);
      ry = from.y;                                   // one level per dungeon keeps corridors flat
    }
    if (ry < 3 || ry + h > surf - 4) continue;
    if (placed.some(t => rx < t.x + t.w + 2 && rx + w + 2 > t.x && rz < t.z + t.l + 2 && rz + l + 2 > t.z)) continue;
    const room = { x: rx, y: ry, z: rz, w, h, l, prefab: p };
    placed.push(room);
    queuePlacement({ kind: 'prefab', prefab: p, ox: rx, oy: ry, oz: rz, w, h, l, carve: true });
    if (placed.length > 1) {
      const from = placed[placed.length - 2];
      const cells = _corridorCells(from.x + (from.w >> 1), from.z + (from.l >> 1),
                                   rx + (w >> 1), rz + (l >> 1), ry);
      const xs = cells.map(c => c[0]), zs = cells.map(c => c[2]);
      queuePlacement({ kind: 'corridor', cells, height: Math.min(3, h),
                       ox: Math.min(...xs), oz: Math.min(...zs),
                       w: Math.max(...xs) - Math.min(...xs), l: Math.max(...zs) - Math.min(...zs) });
    }
  }
  if (!placed.length) return false;
  const spread = g.spread ?? 24;
  const rc = Math.ceil(spread / 16);
  for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) _groupClaimed.add((cx + dx) + ',' + (cz + dz));
  return true;
}

// L-shaped run of cells between two room centres, all at one height
function _corridorCells(x0, z0, x1, z1, y) {
  const cells = [];
  const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
  for (let x = x0; x !== x1; x += sx) cells.push([x, y, z0]);
  for (let z = z0; z !== z1; z += sz) cells.push([x1, y, z]);
  cells.push([x1, y, z1]);
  return cells;
}
/* Hollow the corridor and wall whatever it opens into, so a tunnel that clips a cave or a water
   pocket does not flood the dungeon. */
function _digCorridor(cells, height, from, budget) {
  const end = Math.min(cells.length, from + Math.max(1, budget));
  for (let i = from; i < end; i++) {
    const [x, y, z] = cells[i];
    for (let dy = 0; dy < height; dy++) setBlock(x, y + dy, z, B.AIR);
    for (let dy = -1; dy <= height; dy++)
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
        if (dy >= 0 && dy < height && ax === 0 && az === 0) continue;   // that is the passage itself
        const nid = getBlock(x + ax, y + dy, z + az) & 255;
        if (nid === B.AIR || nid === B.WATER || nid === B.LAVA) setBlock(x + ax, y + dy, z + az, B.COBBLE);
      }
  }
  return end;
}

/* One roll per group per chunk. Returns true if a settlement was planned, so the caller skips its
   lone-prefab pass for this chunk. */
function _trySpawnGroups(cx, cz) {
  let salt = 2000;
  for (const g of STRUCT_GROUPS.values()) {
    if (_structHash(cx, cz, salt++) >= (g.chance || 0)) continue;
    const ok = g.type === 'village' ? _planVillage(g, cx, cz) : _planDungeon(g, cx, cz);
    if (ok) return true;
  }
  return false;
}

/* Called once per chunk, right after its terrain lands. Deliberately conservative: one structure
   per chunk at most, and the site must satisfy that prefab's placement mode. */
function trySpawnStructureInChunk(cx, cz) {
  if (!STRUCTURES.size || menuScene || !currentWorld) return;
  // a new chunk may unblock a piece that was waiting on it; the frame loop does the bulk of the
  // draining, so keep this slice small — chunk arrival is already a busy moment
  processPlacementQueue(16);
  const ck = structChunkKey(cx, cz);
  if (_structPlaced.has(ck)) return;
  _structPlaced.add(ck);            // one attempt per chunk either way — never retried on reload

  if (_trySpawnGroups(cx, cz)) return;          // a settlement claimed this chunk
  if (_groupClaimed.has(ck)) return;            // ...or a neighbouring one already did
  const cands = _spawnCandidates();
  if (!cands.length) return;

  let salt = 1;
  for (const p of cands) {
    const s = p.spawn;
    if (_structHash(cx, cz, salt++) >= (s.chance || 0)) continue;
    const [w, h, l] = p.size || [1, 1, 1];
    /* The prefab is stamped the moment this chunk's terrain lands, and setBlock silently drops
       writes into chunks that have not generated yet. Anchoring inside the chunk keeps the whole
       footprint local; anything too wide to fit is skipped rather than half-placed. */
    if (w > 14 || l > 14) continue;
    const ax = cx * 16 + 1 + Math.floor(_structHash(cx, cz, 91) * Math.max(1, 15 - w));
    const az = cz * 16 + 1 + Math.floor(_structHash(cx, cz, 97) * Math.max(1, 15 - l));
    if (Array.isArray(s.biomes) && s.biomes.length) {
      const bio = mainGen.biomeAt(ax, az);
      if (!s.biomes.includes(bio)) continue;
    }
    const minY = s.minY ?? 0, maxY = s.maxY ?? 255;
    const mode = structMode(s);

    if (mode === 'cave' || mode === 'underground') {
      /* Both live entirely inside the Y band — the surface height is irrelevant except as a
         ceiling, so a "cave" prefab never pops out of a hillside. */
      const surf = structGroundY(ax, az);
      const lo = Math.max(2, Math.min(minY, maxY));
      const hi = Math.min(Math.max(minY, maxY), surf - h - 3);
      if (hi < lo) continue;
      let done = false;
      for (const ay of _candidateYs(cx, cz, lo, hi, 211)) {
        if (ay < lo || ay > hi) continue;
        if (mode === 'cave') {
          // take an existing cavern: the room must already be open and standing on rock
          if (!_volumeClear(ax, ay, az, w, h, l)) continue;
          if (!_floorSolid(ax, ay, az, w, l)) continue;
        } else {
          // dig a new one: solid all the way through plus a 1-block shell, then hollow it out
          if (!_volumeSolid(ax, ay, az, w, h, l, 1)) continue;
        }
        // queued like every other piece so the carve + stamp is spread across frames
        queuePlacement({ kind: 'prefab', prefab: p, ox: ax, oy: ay, oz: az, w, h, l,
                         carve: mode === 'underground' });
        done = true;
        break;
      }
      if (done) return;
      continue;                      // no pocket found at any sampled height — try the next prefab
    }

    if (mode === 'air') {
      /* Free-floating: the height band IS the placement, not a filter on the ground. Only the
         volume itself has to be clear, so an island never materialises inside a mountain. */
      const lo = Math.max(2, Math.min(minY, maxY)), hi = Math.min(197 - h, Math.max(minY, maxY));
      if (hi < lo) continue;
      const ay = lo + Math.floor(_structHash(cx, cz, 131) * (hi - lo + 1));
      if (!_volumeClear(ax, ay, az, w, h, l)) continue;
      queuePlacement({ kind: 'prefab', prefab: p, ox: ax, oy: ay, oz: az, w, h, l });
      return;
    }

    const fp = _footprint(ax, az, w, l);
    if (fp.lo < minY || fp.lo > maxY) continue;
    if (fp.wet) continue;                                   // never build over water or lava

    if (mode === 'embed') {
      // sit on the LOWEST ground so no column can overhang, then carve the hill out of the walls
      if (fp.hi - fp.lo > 10) continue;                     // a cliff, not a slope
      queuePlacement({ kind: 'prefab', prefab: p, ox: ax, oy: fp.lo + 1, oz: az, w, h, l, blend: true });
      return;
    }

    // "surface": untouched behaviour — demands a flat site rather than reshaping one
    if (fp.hi - fp.lo > 1) continue;
    queuePlacement({ kind: 'prefab', prefab: p, ox: ax, oy: fp.lo + 1, oz: az, w, h, l });
    return;                          // at most one structure per chunk
  }
}

/* Nothing solid anywhere in the box. Used by air placement, where there is no ground to test. */
function _volumeClear(ax, ay, az, w, h, l) {
  for (let dy = 0; dy < h; dy++)
    for (let dz = 0; dz < l; dz++)
      for (let dx = 0; dx < w; dx++) {
        const id = getBlock(ax + dx, ay + dy, az + dz) & 255;
        if (id !== B.AIR && id !== B.WATER) return false;
      }
  return true;
}

/* Solid rock everywhere in the box, with a margin so an "underground" room cannot end up sharing
   a wall with a cave, a lava tube or open air. Bedrock is rejected too — digging into it would
   punch a hole in the world floor. */
function _volumeSolid(ax, ay, az, w, h, l, margin) {
  for (let dy = -margin; dy < h + margin; dy++)
    for (let dz = -margin; dz < l + margin; dz++)
      for (let dx = -margin; dx < w + margin; dx++) {
        const y = ay + dy;
        if (y < 2 || y > 198) return false;
        const id = getBlock(ax + dx, y, az + dz) & 255;
        if (id === B.BEDROCK) return false;
        if (!PROPS[id]?.opaque) return false;              // air, water, lava, cave — all disqualify
      }
  return true;
}

/* Every cell under the prefab's base layer is solid, so a cave placement rests on the floor
   rather than hanging over the void. */
function _floorSolid(ax, ay, az, w, l) {
  for (let dz = 0; dz < l; dz++)
    for (let dx = 0; dx < w; dx++) {
      const id = getBlock(ax + dx, ay - 1, az + dz) & 255;
      if (!PROPS[id]?.solid) return false;
    }
  return true;
}

/* Deterministic ordering of candidate heights inside the band. Scanning the whole band per chunk
   would cost thousands of getBlock calls; a handful of hashed samples finds a pocket often enough
   and costs a fixed amount whatever the band's size. */
function _candidateYs(cx, cz, lo, hi, salt) {
  const out = [];
  const span = Math.max(1, hi - lo + 1);
  for (let i = 0; i < STRUCT_Y_TRIES; i++)
    out.push(lo + Math.floor(_structHash(cx, cz, salt + i * 17) * span));
  return out;
}

function clearStructureState() {
  clearPlacementQueue();
  _structPlaced.clear();
  PENDING_LOOT.clear();
}
function serializeStructPlaced() { return [..._structPlaced]; }
function restoreStructPlaced(list) {
  _structPlaced.clear();
  if (Array.isArray(list)) for (const k of list) if (typeof k === 'string') _structPlaced.add(k);
}

/* ---------------------------------- outline ---------------------------------- */
/* A single reusable wireframe box. Only the structure block the player last opened shows one, so
   one mesh is enough and there is nothing to pool. */
let _outline = null;
let _outlineFor = null;             // "x,y,z" of the structure block that owns it
function _ensureOutline() {
  if (_outline) return _outline;
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const mat = new THREE.LineBasicMaterial({ color: 0x53d7ff, transparent: true, opacity: 0.9, depthTest: false });
  _outline = new THREE.LineSegments(geo, mat);
  _outline.renderOrder = 4;
  _outline.layers.set(1);           // never casts a shadow
  _outline.visible = false;
  scene.add(_outline);
  return _outline;
}
function showStructOutline(bx, by, bz, size) {
  const o = _ensureOutline();
  const v = structVolume(bx, by, bz, size);
  o.scale.set(Math.max(1, v.w), Math.max(1, v.h), Math.max(1, v.l));
  o.position.set(v.x0 + v.w / 2, v.y0 + v.h / 2, v.z0 + v.l / 2);
  o.visible = true;
  _outlineFor = bx + ',' + by + ',' + bz;
}
function hideStructOutline() {
  if (_outline) _outline.visible = false;
  _outlineFor = null;
}
/* Per-frame: drop the outline as soon as its block is gone, so breaking a structure block never
   leaves a ghost box floating in the world. */
function updateStructOutline() {
  if (!_outlineFor || !_outline || !_outline.visible) return;
  const p = _outlineFor.split(',').map(Number);
  if ((getBlock(p[0], p[1], p[2]) & 255) !== B.STRUCTURE_BLOCK) hideStructOutline();
}

/* ---------------------------------- per-block settings + UI ---------------------------------- */
/* Size/name live per structure-block cell, keyed by position, and ride along in the world save so
   a half-built capture survives a reload. */
const STRUCT_BLOCKS = new Map();    // "x,y,z" -> { w, h, l, name }
const structDefaults = () => ({ w: 5, h: 4, l: 5, name: 'structure' });
function structSettings(x, y, z) {
  const k = lootKey(x, y, z);
  let s = STRUCT_BLOCKS.get(k);
  if (!s) { s = structDefaults(); STRUCT_BLOCKS.set(k, s); }
  return s;
}
function serializeStructBlocks() {
  return [...STRUCT_BLOCKS].map(([k, s]) => [k, s.w, s.h, s.l, s.name]);
}
function restoreStructBlocks(list) {
  STRUCT_BLOCKS.clear();
  if (!Array.isArray(list)) return;
  for (const r of list)
    if (Array.isArray(r) && typeof r[0] === 'string')
      STRUCT_BLOCKS.set(r[0], { w: r[1] | 0 || 5, h: r[2] | 0 || 4, l: r[3] | 0 || 5, name: r[4] || 'structure' });
}
function structBlockBroken(x, y, z) {
  STRUCT_BLOCKS.delete(lootKey(x, y, z));
  if (_outlineFor === lootKey(x, y, z)) hideStructOutline();
}

let activeStructBlock = null;       // "x,y,z" of the block whose panel is open

function openStructureBlock(x, y, z) {
  activeStructBlock = lootKey(x, y, z);
  const s = structSettings(x, y, z);
  showStructOutline(x, y, z, s);
  toggleInventory(true);
}

const _clampSpan = (v, d) => Math.max(1, Math.min(STRUCT_MAX_SPAN, parseInt(v, 10) || d));

function buildStructPanel() {
  const panel = document.getElementById('structPanel');
  if (!panel) return;
  if (!activeStructBlock) { panel.style.display = 'none'; return; }
  const p = activeStructBlock.split(',').map(Number);
  if ((getBlock(p[0], p[1], p[2]) & 255) !== B.STRUCTURE_BLOCK) {
    activeStructBlock = null; panel.style.display = 'none'; return;
  }
  const s = structSettings(p[0], p[1], p[2]);
  panel.style.display = 'flex';
  panel.innerHTML =
    '<div class="ctitle">Structure Block</div>' +
    `<label>name<input id="stName" maxlength="24" spellcheck="false" value="${s.name}"></label>` +
    `<label>width  X<input id="stW" type="number" min="1" max="${STRUCT_MAX_SPAN}" value="${s.w}"></label>` +
    `<label>height Y<input id="stH" type="number" min="1" max="${STRUCT_MAX_SPAN}" value="${s.h}"></label>` +
    `<label>length Z<input id="stL" type="number" min="1" max="${STRUCT_MAX_SPAN}" value="${s.l}"></label>` +
    '<div class="strow"><button id="stSave">Save</button><button id="stDl" class="grey">JSON</button></div>' +
    '<div id="stMsg"></div>';

  const nameEl = panel.querySelector('#stName');
  const wEl = panel.querySelector('#stW'), hEl = panel.querySelector('#stH'), lEl = panel.querySelector('#stL');
  const msg = panel.querySelector('#stMsg');
  // live outline: every keystroke on a size field re-draws the box so you can see what you'll get
  const sync = () => {
    s.w = _clampSpan(wEl.value, 5); s.h = _clampSpan(hEl.value, 4); s.l = _clampSpan(lEl.value, 5);
    s.name = (nameEl.value || 'structure').trim().replace(/[^a-z0-9_-]/gi, '_') || 'structure';
    showStructOutline(p[0], p[1], p[2], s);
  };
  for (const el of [wEl, hEl, lEl, nameEl]) el.addEventListener('input', sync);

  const doSave = () => {
    sync();
    const prefab = captureStructure(p[0], p[1], p[2], s, s.name);
    registerStructure(prefab);
    _saveLsStructure(prefab);
    msg.textContent = `saved "${prefab.id}" — ${prefab.blocks.length} blocks`;
    return prefab;
  };
  panel.querySelector('#stSave').addEventListener('click', doSave);
  panel.querySelector('#stDl').addEventListener('click', () => downloadStructure(doSave()));
}

loadStructures();
