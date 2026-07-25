'use strict';
/* voxiCraft — player state, AABB collision, movement, voxel raycast */

/* ================================================================================================
   PLAYER — creative fly (no gravity), AABB collision vs solid blocks, voxel-DDA targeting.
   ================================================================================================ */
const player = {
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
  for (let i = 0; i < 256; i++) {
    const b = getBlock(x, y, z), id = b & 255, prop = PROPS[id];
    if (b !== 0 && prop.raycast) {
      const boxes = rayBoxesAt(x, y, z);                     // neighbour-aware (stair corners) box list
      if (!boxes) return { x, y, z, nx, ny, nz, id };        // full cube: cell hit is the face hit
      let best = null, bestI = 0;                            // slab etc: refine against sub-boxes
      for (let bi = 0; bi < boxes.length; bi++) {
        const bb = boxes[bi];
        const hit = rayBox(origin, dir, x+bb[0], y+bb[1], z+bb[2], x+bb[3], y+bb[4], z+bb[5]);
        if (hit && hit.t <= maxDist && (!best || hit.t < best.t)) { best = hit; bestI = bi; }
      }
      if (best) return { x, y, z, nx: best.nx, ny: best.ny, nz: best.nz, id, bi: bestI };
      // no box hit in this cell -> keep traversing
    }
    if (tX < tY && tX < tZ) { if (tX > maxDist) return null; x += stepX; tX += dtX; nx = -stepX; ny = 0; nz = 0; }
    else if (tY < tZ)       { if (tY > maxDist) return null; y += stepY; tY += dtY; nx = 0; ny = -stepY; nz = 0; }
    else                    { if (tZ > maxDist) return null; z += stepZ; tZ += dtZ; nx = 0; ny = 0; nz = -stepZ; }
  }
  return null;
}

