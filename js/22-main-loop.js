'use strict';
/* voxiCraft — per-frame update: movement, mining, drops, camera */

/* ================================================================================================
   MAIN LOOP
   ================================================================================================ */
/* ---- gravity blocks (sand, gravel) ---- */
const fallingBlocks = new Map();   // "x,y,z" -> blockId
function scheduleFall(x, y, z) {
  if (y < 1 || y > 199) return;
  const id = getBlock(x, y, z) & 255;
  if (id !== B.SAND && id !== B.RED_SAND && id !== B.GRAVEL) return;
  if ((getBlock(x, y - 1, z) & 255) !== B.AIR) return;
  fallingBlocks.set(`${x},${y},${z}`, id);
}
let _fallTimer = 0;
function processFalling(dt) {
  _fallTimer += dt;
  if (_fallTimer < 0.08) return;
  _fallTimer -= 0.08;
  const todo = [...fallingBlocks.keys()];
  for (const k of todo) {
    if (!fallingBlocks.has(k)) continue;
    const id = fallingBlocks.get(k);
    fallingBlocks.delete(k);
    const [x, y, z] = k.split(',').map(Number);
    if ((getBlock(x, y, z) & 255) !== id) continue;
    if ((getBlock(x, y - 1, z) & 255) !== B.AIR) continue;
    setBlock(x, y, z, B.AIR);
    setBlock(x, y - 1, z, id);
  }
}

/* ---- leaves natural decay ---- */
const leavesDecayQueue = new Set();
const DECAY_DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

const _isLeaf = (id) => id === B.LEAVES || id === B.BIRCH_LEAVES;
const _isLog  = (id) => id === B.LOG || id === B.BIRCH_LOG;
function scheduleLeavesCheck(cx, cy, cz) {
  const R = 5;
  for (let dx = -R; dx <= R; dx++)
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++)
        if (_isLeaf(getBlock(cx+dx, cy+dy, cz+dz) & 255))
          leavesDecayQueue.add(`${cx+dx},${cy+dy},${cz+dz}`);
}

function isLeavesConnected(lx, ly, lz) {
  const visited = new Set();
  const queue = [[lx, ly, lz, 0]];
  visited.add(`${lx},${ly},${lz}`);
  while (queue.length) {
    const [x, y, z, dist] = queue.shift();
    for (const [dx, dy, dz] of DECAY_DIRS) {
      const nx = x+dx, ny = y+dy, nz = z+dz;
      const key = `${nx},${ny},${nz}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const b = getBlock(nx, ny, nz) & 255;
      if (_isLog(b)) return true;
      if (_isLeaf(b) && dist < 4) queue.push([nx, ny, nz, dist + 1]);
    }
  }
  return false;
}

let leavesDecayTimer = 0;
function processLeavesDecay(dt) {
  leavesDecayTimer += dt;
  if (leavesDecayTimer < 0.5) return;
  leavesDecayTimer -= 0.5;
  const toProcess = [...leavesDecayQueue].slice(0, 8);
  for (const key of toProcess) {
    leavesDecayQueue.delete(key);
    const [x, y, z] = key.split(',').map(Number);
    const leafId = getBlock(x, y, z) & 255;
    if (!_isLeaf(leafId)) continue;
    if (!isLeavesConnected(x, y, z)) {
      // base decay chance 0.08, then scaled by the world tick speed
      if (Math.random() < 0.08 * tickFactor()) {
        setBlock(x, y, z, B.AIR);
        for (const drop of blockDrop(leafId, true))
          for (let i = 0; i < drop.count; i++) spawnDrop(drop.id, x, y, z);
        scheduleLeavesCheck(x, y, z);
      } else {
        leavesDecayQueue.add(key);
      }
    }
  }
}

/* ---- grass spread: a dirt block slowly turns to grass when it's lit from above (transparent
   block overhead = sunlight/light reaches it) AND a grass block sits in the neighbouring 3×3×
   (±1 y) column. Very slow; sampled randomly near the player and scaled by the tick speed. ---- */
let _grassTimer = 0;
// grass blocks that are covered (opaque block above): key "x,y,z" -> seconds it has stayed dark.
// Only a full 24 in-game hours (= DAY_LEN real seconds) of continuous cover turns it to dirt,
// so a passing night or shadow (which never make the block above opaque) can't trigger it.
const _darkGrass = new Map();
function processGrassSpread(dt) {
  if (menuScene || !player.spawned) return;      // don't mutate the title panorama
  _grassTimer += dt;
  const interval = 1.0 / tickFactor();
  if (_grassTimer < interval) return;
  _grassTimer -= interval;
  const px = Math.floor(player.pos.x), py = Math.floor(player.pos.y), pz = Math.floor(player.pos.z);
  // sampling is anchored on GRASS blocks and spreads outward to a neighbouring lit dirt — far
  // higher hit rate than probing random air, so spread is actually visible. Scales with tick speed.
  const tries = Math.max(4, Math.round(30 * tickFactor()));
  for (let i = 0; i < tries; i++) {
    const x = px + (Math.random() * 48 | 0) - 24;
    const z = pz + (Math.random() * 48 | 0) - 24;
    const y = py + (Math.random() * 16 | 0) - 8;
    if ((getBlock(x, y, z) & 255) !== B.GRASS) continue;            // spread originates from grass
    if (PROPS[getBlock(x, y + 1, z) & 255].opaque) {               // covered grass: track for decay
      const k = `${x},${y},${z}`; if (!_darkGrass.has(k)) _darkGrass.set(k, 0);
      continue;
    }
    // pick a random neighbour in the 3×3×3 shell; convert it if it's dirt lit from above
    const tx = x + (Math.random() * 3 | 0) - 1, ty = y + (Math.random() * 3 | 0) - 1, tz = z + (Math.random() * 3 | 0) - 1;
    if ((getBlock(tx, ty, tz) & 255) !== B.DIRT) continue;
    if (PROPS[getBlock(tx, ty + 1, tz) & 255].opaque) continue;     // target needs light too
    setBlock(tx, ty, tz, B.GRASS);
  }
  // age the covered-grass timers; convert after 24h dark, drop entries that got uncovered/changed
  for (const [k, t] of _darkGrass) {
    const [x, y, z] = k.split(',').map(Number);
    if ((getBlock(x, y, z) & 255) !== B.GRASS || !PROPS[getBlock(x, y + 1, z) & 255].opaque) { _darkGrass.delete(k); continue; }
    const nt = t + interval;
    if (nt >= DAY_LEN) { setBlock(x, y, z, B.DIRT); _darkGrass.delete(k); }
    else _darkGrass.set(k, nt);
  }
}

/* ---- throwing ---- */
function tryThrow() {
  if (!playing || player.canFly || invOpen || menuScene) return false;
  const slot = HOTBAR[hotbarSel];
  if (!slot || !ITEM_PROPS[slot.id]?.throwable) return false;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  spawnProjectile(slot.id,
    player.pos.x + fwd.x * 0.3,
    player.pos.y + player.EYE - 0.1,
    player.pos.z + fwd.z * 0.3,
    fwd.x * 22, fwd.y * 22 + 1.5, fwd.z * 22
  );
  slot.count--;
  if (slot.count <= 0) HOTBAR[hotbarSel] = null;
  saveHotbar(); buildHotbar();
  return true;
}

/* ---- eating ---- */
let _eatTimer = 0;
const EAT_TIME = 1.1;   // default eat duration; override per-item via eatTime in ITEM_PROPS
function updateEating(dt, wantPlace) {
  if (!playing || player.canFly || invOpen || menuScene) { _eatTimer = 0; return 0; }
  const slot = HOTBAR[hotbarSel];
  const id = slot ? slot.id : null;
  const isFood = id !== null && ITEM_PROPS[id]?.food > 0;
  const eatDur = (id !== null && ITEM_PROPS[id]?.eatTime) || EAT_TIME;
  if (wantPlace && isFood) {
    _eatTimer = Math.min(eatDur, _eatTimer + dt);
    if (_eatTimer >= eatDur) {
      _eatTimer = 0;
      const foodAmt = ITEM_PROPS[id].food || 0;
      const foodSat = ITEM_PROPS[id].foodSat || 0;
      if (player.food < MAX_FOOD) {
        player.food = Math.min(MAX_FOOD, player.food + foodAmt);
        player.saturation = Math.min(MAX_SATURATION, player.saturation + foodSat);
      } else {
        const fullSat = ITEM_PROPS[id].foodSatFull ?? foodSat;
        player.saturation = Math.min(MAX_SATURATION, player.saturation + fullSat);
      }
      slot.count--;
      if (slot.count <= 0) HOTBAR[hotbarSel] = null;
      // give back container item (e.g. bowl from mushroom stew)
      const returnId = ITEM_PROPS[id].foodReturn;
      if (returnId != null) {
        const cap = stackSize(returnId);
        let placed = false;
        for (let k = 0; k < HOTBAR.length && !placed; k++) {
          const s = HOTBAR[k]; if (s && s.id === returnId && s.count < cap) { s.count++; placed = true; }
        }
        if (!placed) for (let k = 0; k < invSlots.length && !placed; k++) {
          const s = invSlots[k]; if (s && s.id === returnId && s.count < cap) { s.count++; placed = true; }
        }
        if (!placed) {
          const fh = HOTBAR.indexOf(null), fi = invSlots.indexOf(null);
          if (fh >= 0) HOTBAR[fh] = mkSlot(returnId, 1), placed = true;
          else if (fi >= 0) invSlots[fi] = mkSlot(returnId, 1), placed = true;
          else toast('inventory full — bowl lost');
        }
      }
      saveHotbar(); buildHotbar(); vitalsDirty = true;
    }
  } else {
    _eatTimer = 0;
  }
  return isFood ? _eatTimer / eatDur : 0;
}

/* ---- world simulation speed (per-world "random tick speed" setting; default 3) ----
   scales natural processes: leaves decay, water flow, grass spread. factor 1.0 at the default. */
let randomTickSpeed = 3;
const tickFactor = () => Math.max(0.05, randomTickSpeed / 3);

/* ---- water flow simulation ---- */
const _waterQueue = new Set();
let _waterTick = 0;
const WATER_BASE_RATE = 0.90;             // slow flow; divided by tickFactor
const waterInterval = () => WATER_BASE_RATE / tickFactor();

function queueWaterAt(x, y, z) {
  if ((getBlock(x, y, z) & 255) === B.WATER) _waterQueue.add(`${x},${y},${z}`);
}
function queueWaterAround(x, y, z) {
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])
    queueWaterAt(x + dx, y + dy, z + dz);
}
// a flowing cell survives only if still fed: water directly above, or a horizontal neighbour
// one level fuller. Sources (level 0) always stay — so oceans/lakes never drain.
function _waterFed(x, y, z, level) {
  if (level === 0) return true;
  if ((getBlock(x, y + 1, z) & 255) === B.WATER) return true;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nb = getBlock(x + dx, y, z + dz);
    if ((nb & 255) === B.WATER && ((nb >> 8) & 15) < level) return true;
  }
  return false;
}
// after a source is removed, dry up every flowing cell it used to feed (BFS outward)
function dryWaterFrom(sx, sy, sz) {
  const work = [];
  const push = (x, y, z) => { for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0],[0,1,0]]) work.push([x+dx, y+dy, z+dz]); };
  push(sx, sy, sz);
  let guard = 0;
  while (work.length && guard++ < 50000) {
    const [x, y, z] = work.pop();
    const val = getBlock(x, y, z);
    if ((val & 255) !== B.WATER) continue;
    if (_waterFed(x, y, z, (val >> 8) & 15)) continue;
    setBlock(x, y, z, B.AIR);
    push(x, y, z);
  }
}
function updateWaterFlow(dt) {
  _waterTick += dt;
  const rate = waterInterval();
  if (_waterTick < rate || _waterQueue.size === 0) return;
  _waterTick -= rate;
  const todo = [..._waterQueue];
  _waterQueue.clear();
  for (const key of todo) {
    const [x, y, z] = key.split(',').map(Number);
    const val = getBlock(x, y, z);
    if ((val & 255) !== B.WATER) continue;
    const level = (val >> 8) & 15;
    // flow down first (falling keeps same level)
    if (y > 0 && (getBlock(x, y - 1, z) & 255) === B.AIR) {
      setBlock(x, y - 1, z, B.WATER | (level << 8));
      queueWaterAt(x, y - 1, z);
      continue;  // skip horizontal spread this tick
    }
    // horizontal spread at level+1 (capped at 7)
    if (level < 7) {
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, nz = z + dz;
        const nb = getBlock(nx, y, nz);
        const nbId = nb & 255;
        if (nbId === B.AIR) {
          setBlock(nx, y, nz, B.WATER | ((level + 1) << 8));
          queueWaterAt(nx, y, nz);
        } else if (nbId === B.WATER && level + 1 < ((nb >> 8) & 15)) {
          setBlock(nx, y, nz, B.WATER | ((level + 1) << 8));
          queueWaterAt(nx, y, nz);
        }
      }
    }
  }
}

/* ---- lava flow simulation (same as water but much slower, max spread level 4) ---- */
const _lavaQueue = new Set();
let _lavaTick = 0;
const LAVA_BASE_RATE = 9.0;
const lavaInterval = () => LAVA_BASE_RATE / tickFactor();

function queueLavaAt(x, y, z) {
  if ((getBlock(x, y, z) & 255) === B.LAVA) _lavaQueue.add(`${x},${y},${z}`);
}
function queueLavaAround(x, y, z) {
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])
    queueLavaAt(x + dx, y + dy, z + dz);
}
function _lavaFed(x, y, z, level) {
  if (level === 0) return true;
  if ((getBlock(x, y + 1, z) & 255) === B.LAVA) return true;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nb = getBlock(x + dx, y, z + dz);
    if ((nb & 255) === B.LAVA && ((nb >> 8) & 15) < level) return true;
  }
  return false;
}
function updateLavaFlow(dt) {
  _lavaTick += dt;
  const rate = lavaInterval();
  if (_lavaTick < rate || _lavaQueue.size === 0) return;
  _lavaTick -= rate;
  const todo = [..._lavaQueue];
  _lavaQueue.clear();
  for (const key of todo) {
    const [x, y, z] = key.split(',').map(Number);
    const val = getBlock(x, y, z);
    if ((val & 255) !== B.LAVA) continue;
    const level = (val >> 8) & 15;
    if (!_lavaFed(x, y, z, level)) { setBlock(x, y, z, B.AIR); continue; }
    if (y > 0 && (getBlock(x, y - 1, z) & 255) === B.AIR) {
      setBlock(x, y - 1, z, B.LAVA | (level << 8));
      queueLavaAt(x, y - 1, z);
      continue;
    }
    if (level < 4) {
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, nz = z + dz;
        const nb = getBlock(nx, y, nz);
        const nbId = nb & 255;
        if (nbId === B.AIR) {
          setBlock(nx, y, nz, B.LAVA | ((level + 1) << 8));
          queueLavaAt(nx, y, nz);
        } else if (nbId === B.LAVA && level + 1 < ((nb >> 8) & 15)) {
          setBlock(nx, y, nz, B.LAVA | ((level + 1) << 8));
          queueLavaAt(nx, y, nz);
        }
      }
    }
  }
}

/* ---- TNT: fuse tick, blinking, explosion ----
   Placed TNT blocks live in TNTS with a countdown timer + a blink phase. The block ID stays
   B.TNT the whole time; only the variant byte's low bit toggles (0 → normal faces, 1 → white
   flash via the mesher swap). While a TNT is armed, its position is protected from being
   broken (isTNTFuseActive is checked by both mining paths and doBreak). */
const TNTS = new Map();                  // "x,y,z" -> { t, blinkT, lit }
const TNT_FUSE = 3.0;
const TNT_RADIUS = 4;
const _tntKey = (x, y, z) => x + ',' + y + ',' + z;
function armTNT(x, y, z) { TNTS.set(_tntKey(x, y, z), { t: TNT_FUSE, blinkT: 0, lit: 0 }); }
function isTNTFuseActive(x, y, z) { return TNTS.has(_tntKey(x, y, z)); }
function explodeAt(cx, cy, cz, R) {
  const survival = !player.canFly;
  const chained = [];
  const R2 = R * R;
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R2) continue;
        // fuzzy shell: cells near the sphere surface drop out with rising probability, so the
        // crater silhouette reads as a sphere instead of an axis-aligned diamond of cubes.
        const d = Math.sqrt(d2);
        if (R - d < 0.9 && Math.random() < 0.55) continue;
        const x = cx + dx, y = cy + dy, z = cz + dz;
        if (y < 0 || y > 199) continue;
        const val = getBlock(x, y, z);
        const id = val & 255;
        if (id === B.AIR || id === B.BEDROCK || id === B.WATER || id === B.LAVA) continue;
        if (id === B.TNT && !(x === cx && y === cy && z === cz)) chained.push([x, y, z]);
        if (survival && id !== B.TNT && Math.random() < 0.5) {
          for (const drop of blockDrop(id, false))
            for (let i = 0; i < drop.count; i++) spawnDrop(drop.id, x, y, z);
        }
        TNTS.delete(_tntKey(x, y, z));
        setBlock(x, y, z, B.AIR);
        queueWaterAround(x, y, z);
        queueLavaAround(x, y, z);
      }
  for (const [x, y, z] of chained) armTNT(x, y, z);
}
function updateTNTs(dt) {
  if (TNTS.size === 0) return;
  const stale = [];
  for (const [k, r] of TNTS) {
    const p = k.split(','), x = +p[0], y = +p[1], z = +p[2];
    const val = getBlock(x, y, z);
    if ((val & 255) !== B.TNT) { stale.push(k); continue; }
    r.t -= dt;
    r.blinkT -= dt;
    if (r.blinkT <= 0) {
      r.lit ^= 1;
      // blink period accelerates toward zero: 0.35s at 3s left → 0.06s minimum near boom
      r.blinkT = Math.max(0.06, r.t * 0.18);
      setBlock(x, y, z, B.TNT | (r.lit << 8));
    }
    if (r.t <= 0) {
      stale.push(k);
      explodeAt(x, y, z, TNT_RADIUS);
    }
  }
  for (const k of stale) TNTS.delete(k);
}

/* ---- saplings: grow into full trees after 7-14 in-game days ----
   Placed saplings register in SAPLINGS with a target worldDay. Each frame we compare current
   worldDay against the target; when reached, replace the sapling with a small tree. Growth is
   transient (Map lives in memory only) — saplings placed before a world reload keep sitting as
   saplings forever. Acceptable for a first pass. */
const SAPLINGS = new Map();     // "x,y,z" -> { type: B.OAK_SAPLING|B.BIRCH_SAPLING, growAt }
function armSapling(x, y, z, type) {
  SAPLINGS.set(x + ',' + y + ',' + z, { type, growAt: worldDay + 7 + Math.floor(Math.random() * 8) });
}
function _putSoft(x, y, z, id) {
  if (y < 0 || y > 199) return;
  const cur = getBlock(x, y, z) & 255;
  if (cur === B.AIR || cur === B.LEAVES || cur === B.BIRCH_LEAVES) setBlock(x, y, z, id);
}
function _growTree(x, y, z, isBirch) {
  const LOG = isBirch ? B.BIRCH_LOG : B.LOG;
  const LEAF = isBirch ? B.BIRCH_LEAVES : B.LEAVES;
  const h = 4 + Math.floor(Math.random() * 3);         // 4..6
  setBlock(x, y, z, LOG);                              // trunk starts at sapling cell (overwrites it)
  for (let k = 1; k < h; k++) _putSoft(x, y + k, z, LOG);
  // canopy: 3x3x3 blob centered near top, with rounded corners
  const top = y + h;
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dz === 0 && dy < 1) continue;   // don't overwrite trunk mid-canopy
        const r = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
        if (r > 3) continue;
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;   // clip corners
        _putSoft(x + dx, top + dy, z + dz, LEAF);
      }
  _putSoft(x, top + 2, z, LEAF);
}
function updateSaplings() {
  if (SAPLINGS.size === 0) return;
  const stale = [];
  for (const [k, r] of SAPLINGS) {
    const p = k.split(','), x = +p[0], y = +p[1], z = +p[2];
    const cur = getBlock(x, y, z) & 255;
    if (cur !== r.type) { stale.push(k); continue; }               // broken / replaced
    if (worldDay >= r.growAt) {
      stale.push(k);
      _growTree(x, y, z, r.type === B.BIRCH_SAPLING);
    }
  }
  for (const k of stale) SAPLINGS.delete(k);
}

/* ---- water current: horizontal flow direction from the level gradient ----
   Flowing water pushes entities toward higher level numbers (downstream). Source pools
   (all level 0) produce no current. Result normalized into `out`; false = still water. */
const _flowV = { x: 0, z: 0 };
const _uwTint = new THREE.Color(0x0a2438);   // underwater murk color
function waterFlowVec(x, y, z, out) {
  out.x = 0; out.z = 0;
  const val = getBlock(x, y, z);
  if ((val & 255) !== B.WATER) return false;
  const level = (val >> 8) & 7;
  let fx = 0, fz = 0;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nb = getBlock(x + dx, y, z + dz);
    const nbId = nb & 255;
    if (nbId === B.WATER) {
      const nl = (nb >> 8) & 7;
      fx += dx * (nl - level); fz += dz * (nl - level);
    } else if (nbId === B.AIR && level < 7 && (getBlock(x + dx, y - 1, z + dz) & 255) === B.AIR) {
      fx += dx * 2; fz += dz * 2;          // waterfall edge pulls hard
    }
  }
  const m = Math.hypot(fx, fz);
  if (m < 1e-6) return false;
  out.x = fx / m; out.z = fz / m;
  return true;
}

let lastT = performance.now();
let fps = 0, fpsFrames = 0, fpsT = lastT;
let hudT = 0;
let wasMoving = false, lastFlying = player.flying;   // sprint auto-release tracking

// held-light state: track last-known position + item to detect changes
let _hlId = undefined, _hlLevel = 0, _hlX = null, _hlY = null, _hlZ = null;
let _hlRaw = 0;  // raw light value of current held item (exposed for arm glow in 24-hands.js)
const _handSaveLC = new THREE.Color();  // reusable save slot for uLightColor during hand render

function frame(now) {
  requestAnimationFrame(frame);
  if (fpsLimit > 0 && now - lastT < 1000 / fpsLimit - 2) return;   // fps cap: skip whole tick
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  sharedUniforms.uTime.value += dt;

  // fps
  fpsFrames++;
  if (now - fpsT >= 500) { fps = Math.round(fpsFrames * 1000 / (now - fpsT)); fpsFrames = 0; fpsT = now; }

  /* ---- input & movement ---- */
  const _preYaw = player.yaw, _prePitch = player.pitch;
  const gp = pollGamepad(dt);
  if (player.dead) {                        // dead: no look (mouse gated in input, pad undone here),
    player.yaw = _preYaw; player.pitch = _prePitch;   // no movement, no fly/jump input
    gp.mx = gp.mz = 0; gp.up = gp.dn = false;
  }
  const kb = playing && !invOpen && !player.dead;   // keyboard steers when no menu/inventory is open
  let fwd = (kb && keys.KeyW ? 1 : 0) - (kb && keys.KeyS ? 1 : 0) - gp.mz;
  let str = (kb && keys.KeyD ? 1 : 0) - (kb && keys.KeyA ? 1 : 0) + gp.mx;
  const upHeld = (kb && keys.Space) || gp.up;
  const dnHeld = (kb && (keys.ShiftLeft || keys.ShiftRight)) || gp.dn;
  const fast   = player.fast;
  const len = Math.hypot(fwd, str);
  if (len > 1) { fwd /= len; str /= len; }

  const grounded = onGround();
  const inWater = (getBlock(Math.floor(player.pos.x), Math.floor(player.pos.y + 0.4), Math.floor(player.pos.z)) & 255) === B.WATER;
  player._inWater = inWater;               // exposed for fall damage + hand animation
  player.sneaking = !player.flying && !inWater && grounded && dnHeld && !player.dead;
  let dy, hSpeed;
  if (player.flying) {
    hSpeed = player.speed * (fast ? player.fastMul : 1);
    dy = ((upHeld ? 1 : 0) - (dnHeld ? 1 : 0)) * hSpeed * dt;
    player.vy = 0;
    if (dnHeld && grounded) player.flying = false;  // sneak onto a block top -> land & walk
  } else {
    if (inWater) {                          // swim: jump = up, shift = fast sink, else slow sink
      // sprint-swim: passive float/sink 95% weaker AND vy damped hard so the player
      // glides at near-constant depth (no drift up or down)
      const sprintSwim = fast && fwd > 0.1;
      const glide = sprintSwim && !upHeld && !dnHeld;
      const acc = (upHeld ? 36 : dnHeld ? -32 : -14) * (glide ? 0.05 : 1);
      player.vy = Math.max(dnHeld ? -7 : -5, Math.min(4.5, player.vy + acc * dt));
      if (glide) player.vy *= Math.max(0, 1 - 10 * dt);
      // sprint-swim: pitch steers depth, but vertical component is 95% slower than horizontal
      if (fast && fwd > 0.1) {
        const pitchVert = Math.sin(player.pitch) * 30 * dt * 0.05;
        player.vy = Math.max(-6, Math.min(6, player.vy + pitchVert));
      }
      // near the surface + holding jump: full pop-out ONLY next to a climbable wall —
      // otherwise cap upward speed so you bob at the surface instead of jumping on water
      if (upHeld && (getBlock(Math.floor(player.pos.x), Math.floor(player.pos.y + 1.2), Math.floor(player.pos.z)) & 255) !== B.WATER) {
        const px = Math.floor(player.pos.x), pyF = Math.floor(player.pos.y), pz = Math.floor(player.pos.z);
        let nearWall = false;
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]])
          if (isSolid(px + dx, pyF, pz + dz) || isSolid(px + dx, pyF + 1, pz + dz)) { nearWall = true; break; }
        if (nearWall) player.vy = 8.0;
        else player.vy = Math.min(player.vy, 3.0);
      }
    } else {
      if (grounded) { if (player.vy < 0) player.vy = 0; if (upHeld) player.vy = 8.7; }
      player.vy = Math.max(-58, player.vy - 27 * dt);           // gravity
    }
    dy = player.vy * dt;
    hSpeed = player.walkSpeed * (player.sneaking ? 0.3 : fast ? (inWater ? 1.9 : 1.6) : 1) * (inWater ? 0.45 : 1);
  }
  if (!player.spawned) { player.vy = 0; dy = 0; }   // hold still until the spawn chunk exists
  if (menuScene) { fwd = 0; str = 0; dy = 0; player.vy = 0; }   // title camera: rotation only
  if (fwd || str || dy) {
    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    let mdx = (str * cos - fwd * sin) * hSpeed * dt, mdz = (-fwd * cos - str * sin) * hSpeed * dt;
    // sneak edge-catch: cancel horizontal movement that would leave the player unsupported
    if (player.sneaking && (mdx || mdz)) {
      const p = player.pos;
      if (!onGroundAt(p.x + mdx, p.y, p.z + mdz)) {
        if (onGroundAt(p.x + mdx, p.y, p.z))       mdz = 0;
        else if (onGroundAt(p.x, p.y, p.z + mdz))  mdx = 0;
        else                                         mdx = mdz = 0;
      }
    }
    const wantY = player.pos.y + dy, x0 = player.pos.x, z0 = player.pos.z;
    movePlayer(mdx, dy, mdz);
    if (!player.flying && Math.abs(player.pos.y - wantY) > 1e-7) player.vy = 0;  // hit floor/ceiling
    // sprint drops when a wall stops us (moved <20% of the intended horizontal distance)
    const want2 = mdx * mdx + mdz * mdz;
    const got2 = (player.pos.x - x0) ** 2 + (player.pos.z - z0) ** 2;
    if (player.fast && want2 > 1e-8 && got2 < want2 * 0.04) player.fast = false;
  }
  // water current pushes the player (walking mode only; flying ignores it)
  if (!player.flying && player.spawned && !menuScene && inWater) {
    if (waterFlowVec(Math.floor(player.pos.x), Math.floor(player.pos.y + 0.4), Math.floor(player.pos.z), _flowV))
      movePlayer(_flowV.x * 1.7 * dt, 0, _flowV.z * 1.7 * dt);
  }
  // sprint also releases when movement input stops, and on any fly<->walk transition
  const movingNow = !!(fwd || str);
  player._movingH = movingNow ? 1 : 0;   // exposed for survival sprint-drain detection
  if (player.fast && wasMoving && !movingNow) player.fast = false;
  wasMoving = movingNow;
  if (player.flying !== lastFlying) { player.fast = false; lastFlying = player.flying; }

  // void safety: fell below the world -> teleport above terrain at this X/Z
  if (player.pos.y < -16) {
    const sy = surfaceY(Math.floor(player.pos.x), Math.floor(player.pos.z));
    player.pos.y = Math.max(sy + 2, WATER_Y + 3);
    player.vy = 0;
  }

  // one-time spawn snap once a valid spawn column is loaded. A loaded save restores the
  // exact player state instead, as soon as the chunk under the saved position exists.
  if (!player.spawned) {
    if (pendingRestore) {
      const c = getChunk(Math.floor(pendingRestore.pos[0] / 16), Math.floor(pendingRestore.pos[2] / 16));
      if (c && c.data) {
        const pr = pendingRestore; pendingRestore = null;
        player.pos.set(pr.pos[0], pr.pos[1], pr.pos[2]);
        if (typeof pr.yaw === 'number') player.yaw = pr.yaw;
        if (typeof pr.pitch === 'number') player.pitch = pr.pitch;
        player.hp         = typeof pr.hp         === 'number' ? pr.hp         : MAX_HP;
        player.food       = typeof (pr.food ?? pr.hunger) === 'number' ? (pr.food ?? pr.hunger) : MAX_FOOD;
        player.saturation = typeof pr.saturation  === 'number' ? pr.saturation  : MAX_SATURATION;
        player.flying = !!pr.flying && player.canFly;
        player.vy = 0; player.fallStart = null;
        player.spawnPos = Array.isArray(pr.spawnPos)
          ? new THREE.Vector3(pr.spawnPos[0], pr.spawnPos[1], pr.spawnPos[2]) : null;
        if (typeof pr.hotSel === 'number' && pr.hotSel >= 0 && pr.hotSel < 9) {
          hotbarSel = pr.hotSel; buildHotbar();
        }
        restoreDrops(pr.drops);
        player.spawned = true;
      }
    } else {
      const s = findValidSpawn();
      if (s) {
        player.pos.set(s.x, s.y, s.z);
        player.spawned = true;
        player.saturation = MAX_SATURATION;  // new world: start fully saturated
        if (!player.spawnPos) player.spawnPos = player.pos.clone();
      }
    }
  }

  if (menuScene) player.yaw += dt * 0.06;   // title panorama slowly circles the overlook

  camera.position.set(player.pos.x, player.pos.y + (player.sneaking ? 1.42 : player.EYE), player.pos.z);
  // hit kick: brief decaying pitch/roll wobble on damage (camShake set by hurtFlash in 19-vitals)
  let shP = 0, shR = 0;
  if (camShake.t > 0) {
    const k = camShake.t / camShake.dur;
    shP = Math.sin(camShake.t * 50) * camShake.amp * k;
    shR = Math.cos(camShake.t * 37) * camShake.amp * 0.6 * k;
    camShake.t -= dt;
  }
  camera.rotation.set(player.pitch + shP, player.yaw, shR);

  /* ---- break / place (mouse + gamepad share repeat timing) ---- */
  const wantBreak = (mouseBreak && pointerLocked) || act.padBreak;
  const wantPlace = (mousePlace && pointerLocked) || act.padPlace;

  // selection highlight
  updateInvCursorVisual(dt);                 // virtual cursor / drag ghost / slot hover
  const hit = (playing && !invOpen) ? currentRay() : null;
  selBox.visible = !!hit;
  if (hit) {
    const boxes = rayBoxesAt(hit.x, hit.y, hit.z);
    if (boxes && boxes.length) {
      let x0=1,y0=1,z0=1,x1=0,y1=0,z1=0;
      for (const b of boxes) { x0=Math.min(x0,b[0]); y0=Math.min(y0,b[1]); z0=Math.min(z0,b[2]);
                               x1=Math.max(x1,b[3]); y1=Math.max(y1,b[4]); z1=Math.max(z1,b[5]); }
      selBox.position.set(hit.x + (x0+x1)/2, hit.y + (y0+y1)/2, hit.z + (z0+z1)/2);
      selBox.scale.set(x1-x0, y1-y0, z1-z0);
    } else {
      selBox.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      selBox.scale.set(1, 1, 1);
    }
    selBox.updateMatrix();
  }

  // Single-press throw (edge: was not held last frame). Must run before doPlace calls.
  const _didThrow = (wantPlace && !act.place) ? tryThrow() : false;

  // Creative: instant break with 240ms repeat. Survival: progressive mining vs. hardness.
  const survivalMining = !player.canFly;
  if (survivalMining) {
    if (wantBreak && hit && PROPS[hit.id].hardness === 0 && PROPS[hit.id].raycast) {
      resetMining();
      if (!act.break || now - act.lastBreak > 240) {
        if (isTNTFuseActive(hit.x, hit.y, hit.z)) { act.lastBreak = now; }
        else {
        const minedId = getBlock(hit.x, hit.y, hit.z) & 255;
        setBlock(hit.x, hit.y, hit.z, B.AIR);
        queueWaterAround(hit.x, hit.y, hit.z);
        queueLavaAround(hit.x, hit.y, hit.z);
        for (const drop of blockDrop(minedId, false))
          for (let i = 0; i < drop.count; i++) spawnDrop(drop.id, hit.x, hit.y, hit.z);
        act.lastBreak = now;
        }
      }
    } else if (wantBreak && hit && Number.isFinite(PROPS[hit.id].hardness) && PROPS[hit.id].hardness > 0) {
      if (isTNTFuseActive(hit.x, hit.y, hit.z)) { resetMining(); }
      else
      if (!mining.active || mining.x !== hit.x || mining.y !== hit.y || mining.z !== hit.z
          || mining.bi !== (hit.bi || 0)          // aiming at the other half of a double slab restarts
          || mining.sel !== hotbarSel) {          // so does switching the held item (tool speed changes)
        mining.active = true;
        mining.x = hit.x; mining.y = hit.y; mining.z = hit.z; mining.bi = hit.bi || 0;
        mining.sel = hotbarSel;
        mining.elapsed = 0;
        // per user (2026-07-12): all break times shortened by 10% (multiplier 0.9).
        // right tool in hand (shovel/pickaxe/axe) divides the time further (1.5 = 50% faster).
        mining.needed = PROPS[hit.id].hardness * 0.9 / toolFactor(slotId(HOTBAR[hotbarSel]), hit.id);
        mining.stage = -1;
      }
      mining.elapsed += dt;
      const progress = Math.min(1, mining.elapsed / mining.needed);
      const stage = Math.min(9, Math.floor(progress * 10));
      if (stage !== mining.stage) { mining.stage = stage; drawCrack(progress); }
      const cboxes = rayBoxesAt(hit.x, hit.y, hit.z);
      if (cboxes && cboxes.length) {
        let x0=1,y0=1,z0=1,x1=0,y1=0,z1=0;
        for (const b of cboxes) { x0=Math.min(x0,b[0]); y0=Math.min(y0,b[1]); z0=Math.min(z0,b[2]);
                                   x1=Math.max(x1,b[3]); y1=Math.max(y1,b[4]); z1=Math.max(z1,b[5]); }
        crackMesh.position.set(hit.x + (x0+x1)/2, hit.y + (y0+y1)/2, hit.z + (z0+z1)/2);
        crackMesh.scale.set((x1-x0) * 1.004, (y1-y0) * 1.004, (z1-z0) * 1.004);
      } else {
        crackMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        crackMesh.scale.set(1.004, 1.004, 1.004);
      }
      crackMesh.visible = true;
      if (mining.elapsed >= mining.needed) {
        const mval = getBlock(mining.x, mining.y, mining.z), minedId = mval & 255;
        const mx = mining.x, my = mining.y, mz = mining.z, mbi = mining.bi || 0;
        resetMining();
        // tier gate: wrong/too-weak tool still breaks the block but yields no drops
        const dropsOk = mineDropAllowed(slotId(HOTBAR[hotbarSel]), minedId);
        const inf = slabBreakInfo(mval, mbi);     // double slab: break only the mined half
        if (inf) {
          setBlock(mx, my, mz, inf.remainVal);
          if (dropsOk) spawnDrop(inf.dropId, mx, my, mz);
        } else {
          setBlock(mx, my, mz, B.AIR);
          queueWaterAround(mx, my, mz);
          queueLavaAround(mx, my, mz);
          if (_isLog(minedId)) scheduleLeavesCheck(mx, my, mz);
          if (dropsOk)
            for (const drop of blockDrop(minedId, false))
              for (let i = 0; i < drop.count; i++) spawnDrop(drop.id, mx, my, mz);
        }
        // tool wear: every survival block broken with a tool in hand costs 1 durability
        const tslot = HOTBAR[hotbarSel];
        if (tslot && tslot.dur != null) {
          tslot.dur--;
          if (tslot.dur <= 0) { HOTBAR[hotbarSel] = null; toast(`${ITEM_PROPS[tslot.id].name} broke`); }
          saveHotbar(); buildHotbar(); updateHotbar();
        }
      }
    } else {
      resetMining();
    }
    // Place uses the same repeat-tap timing as creative.
    if (wantPlace && !_didThrow) { if (!act.place || now - act.lastPlace > 240) { doPlace(); act.lastPlace = now; } }
  } else {
    resetMining();
    if (wantBreak) { if (!act.break || now - act.lastBreak > 240) { doBreak(); act.lastBreak = now; } }
    if (wantPlace && !_didThrow) { if (!act.place || now - act.lastPlace > 240) { doPlace(); act.lastPlace = now; } }
  }
  act.break = wantBreak; act.place = wantPlace;

  /* ---- chunk streaming ---- */
  const cx = Math.floor(player.pos.x / 16), cz = Math.floor(player.pos.z / 16);
  if (cx !== playerCX || cz !== playerCZ) {
    playerCX = cx; playerCZ = cz;
    rebuildQueues();
  }
  applyMeshResults(_loadingWorld ? 48 : 12);
  pump();

  /* loading screen: dismiss once player has spawned and chunks within radius 4 are all ready */
  if (_loadingWorld && player.spawned) {
    let _ldDone = true;
    const _ldR = 4;
    outer: for (let ldz = -_ldR; ldz <= _ldR; ldz++) {
      for (let ldx = -_ldR; ldx <= _ldR; ldx++) {
        if (ldx * ldx + ldz * ldz > _ldR * _ldR) continue;
        const nc = getChunk(playerCX + ldx, playerCZ + ldz);
        if (!nc || !nc.data || nc.meshing || nc.queuedMesh) { _ldDone = false; break outer; }
      }
    }
    if (_ldDone && meshResults.length === 0) {
      _loadingWorld = false;
      worldLoadingEl.style.display = 'none';
    }
  }

  /* ---- held-block light: virtual glow source that follows the player ---- */
  {
    const slot = HOTBAR[hotbarSel];
    const id   = slot ? slot.id : null;
    const raw  = id === null ? 0 : id < 256 ? (PROPS[id]?.light ?? 0) : (ITEM_PROPS[id]?.light ?? 0);
    const hand = id === null ? null : id < 256 ? PROPS[id]?.handLight : ITEM_PROPS[id]?.handLight;
    const lvl  = (playing && player.spawned && raw > 0) ? (hand ?? Math.max(1, Math.round(raw * 0.65))) : 0;
    _hlRaw = raw;
    // Math.round for XZ: triggers 0.5 blocks early so mesh is ready when player arrives
    const px = Math.round(player.pos.x), py = Math.floor(player.pos.y + player.EYE), pz = Math.round(player.pos.z);
    if (lvl !== _hlLevel || id !== _hlId || px !== _hlX || py !== _hlY || pz !== _hlZ) {
      _hlId = id; _hlLevel = lvl; _hlX = px; _hlY = py; _hlZ = pz;
      updatePlayerLight(px, py, pz, lvl);
    }
  }

  /* ---- eating ---- */
  const eatProg = updateEating(dt, wantPlace);

  /* ---- survival: food drain, fall damage, respawn on death; also tick drops ---- */
  updateVitals(dt);
  processFalling(dt);
  if (!player.canFly) { updateDrops(dt); updateProjectiles(dt); processLeavesDecay(dt); }
  updateWaterFlow(dt);
  updateLavaFlow(dt);
  updateTNTs(dt);
  updateSaplings();
  processGrassSpread(dt);
  updateFurnaces(dt);
  updateDoors(dt);

  /* ---- sky, lighting & shadow maps, then the main render ---- */
  updateDayNight(dt);
  // underwater: dark blue murk — short fog, dark tint, dimmed ambient (restored when surfacing)
  {
    const eyeId = getBlock(Math.floor(camera.position.x), Math.floor(camera.position.y), Math.floor(camera.position.z)) & 255;
    const eyeWater = eyeId === B.WATER;
    const eyeLava  = eyeId === B.LAVA;
    if (eyeLava) {
      sharedUniforms.fogColor.value.set(0.72, 0.22, 0.0);
      renderer.setClearColor(sharedUniforms.fogColor.value);
      sharedUniforms.fogNear.value = 1;
      sharedUniforms.fogFar.value = 6;
      sharedUniforms.uAmbient.value = Math.min(sharedUniforms.uAmbient.value + 0.5, 1.0);
    } else if (eyeWater) {
      sharedUniforms.fogColor.value.multiplyScalar(0.45).lerp(_uwTint, 0.4);
      renderer.setClearColor(sharedUniforms.fogColor.value);
      sharedUniforms.fogNear.value = 5;
      sharedUniforms.fogFar.value = 36;
      sharedUniforms.uAmbient.value *= 0.78;
      sharedUniforms.uDirect.value *= 0.65;
    } else {
      const far = viewDist * 16;                 // restore surface fog range
      sharedUniforms.fogNear.value = far * 0.55;
      sharedUniforms.fogFar.value  = far * 0.98;
    }
  }
  renderer.render(scene, camera);
  /* ---- first-person hand (own depth buffer, always on top) ---- */
  updateHands(dt, wantBreak, wantPlace, eatProg);
  renderer.autoClear = false;
  renderer.clearDepth();
  /* hand scene: force neutral-bright uniforms so held items are never dark at night or in caves.
     Shadow coords (vSC) are in world space and meaningless for hand geometry, so disable shadow. */
  const _hsa = sharedUniforms.uAmbient.value, _hsd = sharedUniforms.uDirect.value, _hss = sharedUniforms.uShadowOn.value;
  _handSaveLC.copy(sharedUniforms.uLightColor.value);
  sharedUniforms.uAmbient.value = 1.0; sharedUniforms.uDirect.value = 0.0; sharedUniforms.uShadowOn.value = 0.0;
  sharedUniforms.uLightColor.value.set(1, 1, 1);
  renderer.render(handScene, handCam);
  sharedUniforms.uAmbient.value = _hsa; sharedUniforms.uDirect.value = _hsd; sharedUniforms.uShadowOn.value = _hss;
  sharedUniforms.uLightColor.value.copy(_handSaveLC);
  renderer.autoClear = true;

  /* ---- HUD (after the render so draw/tri stats reflect the main pass) ---- */
  hudT += dt;
  if (hudT > 0.15) {
    hudT = 0;
    const p = player.pos, info = renderer.info.render;
    const heading = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const cdir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
    const mins = ((worldTime * 24 + 6) % 24) * 60;          // clock: sunrise = 06:00
    const clock = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.floor(mins % 60)).padStart(2, '0')}`;
    hudEl.innerHTML =
      `FPS ${fps} / ${fpsLimit ? Math.min(fpsLimit, rafHz) : rafHz} &middot; ${player.flying ? 'flying' : (player._inWater ? 'swim' : 'walking')}${player.fast ? ' &middot; fast' : ''}${player.canFly ? '' : ' &middot; survival'}<br>` +
      `facing ${cdir} ${heading.toFixed(0)}&deg; &middot; ${clock} &middot; Day ${worldDay}<br>` +
      `XYZ ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}<br>` +
      `biome ${mainGen.biomeAt(Math.floor(p.x), Math.floor(p.z))}<br>` +
      `chunk ${cx} , ${cz} &middot; loaded ${chunks.size}<br>` +
      `seed ${SEED} &middot; dist ${viewDist} [ ]<br>` +
      `draws ${info.calls} &middot; tris ${(info.triangles / 1000).toFixed(0)}k`;
  }
}

