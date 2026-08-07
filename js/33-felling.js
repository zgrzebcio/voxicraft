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
const FELL_MAX_LEAVES = 900;        // ditto for the canopy flood
const LEAF_REACH = 5;               // leaf-to-leaf hops a canopy may span out from its wood
const LEAF_DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const BARK_MIN = 1, BARK_MAX = 2;
/* Falling leaves are one THREE.Group each, so a big canopy would add several hundred objects to
   the scene in one go — the other half of the felling hitch. Past this many in flight the rest
   settle straight to the ground with no visual, which nobody notices inside a collapsing tree. */
const MAX_FALLING = 70;

// live log -> its stripped form. Anything not in here can't be stripped.
const STRIPPED_OF = {};
STRIPPED_OF[B.LOG] = B.STRIPPED_LOG;
STRIPPED_OF[B.BIRCH_LOG] = B.STRIPPED_BIRCH_LOG;
STRIPPED_OF[B.SPRUCE_LOG] = B.STRIPPED_SPRUCE_LOG;
// stripped -> the live log it came from, so a felled tree can drop the normal variant
const UNSTRIPPED_OF = {};
UNSTRIPPED_OF[B.STRIPPED_LOG] = B.LOG;
UNSTRIPPED_OF[B.STRIPPED_BIRCH_LOG] = B.BIRCH_LOG;
UNSTRIPPED_OF[B.STRIPPED_SPRUCE_LOG] = B.SPRUCE_LOG;
// leaves -> the litter they settle into
const LITTER_OF = {};
LITTER_OF[B.LEAVES] = B.LEAF_CARPET;
LITTER_OF[B.BIRCH_LEAVES] = B.BIRCH_LEAF_CARPET;
LITTER_OF[B.SPRUCE_LEAVES] = B.SPRUCE_LEAF_CARPET;

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
const FALL_GRAVITY = 55, FALL_MAX_SPEED = 34;   // leaves come down quickly, not drifting

function spawnFallingLeaf(id, x, y, z) {
  const passes = buildDropGeom(id);
  if (!passes.length) return;
  const group = new THREE.Group();
  for (const { p, geo, mat: mo, node } of passes)
    group.add(node || new THREE.Mesh(geo, mo || MATERIALS[p]));
  group.position.set(x + 0.5, y + 0.5, z + 0.5);
  scene.add(group);
  FALLING.push({ group, id, x, z, y: y + 0.5, vy: -3 - Math.random() * 3 });
}

/* ---- litter rots ----
   Fallen leaves are not permanent scenery: each carpet is queued when it lands and rots away
   after a while. Deliberately NOT gated on nearby logs the way canopy decay is — litter lying at
   the foot of a living tree should still rot, otherwise every forest floor silts up forever. */
const litterRot = new Map();        // "x,y,z" -> seconds remaining
const LITTER_LIFE = 40, LITTER_LIFE_JITTER = 40;
const LITTER_ROT_TICK = 1.0;
let _litterTimer = 0;

function queueLitterRot(x, y, z) {
  litterRot.set(x + ',' + y + ',' + z, LITTER_LIFE + Math.random() * LITTER_LIFE_JITTER);
}
function updateLitterRot(dt) {
  _litterTimer += dt;
  if (_litterTimer < LITTER_ROT_TICK) return;
  const step = _litterTimer * (typeof tickFactor === 'function' ? tickFactor() : 1);
  _litterTimer = 0;
  for (const [k, t] of litterRot) {
    const left = t - step;
    const [x, y, z] = k.split(',').map(Number);
    const val = getBlock(x, y, z);
    if (!isLitter(val & 255)) { litterRot.delete(k); continue; }   // mined or replaced
    if (left > 0) { litterRot.set(k, left); continue; }
    // thin the pile one layer at a time so a deep drift fades instead of blinking out
    const v = (val >> 8) & 255;
    if (v > 0) {
      setBlock(x, y, z, (val & 255) | ((v - 1) << 8));
      litterRot.set(k, LITTER_LIFE * 0.4 + Math.random() * LITTER_LIFE_JITTER * 0.4);
    } else {
      setBlock(x, y, z, B.AIR);
      litterRot.delete(k);
    }
  }
}
function clearLitterRot() { litterRot.clear(); }

/* Cells a falling block passes straight through. Billboards are included so a torch or a flower
   never stops a falling leaf in mid-air — it gets crushed on the way, the same rule sand and
   gravel use in 22-main-loop.js. */
const fallPassable = (id) =>
  id === B.AIR || id === B.WATER || isLeaf(id) || PROPS[id]?.model === 'cross';

/* Crush whatever billboard is in the cell, dropping it so nothing is silently destroyed. */
function crushBillboard(x, y, z) {
  const id = getBlock(x, y, z) & 255;
  if (id === B.AIR || PROPS[id]?.model !== 'cross') return;
  setBlock(x, y, z, B.AIR);
  if (!player.canFly)
    for (const d of blockDrop(id)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, y, z);
}

const isLitter = (id) => id === B.LEAF_CARPET || id === B.BIRCH_LEAF_CARPET || id === B.SPRUCE_LEAF_CARPET;
const LITTER_MAX_V = 5;             // variant 0..5 = 1..6 layers, same scale as snow carpet

/* Deepen the pile already in a cell. Returns false if that cell isn't this litter, or is full. */
function _deepenLitter(x, y, z, litter) {
  const val = getBlock(x, y, z);
  if ((val & 255) !== litter) return false;
  const v = (val >> 8) & 255;
  if (v >= LITTER_MAX_V) return false;
  setBlock(x, y, z, litter | ((v + 1) << 8));
  queueLitterRot(x, y, z);
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
  queueLitterRot(x, y, z);
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

/* Same outcome as falling, minus the animation and the scene object: walk straight down to the
   first surface and settle there. Used once the in-flight budget is spent. */
const SETTLE_MAX_DROP = 24;
function settleLeafNow(id, x, y, z) {
  const litter = LITTER_OF[id] || B.LEAF_CARPET;
  let ry = y;
  for (let d = 0; d < SETTLE_MAX_DROP && ry > 1; d++) {
    if (!fallPassable(getBlock(x, ry - 1, z) & 255)) break;
    ry--;
  }
  if (_addLitter(x, ry, z, litter)) return;
  if (_addLitter(x, ry + 1, z, litter)) return;
  if (!player.canFly)
    for (const d of blockDrop(id, true))
      for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, ry, z);
}

/* ---------------------------------- strip + fell ---------------------------------- */
/* Called from the mining code the instant a log finishes breaking, BEFORE the block is cleared.
   Returns true when this module handled the hit, meaning the caller must not remove the block or
   spawn its normal drops. */
/* Cutting is just the width field running down. Each swing takes CUT_STEP off the log's width
   index, so the number of swings falls straight out of how thick the cell is — a slim branch
   parts in two or three, a normal trunk in six, a flared oak stump in nine or ten. No stage
   counter, no per-tree bookkeeping, and the notch you see IS the remaining wood. */
const CUT_STEP = 4;                 // width indices removed per swing (8 texture units)

function tryChopLog(x, y, z) {
  const val = getBlock(x, y, z), id = val & 255;
  if (!isAnyLog(id) || !_holdingAxe()) return false;
  const variant = (val >> 8) & 255;

  // first swing: take the bark off. Same width — nothing has been cut away yet.
  if (isLiveLog(id)) {
    setBlock(x, y, z, STRIPPED_OF[id] | (variant << 8));
    playBlockSound(id, 'break', x, y, z);
    if (!player.canFly) {
      const n = BARK_MIN + Math.floor(Math.random() * (BARK_MAX - BARK_MIN + 1));
      for (let i = 0; i < n; i++) spawnDrop(ITEM.BARK, x, y, z);
    }
    return true;
  }

  // every swing after that bites CUT_STEP off the remaining width
  const w = logWidthOf(variant);
  const next = w - CUT_STEP;
  if (next < LOG_W_MIN) { fellTreeFrom(x, y, z); return true; }
  setBlock(x, y, z, id | (((variant & 3) | (next << 2)) << 8));
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

  /* Canopy, gathered while the logs are still standing so reach is measured from wood.

     This is a BFS THROUGH connected leaves rather than a box scan around every log. The old
     version tested a LEAF_REACH ball per log — 40 logs x 729 cells is ~29k getBlock calls in a
     single frame, which was the bulk of the felling hitch. A canopy is one connected shell, so
     flooding it visits each leaf about once: ~300 leaves x 6 neighbours instead. */
  const leafCells = new Map();
  const leafSeen = new Set();
  const lq = [];
  for (const l of logs)
    for (const [dx, dy, dz] of LEAF_DIRS) {
      const nx = l.x + dx, ny = l.y + dy, nz = l.z + dz;
      const k = nx + ',' + ny + ',' + nz;
      if (leafSeen.has(k)) continue;
      leafSeen.add(k);
      lq.push([nx, ny, nz, 1]);
    }
  for (let qi = 0; qi < lq.length && leafCells.size < FELL_MAX_LEAVES; qi++) {
    const [cx, cy, cz, d] = lq[qi];
    const cid = getBlock(cx, cy, cz) & 255;
    if (!isLeaf(cid)) continue;
    leafCells.set(cx + ',' + cy + ',' + cz, { x: cx, y: cy, z: cz, id: cid });
    if (d >= LEAF_REACH) continue;
    for (const [dx, dy, dz] of LEAF_DIRS) {
      const nx = cx + dx, ny = cy + dy, nz = cz + dz;
      const k = nx + ',' + ny + ',' + nz;
      if (leafSeen.has(k)) continue;
      leafSeen.add(k);
      lq.push([nx, ny, nz, d + 1]);
    }
  }

  /* Queue the collapse instead of doing it now. A mature oak is ~40 logs and several hundred
     leaves; clearing all of them in one frame means that many setBlock calls, each dirtying a
     chunk and re-flooding light, which showed up as a hard hitch. Spreading it over FELL_STEPS
     ticks also reads better — the tree comes apart from the top down instead of vanishing. */
  logs.sort((a, b) => b.y - a.y);                       // crown first, so the tree folds downward
  /* Leaves go the OTHER way — lowest first. Releasing the top of the canopy first dropped every
     upper leaf onto the leaf blocks still standing underneath it: it came to rest in mid-air,
     could not settle, and spilled as an item instead of deepening the drift. Bottom-up clears
     each column ahead of the leaf above it. */
  const leaves = [...leafCells.values()].sort((a, b) => a.y - b.y);
  FELL_JOBS.push({
    logs, leaves, li: 0, ci: 0,
    logStep: Math.min(FELL_MAX_PER_STEP, Math.ceil(logs.length / FELL_STEPS)),
    leafStep: Math.min(FELL_MAX_PER_STEP, Math.ceil(leaves.length / FELL_STEPS)),
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
const FELL_STEPS = 10;              // how many ticks a whole tree takes to come apart
const FELL_TICK = 0.05;             // seconds per step (so ~0.5s for any size of tree)
const FELL_MAX_PER_STEP = 24;       // hard ceiling on cells touched per tick, whatever the size
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
      if (FALLING.length < MAX_FALLING) spawnFallingLeaf(c.id, c.x, c.y, c.z);
      else settleLeafNow(c.id, c.x, c.y, c.z);
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
