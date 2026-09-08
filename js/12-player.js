'use strict';
/* voxiCraft — player state, AABB collision, movement, voxel raycast */

/* ================================================================================================
   PLAYER — creative fly (no gravity), AABB collision vs solid blocks, voxel-DDA targeting.
   ================================================================================================ */
/* THE ACTIVE player, swapped per viewport by 36-splitscreen.js — see the note on `camera`.
   Everything downstream still reads a single `player`; split screen just changes which one it is
   for the duration of that player's tick and render pass. */
var player = {
  pos: new THREE.Vector3(8.5, 96, 8.5),     // feet position
  yaw: -0.6, pitch: -0.3,
  speed: 12, fastMul: 2.2, walkSpeed: 5.6,
  R: 0.3, H: 1.8, EYE: 1.62,
  flying: true, vy: 0, lastJumpTap: 0,
  fast: false,                              // sprint is a toggle (Ctrl / L3), auto-released
  canFly: true,                             // false in survival mode
  hp: 20, food: 20, saturation: 0,          // 10 hearts / 10 drumsticks; saturation = gold-outlined buffer
  air: 10,                                  // oxygen bubbles — drains underwater, drowning at 0
  fallStart: null, prevOnGround: true,      // fall-height tracker + jump edge detection
  spawned: false,
  spawnPos: null,                           // first-spawn point — respawn target after death
  sneaking: false,
};
/* Every player currently in the world, in join order; entry 0 is player one and is what `player`
   points at outside any split-screen context swap. World systems that used to steer by "the
   player" — mob AI, item pickup, body separation — ask nearestPlayerTo() instead, so with one
   player they behave exactly as before and with four they follow whoever is closest. */
const PLAYERS = [player];
function nearestPlayerTo(x, z) {
  if (PLAYERS.length === 1) return PLAYERS[0];
  let best = null, bd = Infinity;
  for (const p of PLAYERS) {
    if (!p.spawned || p.dead) continue;
    const dx = p.pos.x - x, dz = p.pos.z - z, d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; best = p; }
  }
  return best || PLAYERS[0];            // everyone dead: still need a body to measure against
}
const anyPlayerSpawned = () => PLAYERS.some(p => p.spawned);
/* The probabilistic world sweeps (litter rot, snow melt, berry regrowth) scatter a fixed number
   of samples around "the player" every few seconds. With several players the honest thing is to
   rotate: pick one at random per pass, so the per-frame cost stays flat and everyone's
   surroundings get covered over time — the sampling was already random. */
function sweepOriginPlayer() {
  let n = 0, pick = null;
  for (const p of PLAYERS) if (p.spawned && Math.random() < 1 / ++n) pick = p;   // reservoir of 1
  return pick;
}

const MAX_HP = 20, MAX_FOOD = 20, MAX_SATURATION = 20, MAX_AIR = 10;
// food economy — baseline is passive (very slow); activity + regen speed it up
const FOOD_IDLE_PER_S      = 1 / 150;       // 150s per food point when standing still
const FOOD_SPRINT_MULT     = 2.8;           // sprinting drains 2.8x idle rate (-30% from 4)
const FOOD_JUMP_COST       = 0.105;         // per jump (-30% from 0.15)
const FOOD_REGEN_COST_PER_S = 1 / 4;        // regen costs 1 food per 4s while healing
const REGEN_FOOD_MIN       = 12;            // regen kicks in above this food (per user)
const REGEN_FAST_FOOD      = 18;            // above this the regen is 2x fast (per user)
const REGEN_HP_PER_S       = 0.5;           // slow tier rate; 2x above REGEN_FAST_FOOD
const STARVE_HP_PER_S      = 0.25;          // HP drain when food is 0

// double-tap jump (Space / gamepad A) toggles flying, Minecraft-creative style
function jumpTap() {
  if (!player.canFly) return;               // survival: flying disabled entirely
  const now = performance.now();
  if (now - player.lastJumpTap < 300) {
    player.flying = !player.flying;
    player.vy = 0;
    player.lastJumpTap = 0;
  } else player.lastJumpTap = now;
}

// standing on ground within 6cm below the feet? (box-aware: a slab's top counts)
function ground1(x, y, z, feetY) {
  const boxes = blockBoxes(x, y, z);
  if (!boxes) return false;
  for (const b of boxes) if (Math.abs((y + b[4]) - feetY) < 0.08) return true;   // a box top near the feet
  return false;
}
function onGround() {
  const p = player.pos, R = player.R - 0.02, y = Math.floor(p.y - 0.06);
  if (y < -1) return false;
  return ground1(Math.floor(p.x - R), y, Math.floor(p.z - R), p.y) ||
         ground1(Math.floor(p.x + R), y, Math.floor(p.z - R), p.y) ||
         ground1(Math.floor(p.x - R), y, Math.floor(p.z + R), p.y) ||
         ground1(Math.floor(p.x + R), y, Math.floor(p.z + R), p.y);
}
function onGroundAt(px, py, pz) {
  const R = player.R - 0.02, y = Math.floor(py - 0.06);
  if (y < -1) return false;
  return ground1(Math.floor(px - R), y, Math.floor(pz - R), py) ||
         ground1(Math.floor(px + R), y, Math.floor(pz - R), py) ||
         ground1(Math.floor(px - R), y, Math.floor(pz + R), py) ||
         ground1(Math.floor(px + R), y, Math.floor(pz + R), py);
}

/* Soft-ground drag (0.695, per-layer since 0.696). Leaves, leaf litter and snow carpets are all
   walk-through, so the only thing that makes them matter is the slowdown, and it scales with how
   deep the stack is: -10% per snow layer (a full 8-layer drift = -80%), -5% per leaf layer (a
   whole leaf block = -40%). Worst overlapping cell wins, checked feet-to-head over the body box. */
const DRAG_PER_SNOW = 0.10, DRAG_PER_LEAF = 0.05, DRAG_FLOOR = 0.2;
const LEAF_DRAG_IDS = new Set([B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES]);
// how tall the carpet in this cell stands, in block units (0 = not a carpet)
function _carpetHeight(val) {
  const id = val & 255;
  if (id === B.CARPET) return carpetTop(val) / CARPET_MAX;
  if (CARPET_MAT_OF[id]) return Math.min(CARPET_MAX, ((val >> 8) & 255) + 1) / CARPET_MAX;
  return 0;
}
// speed multiplier this cell imposes, given how far the feet sit above the cell floor
function _cellDrag(val, feetOff) {
  const id = val & 255;
  // a leaf block is a full cell of foliage: the whole CARPET_MAX worth of leaf layers
  if (LEAF_DRAG_IDS.has(id)) return Math.max(DRAG_FLOOR, 1 - DRAG_PER_LEAF * CARPET_MAX);
  const h = _carpetHeight(val);
  if (!h || feetOff >= h) return 1;                    // airborne above a thin layer: no drag
  let snow = 0, leaf = 0;
  if (id === B.CARPET) {
    for (let i = carpetTop(val) - 1; i >= 0; i--) {
      const m = carpetMat(val, i);
      if (m === CARPET_MAT.SNOW) snow++;
      else if (CARPET_LITTER.has(m)) leaf++;
    }
  } else {                                              // legacy single-material carpet
    const n = Math.min(CARPET_MAX, ((val >> 8) & 255) + 1);
    if (CARPET_MAT_OF[id] === CARPET_MAT.SNOW) snow = n; else leaf = n;
  }
  return Math.max(DRAG_FLOOR, 1 - DRAG_PER_SNOW * snow - DRAG_PER_LEAF * leaf);
}
// worst drag over an axis-aligned body box (feet at cy, half-width R, height H). Mobs use it too.
function boxDragMul(cx, cy, cz, R, H) {
  let mul = 1;
  const maxY = Math.floor(cy + H);
  for (let y = Math.floor(cy); y <= maxY; y++) {
    const feetOff = Math.max(0, cy - y);
    for (let z = Math.floor(cz - R); z <= Math.floor(cz + R); z++)
      for (let x = Math.floor(cx - R); x <= Math.floor(cx + R); x++) {
        const m = _cellDrag(getBlock(x, y, z), feetOff);
        if (m < mul) mul = m;
      }
  }
  return mul;
}
function terrainSpeedMul() {
  const p = player.pos;
  const raw = boxDragMul(p.x, p.y, p.z, player.R - 0.02, player.H);
  /* A full leather set blunts the PENALTY, not the speed (0.732): a 40% leaf slowdown becomes 28%
     rather than the player simply moving faster everywhere. Written this way so a resistance of 1
     would remove the slowdown entirely and never overshoot into a speed boost. */
  const r = typeof playerTerrainDragResist === 'function' ? playerTerrainDragResist() : 0;
  return r > 0 ? 1 - (1 - raw) * (1 - r) : raw;
}

function collideAxis(axis, delta) {
  if (delta === 0) return;
  const p = player.pos, R = player.R, H = player.H, EPS = 0.001;
  p.setComponent(axis, p.getComponent(axis) + delta);
  const minX = Math.floor(p.x - R), maxX = Math.floor(p.x + R);
  const minY = Math.floor(p.y),     maxY = Math.floor(p.y + H);
  const minZ = Math.floor(p.z - R), maxZ = Math.floor(p.z + R);
  for (let y = minY; y <= maxY; y++)
    for (let z = minZ; z <= maxZ; z++)
      for (let x = minX; x <= maxX; x++) {
        const boxes = blockBoxes(x, y, z);
        if (!boxes) continue;
        for (const b of boxes) {
          // sub-box world extents. Resolve the moving axis only when the player AABB actually
          // penetrates the box on ALL THREE axes — including the moving one. Checking only the
          // other two lets a player standing BESIDE a sub-box (same cell, different sub-region,
          // e.g. off the empty half of a vertical slab) get clamped to the box face and teleport.
          const X0 = x+b[0], Y0 = y+b[1], Z0 = z+b[2], X1 = x+b[3], Y1 = y+b[4], Z1 = z+b[5];
          if (!(p.x-R < X1 && p.x+R > X0 && p.y < Y1 && p.y+H > Y0 && p.z-R < Z1 && p.z+R > Z0)) continue;
          if (axis === 0)      p.x = delta > 0 ? Math.min(p.x, X0 - R - EPS) : Math.max(p.x, X1 + R + EPS);
          else if (axis === 1) p.y = delta > 0 ? Math.min(p.y, Y0 - H - EPS) : Math.max(p.y, Y1 + EPS);
          else                 p.z = delta > 0 ? Math.min(p.z, Z0 - R - EPS) : Math.max(p.z, Z1 + R + EPS);
        }
      }
}
function movePlayer(dx, dy, dz) {
  const STEP = 0.55;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.25));
  for (let i = 0; i < steps; i++) {
    const sdx = dx / steps, sdz = dz / steps, sdy = dy / steps;
    const ox = player.pos.x, oy = player.pos.y, oz = player.pos.z;
    collideAxis(0, sdx);
    collideAxis(2, sdz);
    const ax = player.pos.x, az = player.pos.z;
    // step-up: grounded, not jumping, horizontally blocked → try climbing over ledge
    if ((sdx * sdx + sdz * sdz) > 1e-12 && sdy <= 0 && onGround()) {
      const errX = ax - ox - sdx, errZ = az - oz - sdz;
      const err2 = errX * errX + errZ * errZ;
      if (err2 > (sdx * sdx + sdz * sdz) * 0.01) {
        player.pos.set(ox, oy, oz);
        collideAxis(1, STEP);
        if (player.pos.y - oy > 0.01) {
          collideAxis(0, sdx);
          collideAxis(2, sdz);
          const bx = player.pos.x, bz = player.pos.z;
          const eX2 = bx - ox - sdx, eZ2 = bz - oz - sdz;
          if (eX2 * eX2 + eZ2 * eZ2 < err2 - 0.0001) {
            // step-up reduced collision error — keep lifted position
          } else {
            player.pos.set(ax, oy, az);
          }
        } else {
          player.pos.set(ax, oy, az);
        }
      }
    }
    collideAxis(1, sdy);
  }
}

// ray vs axis-aligned box (slab method); returns the entry hit {t,nx,ny,nz} or null
function rayBox(o, d, X0, Y0, Z0, X1, Y1, Z1) {
  const O = [o.x, o.y, o.z], D = [d.x, d.y, d.z], L = [X0, Y0, Z0], H = [X1, Y1, Z1];
  let tmin = -Infinity, tmax = Infinity, axis = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(D[i]) < 1e-9) { if (O[i] < L[i] || O[i] > H[i]) return null; continue; }
    let t1 = (L[i] - O[i]) / D[i], t2 = (H[i] - O[i]) / D[i];
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; axis = i; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin < 0 || tmax < 0) return null;
  const n = [0, 0, 0]; n[axis] = D[axis] > 0 ? -1 : 1;   // entry face normal opposes the ray
  return { t: tmin, nx: n[0], ny: n[1], nz: n[2] };
}

/* 0.7295 — plants are targetable again, but only in creative. Bush pickup is the survival way to
   gather grass/wheat/berries, and it needs the crosshair to pass straight through them; creative
   has no bush pickup at all, so there the ray must stop on a plant or grass could not be removed
   by hand. Reads `player.canFly` (the creative flag) live, per ray. */
const _plantsTargetable = () => !!(typeof player !== 'undefined' && player && player.canFly);

// Amanatides & Woo voxel traversal; skips non-raycastable blocks (water can never be targeted).
// For non-cube models (slabs) it refines the cell hit against the real sub-boxes, so aiming
// through a slab's empty upper half passes through instead of falsely targeting the cell.
function raycastVoxel(origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
  const dtX = Math.abs(1 / dir.x), dtY = Math.abs(1 / dir.y), dtZ = Math.abs(1 / dir.z);
  let tX = dir.x !== 0 ? Math.abs(((stepX > 0 ? x + 1 : x) - origin.x) / dir.x) : Infinity;
  let tY = dir.y !== 0 ? Math.abs(((stepY > 0 ? y + 1 : y) - origin.y) / dir.y) : Infinity;
  let tZ = dir.z !== 0 ? Math.abs(((stepZ > 0 ? z + 1 : z) - origin.z) / dir.z) : Infinity;
  let nx = 0, ny = 0, nz = 0;
  let tEnter = 0;                     // distance along the ray at which we entered the current cell
  for (let i = 0; i < 256; i++) {
    const b = getBlock(x, y, z), id = b & 255, prop = PROPS[id];
    /* `noTarget` blocks are see-through to the crosshair in SURVIVAL: the ray passes straight
       on, because bush pickup is what gathers them. Kept separate from `raycast:false` because
       that flag also drops a block from the creative palette (13-actions builds PLACEABLE from
       it) — grass still has to be placeable, it just must never be what a survival player is
       aiming at. In creative the ray does stop on them (see _plantsTargetable). */
    if (b !== 0 && prop.raycast && (!prop.noTarget || _plantsTargetable())) {
      const boxes = rayBoxesAt(x, y, z);                     // neighbour-aware (stair corners) box list
      if (!boxes) return { x, y, z, nx, ny, nz, id, t: tEnter };   // full cube: cell hit is the face hit
      let best = null, bestI = 0;                            // slab etc: refine against sub-boxes
      for (let bi = 0; bi < boxes.length; bi++) {
        const bb = boxes[bi];
        const hit = rayBox(origin, dir, x+bb[0], y+bb[1], z+bb[2], x+bb[3], y+bb[4], z+bb[5]);
        if (hit && hit.t <= maxDist && (!best || hit.t < best.t)) { best = hit; bestI = bi; }
      }
      if (best) return { x, y, z, nx: best.nx, ny: best.ny, nz: best.nz, id, bi: bestI, t: best.t };
      // no box hit in this cell -> keep traversing
    }
    if (tX < tY && tX < tZ) { if (tX > maxDist) return null; tEnter = tX; x += stepX; tX += dtX; nx = -stepX; ny = 0; nz = 0; }
    else if (tY < tZ)       { if (tY > maxDist) return null; tEnter = tY; y += stepY; tY += dtY; nx = 0; ny = -stepY; nz = 0; }
    else                    { if (tZ > maxDist) return null; tEnter = tZ; z += stepZ; tZ += dtZ; nx = 0; ny = 0; nz = -stepZ; }
  }
  return null;
}

