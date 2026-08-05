'use strict';
/* voxiCraft — tree felling: strip, chop, collapse.

   HOW A TREE COMES DOWN
   ---------------------
   1. Axe on a live log  -> the log is STRIPPED in place and drops 1-2 bark. The block stays,
                            so nothing moves yet and the tree is still standing.
   2. Axe on a stripped  -> that cell is CUT. Everything still attached to it and no longer
      log                  connected to the ground comes down in one go.

   A big tree therefore takes more hits than a sapling-grown one purely because it has more
   trunk cells to strip — no size counter needed anywhere.

   WHAT "STILL ATTACHED" MEANS
   ---------------------------
   From the cut cell we flood through connected log cells (26-neighbourhood, so diagonal branch
   joins count) and collect them. Only cells at or ABOVE the cut are taken: chopping halfway up
   fells the crown and leaves the stump standing, which is what the axe-through-the-trunk
   animation implies. The flood is bounded by FELL_MAX_LOGS so a player-built log structure can
   never lock the game up.

   Leaves are handled separately: every leaf within LEAF_REACH of a felled log is turned into a
   falling leaf, which lands as leaf litter. That is what removes floating canopies — the leaves
   don't decay later, they come down with the trunk.

   DROPS
   -----
   Felling a whole tree yields mostly normal logs plus the stripped ones you actually cut. Every
   log in the flood drops exactly once, from the collapse — the individual cells are removed with
   a silent setBlock so the normal mining drop never fires for them. */

const FELL_MAX_LOGS = 512;          // safety bound on the flood (a real tree is well under 100)
const LEAF_REACH = 4;               // leaves this close to a felled log come down with it
const BARK_MIN = 1, BARK_MAX = 2;

// live log -> its stripped form. Anything not in here can't be stripped.
const STRIPPED_OF = {};
STRIPPED_OF[B.LOG] = B.STRIPPED_LOG;
STRIPPED_OF[B.BIRCH_LOG] = B.STRIPPED_BIRCH_LOG;
// stripped -> the live log it came from, so a felled tree can drop the normal variant
const UNSTRIPPED_OF = {};
UNSTRIPPED_OF[B.STRIPPED_LOG] = B.LOG;
UNSTRIPPED_OF[B.STRIPPED_BIRCH_LOG] = B.BIRCH_LOG;
// leaves -> the litter they settle into
const LITTER_OF = {};
LITTER_OF[B.LEAVES] = B.LEAF_CARPET;
LITTER_OF[B.BIRCH_LEAVES] = B.BIRCH_LEAF_CARPET;

const isLiveLog     = (id) => STRIPPED_OF[id] !== undefined;
const isStrippedLog = (id) => UNSTRIPPED_OF[id] !== undefined;
const isAnyLog      = (id) => isLiveLog(id) || isStrippedLog(id);
const isLeaf        = (id) => LITTER_OF[id] !== undefined;

// holding an axe? felling is an axe mechanic — bare hands still mine a log the plain way
function _holdingAxe() {
  const held = slotId(HOTBAR[hotbarSel]);
  return held != null && held >= 256 && ITEM_PROPS[held]?.tool === 'hatchet';
}

/* ---------------------------------- falling leaves ---------------------------------- */
/* Sand/gravel-style physics, but only ever spawned by a collapse. Each one renders as the leaf
   block it came from, falls under gravity, and converts to litter on landing. Landing on a cell
   that cannot hold litter (another leaf, water, a slope) just drops the item instead of leaving
   a block floating in mid-air. */
const FALLING = [];
const FALL_GRAVITY = 26, FALL_MAX_SPEED = 22;

function spawnFallingLeaf(id, x, y, z) {
  const passes = buildDropGeom(id);
  if (!passes.length) return;
  const group = new THREE.Group();
  for (const { p, geo, mat: mo, node } of passes)
    group.add(node || new THREE.Mesh(geo, mo || MATERIALS[p]));
  group.position.set(x + 0.5, y + 0.5, z + 0.5);
  scene.add(group);
  FALLING.push({ group, id, x, z, y: y + 0.5, vy: -1 - Math.random() * 2 });
}

/* Cells a falling block passes straight through. Billboards are included so a torch or a flower
   never stops a falling leaf in mid-air — it gets crushed on the way, the same rule sand and
   gravel use in 22-main-loop.js. */
const fallPassable = (id) =>
  id === B.AIR || id === B.WATER || PROPS[id]?.model === 'cross';

/* Crush whatever billboard is in the cell, dropping it so nothing is silently destroyed. */
function crushBillboard(x, y, z) {
  const id = getBlock(x, y, z) & 255;
  if (id === B.AIR || PROPS[id]?.model !== 'cross') return;
  setBlock(x, y, z, B.AIR);
  if (!player.canFly)
    for (const d of blockDrop(id)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, y, z);
}

const isLitter = (id) => id === B.LEAF_CARPET || id === B.BIRCH_LEAF_CARPET;
const LITTER_MAX_V = 5;             // variant 0..5 = 1..6 layers, same scale as snow carpet

/* Deepen the pile already in a cell. Returns false if that cell isn't this litter, or is full. */
function _deepenLitter(x, y, z, litter) {
  const val = getBlock(x, y, z);
  if ((val & 255) !== litter) return false;
  const v = (val >> 8) & 255;
  if (v >= LITTER_MAX_V) return false;
  setBlock(x, y, z, litter | ((v + 1) << 8));
  return true;
}

/* Lay a fresh 1-layer carpet in an empty cell. Litter is NOT solid, so a pile that has reached
   full depth still has to count as support for the cell above it — the plain solid test would
   reject it and the leaf would fall through its own drift. */
function _layLitter(x, y, z, litter) {
  const here = getBlock(x, y, z) & 255;
  if (here !== B.AIR && PROPS[here]?.model !== 'cross') return false;
  const below = getBlock(x, y - 1, z) & 255;
  if (!PROPS[below]?.solid && !isLitter(below)) return false;
  crushBillboard(x, y, z);
  setBlock(x, y, z, litter);
  return true;
}

/* One leaf settling. Order matters: a leaf comes to rest ON TOP of existing litter (litter is a
   carpet, not a passable cell), so the pile it should be joining is the one BELOW it. Checking
   the landing cell first was the bug — every leaf laid a fresh 1-layer carpet one cell up
   instead of deepening the drift it landed on. */
function _addLitter(x, y, z, litter) {
  return _deepenLitter(x, y - 1, z, litter)
      || _deepenLitter(x, y, z, litter)
      || _layLitter(x, y, z, litter);
}

function updateFallingLeaves(dt) {
  for (let i = FALLING.length - 1; i >= 0; i--) {
    const f = FALLING[i];
    f.vy = Math.max(-FALL_MAX_SPEED, f.vy - FALL_GRAVITY * dt);
    f.y += f.vy * dt;
    const cellY = Math.floor(f.y);
    // landed when the cell below stops being passable, or we fell out of the world
    const landed = cellY < 1 || !fallPassable(getBlock(f.x, cellY - 1, f.z) & 255);
    if (!landed) { f.group.position.y = f.y; continue; }
    scene.remove(f.group);
    FALLING.splice(i, 1);
    const restY = Math.max(0, cellY);
    const litter = LITTER_OF[f.id] || B.LEAF_CARPET;
    // try this cell, then the one above it — a full pile below pushes the next layer up
    if (_addLitter(f.x, restY, f.z, litter)) continue;
    if (_addLitter(f.x, restY + 1, f.z, litter)) continue;
    if (!player.canFly)
      for (const d of blockDrop(f.id, true))
        for (let n = 0; n < d.count; n++) spawnDrop(d.id, f.x, restY, f.z);
  }
}
function clearFallingLeaves() {
  for (const f of FALLING) scene.remove(f.group);
  FALLING.length = 0;
}

/* ---------------------------------- strip + fell ---------------------------------- */
/* Called from the mining code the instant a log finishes breaking, BEFORE the block is cleared.
   Returns true when this module handled the hit, meaning the caller must not remove the block or
   spawn its normal drops. */
/* How many axe swings it takes to cut THROUGH one trunk cell, from the size of the tree it
   belongs to. A sapling-sized tree goes down in ~6 swings including the strip; a mature one
   takes ~9. Recounted per swing rather than stored, because the flood is cheap (<100 cells) and
   there is nowhere to persist per-tree state across a save. */
const CUT_MIN = 5, CUT_MAX = 8;
function cutStagesFor(logCount) {
  return Math.max(CUT_MIN, Math.min(CUT_MAX, Math.ceil(logCount / 2)));
}
function countTreeLogs(x, y, z) {
  let n = 0;
  const seen = new Set([x + ',' + y + ',' + z]);
  const stack = [[x, y, z]];
  while (stack.length && n < FELL_MAX_LOGS) {
    const [cx, cy, cz] = stack.pop();
    if (!isAnyLog(getBlock(cx, cy, cz) & 255)) continue;
    n++;
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue;
          const k = (cx + dx) + ',' + (cy + dy) + ',' + (cz + dz);
          if (seen.has(k)) continue;
          seen.add(k);
          if (isAnyLog(getBlock(cx + dx, cy + dy, cz + dz) & 255)) stack.push([cx + dx, cy + dy, cz + dz]);
        }
  }
  return n;
}

function tryChopLog(x, y, z) {
  const val = getBlock(x, y, z), id = val & 255;
  if (!isAnyLog(id) || !_holdingAxe()) return false;

  // first swing: take the bark off. The log stays standing at full thickness.
  if (isLiveLog(id)) {
    setBlock(x, y, z, STRIPPED_OF[id] | ((val >> 8) & 3) << 8);   // keep the axis, clear cut bits
    playBlockSound(id, 'break', x, y, z);
    if (!player.canFly) {
      const n = BARK_MIN + Math.floor(Math.random() * (BARK_MAX - BARK_MIN + 1));
      for (let i = 0; i < n; i++) spawnDrop(ITEM.BARK, x, y, z);
    }
    return true;
  }

  /* Every swing after that bites deeper into the same cell. variant: bits 0-1 axis,
     bits 2-3 the visible notch size (0..3), bits 4-6 the stage counter. The notch is a separate
     field because the mesher sees only the variant and cannot know how many stages this tree
     needs — size is recomputed here and baked in. */
  const axis = (val >> 8) & 3;
  const stage = (val >> 12) & 7;
  const total = cutStagesFor(countTreeLogs(x, y, z));
  const next = stage + 1;
  if (next >= total) { fellTreeFrom(x, y, z); return true; }
  const size = Math.min(3, Math.floor(next * 4 / total));
  setBlock(x, y, z, id | ((axis | (size << 2) | (next << 4)) << 8));
  playBlockSound(id, 'hit', x, y, z);
  return true;
}

/* Collect every log connected to (x,y,z) at or above the cut, drop them together, and bring the
   surrounding leaves down as falling litter. */
function fellTreeFrom(x, y, z) {
  const logs = [];
  const seen = new Set();
  const stack = [[x, y, z]];
  seen.add(x + ',' + y + ',' + z);
  while (stack.length && logs.length < FELL_MAX_LOGS) {
    const [cx, cy, cz] = stack.pop();
    const id = getBlock(cx, cy, cz) & 255;
    if (!isAnyLog(id)) continue;
    logs.push({ x: cx, y: cy, z: cz, id });
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue;
          const nx = cx + dx, ny = cy + dy, nz = cz + dz;
          if (ny < y) continue;                     // never eat downward past the cut
          const k = nx + ',' + ny + ',' + nz;
          if (seen.has(k)) continue;
          seen.add(k);
          if (isAnyLog(getBlock(nx, ny, nz) & 255)) stack.push([nx, ny, nz]);
        }
  }
  if (!logs.length) return;

  // leaves first: read them while the logs are still in place, so LEAF_REACH measures from wood
  const leafCells = new Map();
  for (const l of logs)
    for (let dy = -LEAF_REACH; dy <= LEAF_REACH; dy++)
      for (let dz = -LEAF_REACH; dz <= LEAF_REACH; dz++)
        for (let dx = -LEAF_REACH; dx <= LEAF_REACH; dx++) {
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > LEAF_REACH) continue;
          const nx = l.x + dx, ny = l.y + dy, nz = l.z + dz;
          const k = nx + ',' + ny + ',' + nz;
          if (leafCells.has(k)) continue;
          const nid = getBlock(nx, ny, nz) & 255;
          if (isLeaf(nid)) leafCells.set(k, { x: nx, y: ny, z: nz, id: nid });
        }

  /* Queue the collapse instead of doing it now. A mature oak is ~40 logs and several hundred
     leaves; clearing all of them in one frame means that many setBlock calls, each dirtying a
     chunk and re-flooding light, which showed up as a hard hitch. Spreading it over FELL_STEPS
     ticks also reads better — the tree comes apart from the top down instead of vanishing. */
  logs.sort((a, b) => b.y - a.y);                       // topmost first
  const leaves = [...leafCells.values()].sort((a, b) => b.y - a.y);
  FELL_JOBS.push({
    logs, leaves, li: 0, ci: 0,
    logStep: Math.ceil(logs.length / FELL_STEPS),
    leafStep: Math.ceil(leaves.length / FELL_STEPS),
    kind: logs[0].id, normal: 0, stripped: 0,
    dropX: x, dropY: y, dropZ: z,
    survival: !player.canFly,
  });
  playBlockSound(B.LOG, 'break', x, y, z);
  if (typeof camShake === 'object' && logs.length > 6) {
    camShake.t = camShake.dur = 0.25;
    camShake.amp = Math.min(0.05, 0.012 * Math.sqrt(logs.length));
  }
}

/* ---------------------------------- collapse, one step at a time ---------------------------- */
const FELL_JOBS = [];
const FELL_STEPS = 5;               // how many ticks a whole tree takes to come apart
const FELL_TICK = 0.06;             // seconds per step
let _fellTimer = 0;

function updateFelling(dt) {
  if (!FELL_JOBS.length) return;
  _fellTimer += dt;
  if (_fellTimer < FELL_TICK) return;
  _fellTimer = 0;
  for (let j = FELL_JOBS.length - 1; j >= 0; j--) {
    const job = FELL_JOBS[j];
    const logEnd = Math.min(job.logs.length, job.li + job.logStep);
    for (; job.li < logEnd; job.li++) {
      const l = job.logs[job.li];
      if ((getBlock(l.x, l.y, l.z) & 255) !== l.id) continue;   // something else claimed it
      if (isStrippedLog(l.id)) job.stripped++; else job.normal++;
      setBlock(l.x, l.y, l.z, B.AIR);
    }
    const leafEnd = Math.min(job.leaves.length, job.ci + job.leafStep);
    for (; job.ci < leafEnd; job.ci++) {
      const c = job.leaves[job.ci];
      if ((getBlock(c.x, c.y, c.z) & 255) !== c.id) continue;
      setBlock(c.x, c.y, c.z, B.AIR);
      spawnFallingLeaf(c.id, c.x, c.y, c.z);
    }
    if (job.li < job.logs.length || job.ci < job.leaves.length) continue;
    // finished: pay out the whole trunk at the stump, mostly normal wood plus what you stripped
    if (job.survival) {
      const liveId = UNSTRIPPED_OF[job.kind] || job.kind;
      const stripId = STRIPPED_OF[job.kind] || job.kind;
      for (let i = 0; i < job.normal; i++)   spawnDrop(liveId,  job.dropX, job.dropY, job.dropZ);
      for (let i = 0; i < job.stripped; i++) spawnDrop(stripId, job.dropX, job.dropY, job.dropZ);
    }
    FELL_JOBS.splice(j, 1);
  }
}
function clearFelling() { FELL_JOBS.length = 0; }
