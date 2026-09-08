'use strict';
/* voxiCraft — per-frame update: movement, mining, drops, camera */

/* ================================================================================================
   MAIN LOOP
   ================================================================================================ */
/* ---- gravity blocks (sand, gravel) ---- */
const fallingBlocks = new Map();   // "x,y,z" -> full block VALUE (id + variant)
// a cell a falling block drops into: empty, or a billboard it simply crushes on the way through
const _fallOpen = (id) => id === B.AIR || PROPS[id]?.model === 'cross';
// Carpets fall too — snow and leaf litter both need ground under them, and digging out that
// ground used to leave a sheet of snow hanging in the air.
const _fallsUnderGravity = (id) =>
  id === B.SAND || id === B.RED_SAND || id === B.GRAVEL ||
  PROPS[id]?.model === 'carpet' || PROPS[id]?.model === 'carpet_stack';
function scheduleFall(x, y, z) {
  if (y < 1 || y > 199) return;
  const val = getBlock(x, y, z);
  if (!_fallsUnderGravity(val & 255)) return;
  // billboards don't hold up a falling block — they get crushed, so they count as empty here
  if (!_fallOpen(getBlock(x, y - 1, z) & 255)) return;
  fallingBlocks.set(`${x},${y},${z}`, val);        // keep the variant: carpets carry layer count
}
let _fallTimer = 0;
/* A single fall is TWO setBlocks, and clearing an opaque block re-floods sky light through the
   column — measured at ~4ms apiece for gravel. The old budget of 192 meant a tick could cost
   most of a second, so it is deliberately small now: a big collapse comes down over a couple of
   seconds instead of freezing the frame. */
const FALL_MAX_PER_TICK = 24;
/* ...and the queue is not allowed to clog. An entry that is out of simulation range is stepped
   over rather than acted on, but stepping over it still costs a scan, so the walk is bounded:
   past FALL_SCAN_LIMIT entries we stop looking this tick and pick up from the front next time.
   Entries that are simply stale (block already gone, or something solid slid in underneath) are
   DELETED on sight — leaving them is what let a few hundred dead keys sit at the head of the map
   and starve every live one behind them. */
const FALL_SCAN_LIMIT = 512;
function processFalling(dt) {
  _fallTimer += dt;
  if (_fallTimer < 0.08) return;
  _fallTimer -= 0.08;
  const todo = [];
  let scanned = 0;
  for (const [k, val] of fallingBlocks) {         // deleting during iteration is safe on a Map
    if (todo.length >= FALL_MAX_PER_TICK || ++scanned > FALL_SCAN_LIMIT) break;
    const [x, y, z] = k.split(',').map(Number);
    if (!inSimRange(x, z)) continue;              // frozen out of range — keep it queued
    if (getBlock(x, y, z) !== val) { fallingBlocks.delete(k); continue; }        // stale
    if (!_fallOpen(getBlock(x, y - 1, z) & 255)) { fallingBlocks.delete(k); continue; }  // landed
    fallingBlocks.delete(k);
    todo.push([x, y, z, val]);
  }
  for (const [x, y, z, val] of todo) {
    crushBillboard(x, y - 1, z);                 // torch/flower in the way is destroyed + dropped
    setBlock(x, y, z, B.AIR);
    setBlock(x, y - 1, z, val);                  // variant travels with it
  }
}

/* ---- simulation wake-up (0.7141) ----
   Fluids and gravity blocks are EVENT driven: a cell only ever moves because something queued it,
   and the only things that queue are setBlock and a neighbour's own tick. Terrain straight out of
   the generator has never been queued by anything — which is why a generated lava pool sat inert
   until an unrelated edit nearby happened to poke it (the light update that seemed to trigger it
   was incidental; ANY setBlock would have done), and why a snow carpet whose support a cave had
   eaten hung in the air.

   So the simulation radius seeds it. A chunk entering the radius is scanned once and every cell
   that could plausibly move is handed to the right queue; normal per-cell scheduling takes over
   from there.

   PERFORMANCE. The scan is 51 200 cells per chunk, far too much for one frame, so it is a
   RESUMABLE CURSOR: `_wake` holds the chunk and the y-layer reached, and each frame spends a
   fixed cell budget wherever it left off. Three things keep the per-cell cost near zero:
     - the id is classified by one Uint8Array lookup, so stone/dirt/air reject immediately;
     - neighbour reads go straight to the chunk's own array, using getBlock only on the four
       border columns;
     - settled sea water is never queued at all (see _WAKE_KIND).
   A full radius-6 region wakes in a few seconds, spread evenly, with no visible hitch. */
const _simWoken = new Set();              // "cx,cz" already scanned this session
let _wake = null;                         // resumable cursor: { cx, cz, d, y }
const WAKE_CELLS_PER_FRAME = 20000;       // ~2.5 frames per chunk at 60fps
/* 0 = never moves on its own, 2 = falls under gravity. One lookup replaces a chain of comparisons
   on the hot path, and the table is what makes a 20k-cell slice cost ~0.1ms.

   Only CARPETS are woken — snow and leaf litter, which is the "flying snow" case the seeding
   exists to fix. It is cheap (a carpet is not opaque, so removing one costs no sky relight) and
   self-limiting: the carpet falls once, lands, and is done.

   Two things are deliberately NOT woken:

   - Sand and gravel. The world is full of gravel lying over cave roofs; collapsing all of it the
     moment a chunk enters the radius cost ~4ms per block in sky relighting and rearranged terrain
     nobody asked to have rearranged.

   - Fluids. Waking generated lava does not make it settle into place — it makes it OSCILLATE.
     A woken cell flows outward, the new flowing cell fails the "still fed" test on its next tick
     and dries back, which re-seeds the neighbour that spawned it, and round it goes. Measured at
     ~30 lava writes and ~30 air writes a second forever, with the queue pinned at ~180 and never
     draining. Lava emits light 15, so every one of those writes re-floods light across several
     chunks: ~900 chunk re-meshes a second and roughly half the frame rate, while standing still.
     The oscillation is a fault in the fluid tick's feed rules, not in the seeding, and fixing it
     belongs to that code — see the note at the end of this response.

   Either kind still behaves exactly as it always has once you disturb it yourself: setBlock
   queues the neighbours, and the normal per-cell scheduling takes over. */
const _WAKE_KIND = new Uint8Array(256);
{
  for (let id = 0; id < 256; id++) {
    const m = PROPS[id]?.model;
    if (m === 'carpet' || m === 'carpet_stack') _WAKE_KIND[id] = 2;
  }
}
function clearSimWake() { _simWoken.clear(); _wake = null; _wakeIdle = false; }
// a chunk that just (re)arrived must be scanned again, whatever it did last time
function simWakeInvalidate(cx, cz) {
  _simWoken.delete(cx + ',' + cz);
  _wakeIdle = false;                                               // there is work again
  if (_wake && _wake.cx === cx && _wake.cz === cz) _wake = null;   // cursor's array is stale
}

/* Once every chunk in range is seeded, the ring search below finds nothing — but it still walks
   the whole radius to prove it, every single frame, forever. `_wakeIdle` latches that result and
   is cleared by the only two things that can invalidate it: crossing a chunk border, and a chunk
   arriving (simWakeInvalidate). Standing still therefore costs nothing at all. */
let _wakeIdle = false, _wakeIdleKey = '';
// the latch key must name EVERY player's chunk — one of them moving is new work (0.72)
const _wakeKey = () => PLAYER_CHUNKS.map(p => p[0] + ',' + p[1]).join(';');
// pick the nearest un-woken loaded chunk inside the radius; false when there is nothing to do
function _beginNextWake() {
  const wk = _wakeKey();
  if (_wakeIdle && _wakeIdleKey === wk) return false;
  const r = simDist();
  for (let ring = 0; ring <= r; ring++)
    for (const pc of PLAYER_CHUNKS)
      for (let dz = -ring; dz <= ring; dz++)
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;      // ring shell only
          if (dx * dx + dz * dz > r * r) continue;
          const cx = pc[0] + dx, cz = pc[1] + dz;
          if (_simWoken.has(cx + ',' + cz)) continue;
          const c = getChunk(cx, cz);
          if (!c || !c.data) continue;                  // not streamed in yet — try again later
          _wake = { cx, cz, d: c.data, y: 1 };
          return true;
        }
  _wakeIdle = true; _wakeIdleKey = wk;
  return false;
}
// scan up to `budget` cells of the current chunk; returns how many were actually spent
function _scanWakeSlice(budget) {
  const w = _wake, d = w.d, wx0 = w.cx * 16, wz0 = w.cz * 16;
  // the chunk may have unloaded (or been rebuilt) since the cursor was opened
  const c = getChunk(w.cx, w.cz);
  if (!c || c.data !== d) { _wake = null; return budget; }
  const openAt = (lx, y, lz) => {
    if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16 && y >= 0 && y < 200)
      return _fallOpen(d[lx + (lz << 4) + (y << 8)] & 255);
    return _fallOpen(getBlock(wx0 + lx, y, wz0 + lz) & 255);
  };
  let used = 0;
  while (w.y < 200 && used < budget) {
    const base = w.y << 8;
    for (let i = 0; i < 256; i++) {
      const raw = d[base + i], id = raw & 255;
      /* Emitters first. Registering is idempotent — a Set add — and it is the insurance that
         makes the re-light below actually have something to pour: a torch inside a structure
         stamped while the chunk was out of range is in the world but may never have reached
         glowLights, and unregistered emitters are exactly why those torches sat dark. */
      if (EMITTER_ID[id] && blockLightOf(raw) > 0)
        glowAdd(wx0 + (i & 15), w.y, wz0 + ((i >> 4) & 15));
      if (_WAKE_KIND[id] !== 2) continue;
      const lx = i & 15, lz = (i >> 4) & 15;
      if (openAt(lx, w.y - 1, lz)) scheduleFall(wx0 + lx, w.y, wz0 + lz);
    }
    used += 256;
    w.y++;
  }
  if (w.y >= 200) {
    /* Chunk fully scanned: every emitter in it is registered, so pour block light in now. This is
       the step that lights a structure's torches — chunk load already tried, but at the time the
       chunk was outside the simulation radius and relightForChunk correctly declined.

       Then RE-MESH the neighbourhood, which is the part that actually makes it visible.
       propagateLight only writes into the light arrays; it marks nothing dirty, because its other
       caller (relight) marks the affected box itself and its remaining caller (chunk load) runs
       before the chunk has ever been meshed. Here the chunks are already on screen with stale
       vertex light, so without this the torch data says 15 and the picture stays black — which is
       exactly what you were looking at. A source reaches GLOW_LEVEL blocks, under one chunk, so
       the 3x3 ring around the woken chunk is the full blast radius. */
    relightForChunk(w.cx, w.cz);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const n = getChunk(w.cx + dx, w.cz + dz);
        if (n && n.data) markDirty(n);
      }
    _simWoken.add(w.cx + ',' + w.cz);
    _wake = null;
  }
  return used;
}
function updateSimWake() {
  if (menuScene || !player.spawned) return;
  let budget = WAKE_CELLS_PER_FRAME;
  while (budget > 0) {
    if (!_wake && !_beginNextWake()) return;       // nothing left in range to seed
    budget -= _scanWakeSlice(budget);
  }
}

/* ---- leaves natural decay ---- */
const leavesDecayQueue = new Set();
const DECAY_DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

const _isLeaf = (id) => id === B.LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES;
// stripped logs count as support: a half-chopped tree must not shed its canopy while you work
const _isLog  = (id) => id === B.LOG || id === B.BIRCH_LOG || id === B.SPRUCE_LOG ||
                        id === B.STRIPPED_SPRUCE_LOG ||
                        id === B.STRIPPED_LOG || id === B.STRIPPED_BIRCH_LOG;
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
const DECAY_INTERVAL = 0.2;      // was 0.5 — an orphaned canopy should clear while you watch
const DECAY_BATCH = 24;          // was 8
function processLeavesDecay(dt) {
  leavesDecayTimer += dt;
  if (leavesDecayTimer < DECAY_INTERVAL) return;
  leavesDecayTimer -= DECAY_INTERVAL;
  const toProcess = [];
  for (const k of leavesDecayQueue) {
    if (toProcess.length >= DECAY_BATCH) break;
    if (!_keyInSimRange(k)) continue;      // stays queued until the player is back in range
    toProcess.push(k);
  }
  for (const key of toProcess) {
    leavesDecayQueue.delete(key);
    const [x, y, z] = key.split(',').map(Number);
    const leafId = getBlock(x, y, z) & 255;
    if (!_isLeaf(leafId)) continue;
    if (!isLeavesConnected(x, y, z)) {
      // base decay chance, then scaled by the world tick speed
      if (Math.random() < 0.3 * tickFactor()) {
        // decayed leaves fall the same way a felled canopy does, so they end up as litter on
        // the ground instead of evaporating in place
        setBlock(x, y, z, B.AIR);
        if (FALLING.length < MAX_FALLING) spawnFallingLeaf(leafId, x, y, z);
        else settleLeafNow(leafId, x, y, z);
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
    if (!inSimRange(x, z)) continue;             // dark-cover clock pauses outside the sim radius
    if ((getBlock(x, y, z) & 255) !== B.GRASS || !PROPS[getBlock(x, y + 1, z) & 255].opaque) { _darkGrass.delete(k); continue; }
    const nt = t + interval;
    if (nt >= DAY_LEN) { setBlock(x, y, z, B.DIRT); _darkGrass.delete(k); }
    else _darkGrass.set(k, nt);
  }
}

/* ---- throwing ---- */
// blocks whose right-click opens a GUI or actuates something; throwing must yield to them
const THROW_BLOCKED_BY = new Set([B.CRAFTING_BENCH, B.FURNACE, B.CHEST, B.DOOR, B.BED,
                                  B.STRUCTURE_BLOCK]);
function tryThrow() {
  if (!playing || player.canFly || invOpen || menuScene) return false;
  const slot = HOTBAR[hotbarSel];
  if (!slot || !ITEM_PROPS[slot.id]?.throwable) return false;
  /* A right-click aimed at something that OPENS must interact, not throw — otherwise a stack of
     snowballs in hand locks you out of your own furnace. doPlace() handles these same ids. */
  const aimed = currentRay();
  if (aimed && THROW_BLOCKED_BY.has(aimed.id)) return false;
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
var _eatTimer = 0;
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

/* ---- fluid flow simulation ----
   Cells are scheduled INDIVIDUALLY, not batch-throttled: the queue is a Map of
   "x,y,z" -> the sim time at which that cell may act. A cell that spreads schedules its
   children one STEP later, so the visible advance rate is exactly one block per STEP along
   each branch regardless of how many cells are pending. (The old global batch cap made a
   large settled pool starve the actual flow frontier, which stalled flat spreads.) */
let _fluidClock = 0;
const _waterQueue = new Map();
const WATER_STEP = 0.4;                   // seconds per block of advance (at random tick 3)
const DRY_SPEEDUP = 2.5;                  // drying propagates this much faster than flowing
const waterStep = () => WATER_STEP / tickFactor();
const waterDry  = () => WATER_STEP / (tickFactor() * DRY_SPEEDUP);

// schedule a water cell; `delay` defaults to one full step. An earlier pending time wins.
function queueWaterAt(x, y, z, delay = waterStep()) {
  if ((getBlock(x, y, z) & 255) !== B.WATER) return;
  const k = `${x},${y},${z}`, t = _fluidClock + delay;
  const prev = _waterQueue.get(k);
  if (prev === undefined || t < prev) _waterQueue.set(k, t);
}
function queueWaterAround(x, y, z, delay = waterStep()) {
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])
    queueWaterAt(x + dx, y + dy, z + dz, delay);
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
// A source was removed: seed the scheduler at the hole. The per-cell tick drops every cell that
// has lost its feed and re-seeds its own neighbours, so the flow recedes one ring per dry step
// instead of vanishing in a single frame.
function dryWaterFrom(sx, sy, sz) {
  queueWaterAround(sx, sy, sz, waterDry());
}
const WATER_MAX_PER_TICK = 256;           // safety valve only; timing comes from per-cell schedule
// "x,y,z" key -> is that cell inside the simulation radius? (cheap: only the two horizontal parts)
function _keyInSimRange(k) {
  const i = k.indexOf(','), j = k.lastIndexOf(',');
  return inSimRange(+k.slice(0, i), +k.slice(j + 1));
}
/* A cell outside the radius keeps its place in the queue AND its due time, but it must not sit
   at the front costing a scan every single frame — walk a few thousand blocks and the drain loop
   would be stepping over ten thousand frozen entries before reaching a live one. Deleting and
   re-inserting moves it to the BACK of the map's insertion order, so the front always advances
   and the scan stays bounded. Nothing is lost: same key, same due time. */
function _deferFluid(q, k, t) { q.delete(k); q.set(k, t); }
const FLUID_SCAN_LIMIT = 1024;            // entries stepped over per tick before we give up
// Water must always tick before lava in a frame: lava is the slower fluid and its
// water-contact rule (obsidian/stone) has to see water's moves from this same frame, not the
// previous one. updateFluids() enforces that order and owns the shared clock.
function updateFluids(dt) {
  _fluidClock += dt;
  updateWaterFlow();
  updateLavaFlow();
}
function updateWaterFlow() {
  if (_waterQueue.size === 0) return;
  const todo = [];
  const defer = [];
  let scanned = 0;
  for (const [k, t] of _waterQueue) {
    if (++scanned > FLUID_SCAN_LIMIT) break;
    if (t > _fluidClock) continue;
    // outside the simulation radius: not acted on, pushed to the back of the queue instead.
    // Walk back into range and the flow picks up exactly where it left off.
    if (!_keyInSimRange(k)) { defer.push([k, t]); continue; }
    todo.push(k);
    if (todo.length >= WATER_MAX_PER_TICK) break;
  }
  for (const [k, t] of defer) _deferFluid(_waterQueue, k, t);
  for (const k of todo) _waterQueue.delete(k);
  for (const key of todo) {
    const [x, y, z] = key.split(',').map(Number);
    const val = getBlock(x, y, z);
    if ((val & 255) !== B.WATER) continue;
    const level = (val >> 8) & 15;
    // flowing cell that lost its feed (source removed or path cut by a placed block) dries up,
    // and the dry-out propagates outward so no orphaned puddle is left behind
    if (!_waterFed(x, y, z, level)) { setBlock(x, y, z, B.AIR); queueWaterAround(x, y, z, waterDry()); continue; }
    // funnel retract: any upstream neighbour (lower level, same y) that is draining downward
    // means this cell is a wasted sideways branch and must dry back. Chains outward one cell
    // per tick, so a hole opened anywhere upstream collapses the whole horizontal spread.
    if (level > 0) {
      let retract = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nv = getBlock(x + dx, y, z + dz);
        if ((nv & 255) !== B.WATER) continue;
        if (((nv >> 8) & 15) >= level) continue;                       // must be upstream
        if (!_hasFluidFloor(B.WATER, x + dx, y, z + dz)) { retract = true; break; }
      }
      if (retract) { setBlock(x, y, z, B.AIR); queueWaterAround(x, y, z, waterDry()); continue; }
    }
    // Fluid reactions are owned by whichever fluid is MOVING — the new block lands on the cell
    // that was standing still. Here that means only FLOWING water reacts on its own cell (it
    // runs into lava and freezes to stone). A resting source is left alone: the lava tick
    // handles that pairing so the cobblestone appears on the water, not on the lava.
    if (level > 0 && _hasFluidFloor(B.WATER, x, y, z)) {
      let touched = false;
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        if ((getBlock(x + dx, y + dy, z + dz) & 255) === B.LAVA) { touched = true; break; }
      }
      if (touched) { setBlock(x, y, z, B.STONE); continue; }
    }
    // ALWAYS flow down before considering sideways. A cell whose own floor is open (or holds
    // thinner water it can top up) drops and does nothing else this tick. When it drops it also
    // retracts any downstream (higher-level) horizontal sibling — those sideways branches only
    // existed because there was no downward path; now there is, so they're wasted and must dry.
    if (y > 0) {
      const bVal = getBlock(x, y - 1, z), bId = bVal & 255;
      const openBelow = bId === B.AIR || _isFluidPassable(bId);
      const thinBelow = bId === B.WATER && ((bVal >> 8) & 15) > level;
      if (openBelow || thinBelow) {
        if (openBelow && bId !== B.AIR) _breakBillboard(x, y - 1, z, bId);
        setBlock(x, y - 1, z, B.WATER | (level << 8));
        queueWaterAt(x, y - 1, z);
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, nz = z + dz;
          const nv = getBlock(nx, y, nz);
          if ((nv & 255) === B.WATER && ((nv >> 8) & 15) > level) {
            setBlock(nx, y, nz, B.AIR);
            queueWaterAround(nx, y, nz, waterDry());
          }
        }
        continue;
      }
    }
    // horizontal spread at level+1 (capped at 7). Requires a real floor: a cell standing on
    // air/plants/its own fluid is still draining and must never creep sideways.
    // Funnel priority: if any candidate has an open cell below (would drop), spread ONLY into
    // those — prevents fluid from overflowing a plateau when a hole is right next to it.
    if (level < 7 && _hasFluidFloor(B.WATER, x, y, z)) {
      const cands = [];
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, nz = z + dz;
        const nb = getBlock(nx, y, nz);
        const nbId = nb & 255;
        if (nbId !== B.AIR && !_isFluidPassable(nbId) && !(nbId === B.WATER && level + 1 < ((nb >> 8) & 15))) continue;
        const bv = getBlock(nx, y - 1, nz), below = bv & 255;
        const holed = below === B.AIR || _isFluidPassable(below)
                   || (below === B.WATER && ((bv >> 8) & 15) > level + 1);
        cands.push({ nx, nz, nbId, holed });
      }
      const anyHoled = cands.some(c => c.holed);
      for (const c of cands) {
        if (anyHoled && !c.holed) continue;
        if (c.nbId !== B.AIR && _isFluidPassable(c.nbId)) _breakBillboard(c.nx, y, c.nz, c.nbId);
        setBlock(c.nx, y, c.nz, B.WATER | ((level + 1) << 8));
        queueWaterAt(c.nx, y, c.nz);
      }
      // re-check self later: if a neighbouring edit opens the floor under this cell, it must
      // fall rather than keep creeping sideways
      if (cands.length) queueWaterAt(x, y, z);
    }
  }
}
// A fluid cell may only spread sideways when it stands on a REAL floor. Air and sweepable
// billboards are obviously not floors — but neither is the same fluid: a cell sitting on its
// own kind is still draining downward, and letting it creep sideways is what made water walk
// past a hole that had just been opened under it.
function _hasFluidFloor(fluidId, x, y, z) {
  if (y <= 0) return true;
  const bId = getBlock(x, y - 1, z) & 255;
  if (bId === B.AIR || _isFluidPassable(bId) || bId === fluidId) return false;
  return true;
}
// billboards (cross model — plants, flowers, torches, saplings, cane, sulfur tips) get swept
// away by advancing fluids. Excludes cactus (solid stack) and non-cross things.
function _isFluidPassable(id) {
  const p = PROPS[id];
  return !!p && p.model === 'cross';
}
function _breakBillboard(x, y, z, id) {
  if (!player.canFly)
    for (const d of blockDrop(id, true)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, y, z);
}

/* ---- lava flow simulation (same as water but much slower, max spread level 4) ---- */
const _lavaQueue = new Map();
const LAVA_STEP = WATER_STEP * 5;             // 5× slower than water, per block of advance
const lavaStep = () => LAVA_STEP / tickFactor();
const lavaDry  = () => LAVA_STEP / (tickFactor() * DRY_SPEEDUP);

function queueLavaAt(x, y, z, delay = lavaStep()) {
  if ((getBlock(x, y, z) & 255) !== B.LAVA) return;
  const k = `${x},${y},${z}`, t = _fluidClock + delay;
  const prev = _lavaQueue.get(k);
  if (prev === undefined || t < prev) _lavaQueue.set(k, t);
}
function queueLavaAround(x, y, z, delay = lavaStep()) {
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])
    queueLavaAt(x + dx, y + dy, z + dz, delay);
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
// mirror of dryWaterFrom: seed the scheduler so lava recedes at its own (slower) dry rate
function dryLavaFrom(sx, sy, sz) {
  queueLavaAround(sx, sy, sz, lavaDry());
}
const LAVA_MAX_PER_TICK = 128;            // safety valve only; timing comes from per-cell schedule
function updateLavaFlow() {
  // clock is advanced by updateFluids(), which runs water first
  if (_lavaQueue.size === 0) return;
  const todo = [];
  const defer = [];
  let scanned = 0;
  for (const [k, t] of _lavaQueue) {
    if (++scanned > FLUID_SCAN_LIMIT) break;
    if (t > _fluidClock) continue;
    if (!_keyInSimRange(k)) { defer.push([k, t]); continue; }   // frozen out of range, as water
    todo.push(k);
    if (todo.length >= LAVA_MAX_PER_TICK) break;
  }
  for (const [k, t] of defer) _deferFluid(_lavaQueue, k, t);
  for (const k of todo) _lavaQueue.delete(k);
  for (const key of todo) {
    const [x, y, z] = key.split(',').map(Number);
    const val = getBlock(x, y, z);
    if ((val & 255) !== B.LAVA) continue;
    const level = (val >> 8) & 15;
    // funnel retract: mirror of the water rule, kills wasted sideways branches as soon as any
    // upstream neighbour starts draining downward
    if (level > 0) {
      let retract = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nv = getBlock(x + dx, y, z + dz);
        if ((nv & 255) !== B.LAVA) continue;
        if (((nv >> 8) & 15) >= level) continue;
        if (!_hasFluidFloor(B.LAVA, x + dx, y, z + dz)) { retract = true; break; }
      }
      if (retract) { setBlock(x, y, z, B.AIR); queueLavaAround(x, y, z, lavaDry()); continue; }
    }
    // Lava meets water. A lava SOURCE quenches into obsidian in place. FLOWING lava is the
    // moving side, so the reaction lands on the standing water instead: every water cell it has
    // reached chills into cobblestone and the lava itself keeps going.
    {
      const hits = [];
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const wx = x + dx, wy = y + dy, wz = z + dz;
        if ((getBlock(wx, wy, wz) & 255) === B.WATER) hits.push([wx, wy, wz]);
      }
      if (hits.length) {
        if (level === 0) { setBlock(x, y, z, B.OBSIDIAN); continue; }
        for (const [wx, wy, wz] of hits) {
          setBlock(wx, wy, wz, B.COBBLE);
          queueWaterAround(wx, wy, wz, waterDry());
        }
        queueLavaAt(x, y, z);
        continue;
      }
    }
    if (!_lavaFed(x, y, z, level)) { setBlock(x, y, z, B.AIR); queueLavaAround(x, y, z, lavaDry()); continue; }
    // ALWAYS flow down before sideways (see the water version for the rationale + retract rule)
    if (y > 0) {
      const bVal = getBlock(x, y - 1, z), bId = bVal & 255;
      const openBelow = bId === B.AIR || _isFluidPassable(bId);
      const thinBelow = bId === B.LAVA && ((bVal >> 8) & 15) > level;
      if (openBelow || thinBelow) {
        if (openBelow && bId !== B.AIR) _breakBillboard(x, y - 1, z, bId);
        setBlock(x, y - 1, z, B.LAVA | (level << 8));
        queueLavaAt(x, y - 1, z);
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, nz = z + dz;
          const nv = getBlock(nx, y, nz);
          if ((nv & 255) === B.LAVA && ((nv >> 8) & 15) > level) {
            setBlock(nx, y, nz, B.AIR);
            queueLavaAround(nx, y, nz, lavaDry());
          }
        }
        continue;
      }
    }
    if (level < 4 && _hasFluidFloor(B.LAVA, x, y, z)) {
      const cands = [];
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, nz = z + dz;
        const nb = getBlock(nx, y, nz);
        const nbId = nb & 255;
        if (nbId !== B.AIR && !_isFluidPassable(nbId) && !(nbId === B.LAVA && level + 1 < ((nb >> 8) & 15))) continue;
        const bv = getBlock(nx, y - 1, nz), below = bv & 255;
        const holed = below === B.AIR || _isFluidPassable(below)
                   || (below === B.LAVA && ((bv >> 8) & 15) > level + 1);
        cands.push({ nx, nz, nbId, holed });
      }
      const anyHoled = cands.some(c => c.holed);
      for (const c of cands) {
        if (anyHoled && !c.holed) continue;
        if (c.nbId !== B.AIR && _isFluidPassable(c.nbId)) _breakBillboard(c.nx, y, c.nz, c.nbId);
        setBlock(c.nx, y, c.nz, B.LAVA | ((level + 1) << 8));
        queueLavaAt(c.nx, y, c.nz);
      }
      if (cands.length) queueLavaAt(x, y, z);
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
  if (_isLeaf(cur) || cur === B.AIR) setBlock(x, y, z, id);
}
function _growTree(x, y, z, species) {
  const isBirch = species === B.BIRCH_SAPLING, isSpruce = species === B.SPRUCE_SAPLING;
  const LOG  = isSpruce ? B.SPRUCE_LOG : isBirch ? B.BIRCH_LOG : B.LOG;
  const LEAF = isSpruce ? B.SPRUCE_LEAVES : isBirch ? B.BIRCH_LEAVES : B.LEAVES;
  // a grown spruce is a cone like the generated ones, not the round oak blob
  if (isSpruce) {
    // same cone the world generator builds: tapering spike, heavy skirt low, always tipped
    const sh = 13 + Math.floor(Math.random() * 7);     // 13..19
    const SPR_STUMP = 30, SPR_TIP = 14;
    for (let k = 0; k < sh; k++) {
      const t = k / Math.max(1, sh - 1);
      const w = Math.round(SPR_STUMP - (SPR_STUMP - SPR_TIP) * t);
      const val = LOG | ((w << 2) << 8);
      if (k === 0) setBlock(x, y, z, val); else _putSoft(x, y + k, z, val);
    }
    const base = y + 2, topY = y + sh - 1, span = Math.max(1, topY - base);
    for (let ly = base; ly <= topY; ly++) {
      const t = (ly - base) / span;
      let rad = Math.max(1, Math.round(4 - 3.2 * t));
      if (((ly - base) % 2) === 1) rad = Math.max(1, rad - 1);
      const rimKeep = 0.85 - 0.5 * t;
      for (let oz = -rad; oz <= rad; oz++)
        for (let ox = -rad; ox <= rad; ox++) {
          const d = Math.abs(ox) + Math.abs(oz);
          if (d > rad || (d === rad && Math.random() > rimKeep)) continue;
          _putSoft(x + ox, ly, z + oz, LEAF);
        }
    }
    for (let t = 1; t <= 2; t++) _putSoft(x, topY + t, z, LEAF);
    return;
  }
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
      _growTree(x, y, z, r.type);
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
var wasMoving = false, lastFlying = player.flying;   // sprint auto-release tracking

// held-light state: track last-known position + item to detect changes
var _hlId = undefined, _hlLevel = 0, _hlX = null, _hlY = null, _hlZ = null;
var _hlRaw = 0;  // raw light value of current held item (exposed for arm glow in 24-hands.js)
const _handSaveLC = new THREE.Color();  // reusable save slot for uLightColor during hand render

function frame(now) {
  requestAnimationFrame(frame);
  if (fpsLimit > 0 && now - lastT < 1000 / fpsLimit - 2) return;   // fps cap: skip whole tick
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  sharedUniforms.uTime.value += dt;
  updateMusic();                            // menu track on/off follows menuScene
  /* Input routing, before anybody is ticked: which pad drives which seat, and — while the player
     is rebinding from the pause menu — whether a device has just spoken up. Both run whether or
     not the game is unpaused, because binding is done with the menu open. */
  pollInputCapture();
  /* The title panorama is scenery, not a world (0.7144). Nothing in it is meant to change: no
     rot, no melt, no regrowth, no felling, no structures assembling, no leaves coming down. Each
     of these was individually harmless there — their queues are empty on a backdrop — but they
     were still called every frame, and gating them in one place makes the rule explicit rather
     than relying on each system to notice where it is. Boot spends its frames on the panorama. */
  if (!menuScene) {
    updateFelling(dt);                      // felled trunks come apart a few cells per tick
    updateLitterRot(dt);                    // fallen leaves rot off the forest floor
    updateSnowMelt(dt);                     // snow outside a cold biome thins away a layer at a time
    updateBerryGrow(dt);                    // picked berry bushes ripen again, one stage at a time
    updateStructOutline();                  // drop the capture box if its block was broken
    processPlacementQueue();                // villages/dungeons assemble a few cells per frame
    updateFallingLeaves(dt);                // canopy coming down after a tree was felled
  }

  // fps
  fpsFrames++;
  if (now - fpsT >= 500) { fps = Math.round(fpsFrames * 1000 / (now - fpsT)); fpsFrames = 0; fpsT = now; }

  /* ---- each player, in their own context (0.72) ----
     `useSlot` repoints `player`, `camera`, the hotbar, the arm rig and the HUD at one player, so
     everything inside tickPlayer is the same single-player code it always was. The WORLD is then
     stepped exactly once afterwards, never once per player. */
  for (let i = 0; i < PSTATE.length; i++) { useSlot(i); tickPlayer(dt, now, i); }
  useSlot(0);
  runWorldTick(dt, now);
}

/* ================================================================================================
   PER-PLAYER TICK — input, movement, camera, targeting, mining/placing, vitals, hand.
   Runs once per player per frame with that player's globals installed.
   ================================================================================================ */
function tickPlayer(dt, now, slot) {
  const kbOwner = slot === 0;               // keyboard and mouse belong to player one only
  /* ---- input & movement ---- */
  const _preYaw = player.yaw, _prePitch = player.pitch;
  const gp = pollGamepad(dt);
  if (player.dead) {                        // dead: no look (mouse gated in input, pad undone here),
    player.yaw = _preYaw; player.pitch = _prePitch;   // no movement, no fly/jump input
    gp.mx = gp.mz = 0; gp.up = gp.dn = false;
  }
  const kb = kbOwner && playing && !invOpen && !player.dead;   // keyboard steers when no menu/inventory is open
  let fwd = (kb && keys.KeyW ? 1 : 0) - (kb && keys.KeyS ? 1 : 0) - gp.mz;
  let str = (kb && keys.KeyD ? 1 : 0) - (kb && keys.KeyA ? 1 : 0) + gp.mx;
  const upHeld = (kb && keys.Space) || gp.up;
  const dnHeld = (kb && (keys.ShiftLeft || keys.ShiftRight)) || gp.dn;
  const fast   = player.fast;
  const len = Math.hypot(fwd, str);
  if (len > 1) { fwd /= len; str /= len; }

  /* ---- lying in a bed (0.7294) ----
     Sneak is the only control that still means anything: it gets you back up. Everything else is
     zeroed below, next to the title-screen case, so the body stays pinned to the mattress. The
     look stick stays live so you can glance around from the pillow. */
  if (player.sleepingAt && dnHeld) leaveBed(player);
  const lying = !!player.sleepingAt;
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
    hSpeed = player.walkSpeed * (player.sneaking ? 0.3 : fast ? (inWater ? 1.9 : 1.6) : 1) * (inWater ? 0.45 : 1)
           * playerMoveSpeedMul()                // heavy armor slows you down
           * terrainSpeedMul();                  // leaves/litter -40%, snow carpet -70%
  }
  if (!player.spawned) { player.vy = 0; dy = 0; }   // hold still until the spawn chunk exists
  if (menuScene) { fwd = 0; str = 0; dy = 0; player.vy = 0; }   // title camera: rotation only
  if (lying) {                                  // asleep: pinned to the mattress, look only
    fwd = 0; str = 0; dy = 0; player.vy = 0; player.sneaking = false; player._movingH = 0;
    const s = player.sleepingAt, d = BED_DIR[s.facing & 3];
    player.pos.set(s.x + 0.5 + d[0] * 0.5, s.y + BED_H, s.z + 0.5 + d[1] * 0.5);
  }
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
  updateFootsteps(grounded);
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
    // Players two and up either restore from the save (once the ground under their stored
    // position has streamed in) or, having none, step out next to player one.
    if (slot > 0) {
      /* A saved player WAITS for their own chunk — the fallback seat next to player one must
         never win that race, or their inventory and position would be silently thrown away the
         moment player one happened to spawn a frame earlier. */
      if (!applyExtraPlayerRestore(slot) && !hasPendingExtraRestore(slot) && PLAYERS[0].spawned)
        seatNewPlayer(player);
    } else if (pendingRestore) {
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
        // the world spawn and which bed (if any) currently overrides it — see releaseBedSpawns
        player.homeSpawn = Array.isArray(pr.homeSpawn)
          ? new THREE.Vector3(pr.homeSpawn[0], pr.homeSpawn[1], pr.homeSpawn[2])
          : (player.spawnPos ? player.spawnPos.clone() : null);   // pre-0.7341 save: best guess
        player.spawnBedKey = pr.spawnBedKey || null;
        if (typeof pr.hotSel === 'number' && pr.hotSel >= 0 && pr.hotSel < HOTBAR_SLOTS) {
          hotbarSel = pr.hotSel; buildHotbar();
        }
        player.spawned = true;
      }
    } else {
      const s = findValidSpawn();
      if (s) {
        player.pos.set(s.x, s.y, s.z);
        player.spawned = true;
        player.saturation = MAX_SATURATION;  // new world: start fully saturated
        if (!player.spawnPos) player.spawnPos = player.pos.clone();
        // the world spawn, kept apart from spawnPos so a broken bed has somewhere to fall back to
        if (!player.homeSpawn) player.homeSpawn = player.pos.clone();
      }
    }
  }
  /* Loose drops and wandering mobs belong to the WORLD, not to whoever is in seat one — a profile
     opening this world for the first time has no record of its own, so restoring them alongside a
     player's spawn (as it used to be) would have quietly lost them. */
  if (slot === 0 && pendingWorldRestore && player.spawned) {
    const pw = pendingWorldRestore; pendingWorldRestore = null;
    restoreDrops(pw.drops);
    restoreEntities(pw.entities);
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
  applyCameraView(dt);            // F5 third-person: moves the camera back + shows the body

  /* ---- break / place (mouse + gamepad share repeat timing) ---- */
  // in bed you can look around and nothing else — no swinging, no placing, no eating
  const wantBreak = !lying && ((mouseBreak && pointerLocked) || act.padBreak);
  const wantPlace = !lying && ((mousePlace && pointerLocked) || act.padPlace);
  // selection highlight
  updateInvCursorVisual(dt);                 // this seat's cursor / drag ghost / hover / tooltip
  const hit = (playing && !invOpen) ? currentRay() : null;

  // Swinging at a mob takes priority over the block behind it. Priority is decided by AIM alone,
  // never by the attack cooldown — gating it on tryAttackEntity() meant every swing after the
  // first (while still on cooldown) fell through to the block code and mined straight through
  // the mob. wantBreak still drives the hand swing so the attack animates.
  const _entAim = (playing && !invOpen) ? pickEntityHit() : null;
  const _entPriority = entityBeatsBlock(_entAim, hit);
  if (wantBreak && _entPriority) tryAttackEntity(_entAim.ent);
  const wantMine = wantBreak && !_entPriority;
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

  updateInteractPrompt();                   // "(E) to pickup grass" under the crosshair
  // bush pickup: held on KeyE or pad North, repeating on its own short cooldown
  updateBushPickup(dt, (playing && !invOpen && !menuScene) && ((kbOwner && !!keys['KeyE']) || act.padPick));

  // Single-press throw (edge: was not held last frame). Must run before doPlace calls.
  const _didThrow = (wantPlace && !act.place) ? tryThrow() : false;

  // Creative: instant break with 240ms repeat. Survival: progressive mining vs. hardness.
  const survivalMining = !player.canFly;
  if (survivalMining) {
    if (wantMine && hit && PROPS[hit.id].hardness === 0 && PROPS[hit.id].raycast) {
      resetMining();
      if (!act.break || now - act.lastBreak > 240) {
        if (isTNTFuseActive(hit.x, hit.y, hit.z)) { act.lastBreak = now; }
        else {
        const minedId = getBlock(hit.x, hit.y, hit.z) & 255;
        playBlockSound(minedId, 'break', hit.x, hit.y, hit.z);
        setBlock(hit.x, hit.y, hit.z, B.AIR);
        queueWaterAround(hit.x, hit.y, hit.z);
        queueLavaAround(hit.x, hit.y, hit.z);
        for (const drop of blockDrop(minedId, false))
          for (let i = 0; i < drop.count; i++) spawnDrop(drop.id, hit.x, hit.y, hit.z);
        act.lastBreak = now;
        }
      }
    } else if (wantMine && hit && Number.isFinite(PROPS[hit.id].hardness) && PROPS[hit.id].hardness > 0
               && (isToolItem(slotId(HOTBAR[hotbarSel])) || handBreakable(hit.id))) {
      // no tool, no crack (0.7341) — bare hands only take foliage; see handBreakable
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
      if (stage !== mining.stage) {
        mining.stage = stage;
        drawCrack(progress);
        if (stage & 1) playBlockSound(hit.id, 'hit', hit.x, hit.y, hit.z);   // every other stage
      }
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
        // axe on a log: strip it, or fell the tree if it is already stripped. It performs its own
        // block edit and drops, so the ordinary break path is skipped when it claims the hit.
        // NOT an early return — the rest of frame() still has to stream chunks and render.
        const chopped = tryChopLog(mx, my, mz);
        if (!chopped) playBlockSound(minedId, 'break', mx, my, mz);
        // the wrong tool for the job (a pickaxe on dirt): double wear below, and no experience
        const wrongTool = isWrongTool(slotId(HOTBAR[hotbarSel]), minedId);
        // natural blocks only; your own placements pay 0
        if (!wrongTool) awardBlockXP(mx, my, mz, minedId);
        // tier gate: wrong/too-weak tool still breaks the block but yields no drops
        const dropsOk = mineDropAllowed(slotId(HOTBAR[hotbarSel]), minedId);
        const inf = chopped ? null : slabBreakInfo(mval, mbi);   // double slab: break only the mined half
        if (chopped) {
          /* felling already did everything */
        } else if (inf) {
          setBlock(mx, my, mz, inf.remainVal);
          if (dropsOk) {
            // a snow layer never hands back a carpet — only a shovel packs it into a snowball
            const leafBlk = inf.mat != null ? litterLeafBlock(inf.mat) : undefined;
            if (inf.mat === CARPET_MAT.SNOW) {
              if (ITEM_PROPS[slotId(HOTBAR[hotbarSel])]?.tool === 'shovel')
                spawnDrop(ITEM.SNOWBALL, mx, my, mz);
            } else if (leafBlk != null) {
              // leaf litter yields exactly what its leaves yield, never a litter block
              for (const drop of blockDrop(leafBlk, false))
                for (let i = 0; i < drop.count; i++) spawnDrop(drop.id, mx, my, mz);
            } else spawnDrop(inf.dropId, mx, my, mz);
          }
        } else {
          setBlock(mx, my, mz, B.AIR);
          queueWaterAround(mx, my, mz);
          queueLavaAround(mx, my, mz);
          if (_isLog(minedId)) scheduleLeavesCheck(mx, my, mz);
          if (dropsOk)
            for (const drop of blockDrop(minedId, false))
              for (let i = 0; i < drop.count; i++) spawnDrop(drop.id, mx, my, mz);
        }
        /* Tool wear: an ordinary survival break costs 1 durability, 2 when the tool had no
           business on that block (isWrongTool), and NOTHING at all for a billboard — a torch or
           a flower is brushed aside rather than dug, so no edge dulls on it (0.7345). */
        const tslot = HOTBAR[hotbarSel];
        if (tslot && tslot.dur != null && !isFreeBreak(minedId)) {
          tslot.dur -= wrongTool ? 2 : 1;
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
    if (wantMine) { if (!act.break || now - act.lastBreak > 240) { doBreak(); act.lastBreak = now; } }
    if (wantPlace && !_didThrow) { if (!act.place || now - act.lastPlace > 240) { doPlace(); act.lastPlace = now; } }
  }
  act.break = wantBreak; act.place = wantPlace;

  /* ---- held-block light: a virtual glow source that follows this player ---- */
  {
    const slotH = HOTBAR[hotbarSel];
    const id   = slotH ? slotH.id : null;
    const raw  = id === null ? 0 : id < 256 ? (PROPS[id]?.light ?? 0) : (ITEM_PROPS[id]?.light ?? 0);
    const hand = id === null ? null : id < 256 ? PROPS[id]?.handLight : ITEM_PROPS[id]?.handLight;
    const lvl  = (playing && player.spawned && raw > 0) ? (hand ?? Math.max(1, Math.round(raw * 0.65))) : 0;
    _hlRaw = raw;
    // Math.round for XZ: triggers 0.5 blocks early so mesh is ready when player arrives
    const px = Math.round(player.pos.x), py = Math.floor(player.pos.y + player.EYE), pz = Math.round(player.pos.z);
    if (lvl !== _hlLevel || id !== _hlId || px !== _hlX || py !== _hlY || pz !== _hlZ) {
      _hlId = id; _hlLevel = lvl; _hlX = px; _hlY = py; _hlZ = pz;
      updatePlayerLight(slot, px, py, pz, lvl);     // each player owns one glow slot
    }
  }

  /* ---- eating ---- */
  const eatProg = updateEating(dt, wantPlace);
  // the third-person body mirrors it next frame, so everyone else sees this player eating
  player._eatProg = eatProg;

  /* ---- this player's own upkeep: swing pacing, vitals, XP bar, first-person arm ---- */
  updateAttackCooldown(dt);
  if (!menuScene) updateVitals(dt);
  updateXPBar(dt);
  updateHands(dt, wantBreak, wantPlace, eatProg);

  /* Selection outline and crack overlay are single scene MESHES shared by every viewport, so each
     player records the transform it wants and the render pass re-applies it per view. The crack
     MATERIAL is per seat since 0.734 — sharing it was not the harmless overlap the old note here
     claimed: both players wrote their own stage into it as their progress crossed each 10%, so
     both viewports flickered between the two stages several times a second. */
  const st = PSTATE[slot];
  st.handVisible = handRoot.visible;
  st.sel = selBox.visible
    ? { px: selBox.position.x, py: selBox.position.y, pz: selBox.position.z,
        sx: selBox.scale.x,    sy: selBox.scale.y,    sz: selBox.scale.z } : null;
  st.crack = crackMesh.visible
    ? { px: crackMesh.position.x, py: crackMesh.position.y, pz: crackMesh.position.z,
        sx: crackMesh.scale.x,    sy: crackMesh.scale.y,    sz: crackMesh.scale.z } : null;
}

/* ================================================================================================
   WORLD TICK — everything that belongs to the world rather than to a player. Runs exactly once a
   frame no matter how many people are playing.
   ================================================================================================ */
function runWorldTick(dt, now) {
  /* ---- chunk streaming, centred on the union of every player's position ---- */
  syncPlayerChunks();
  /* Finish arrived chunks before uploading meshes — a chunk must be lit before it is meshed.
     Generous while the loading screen is up (nothing is on screen to stutter), tight in play.

     Both drains also carry a DEADLINE (0.7143). The counts alone were a poor budget: a chunk
     finish pass costs anything from a fraction of a millisecond to several depending on how much
     decoration landed in it, so a fixed count is either wasteful or a stutter depending on where
     you happen to be standing. The deadline is a hard wall in real time — whatever is left over
     simply waits for the next frame, and nothing is ever dropped. */
  /* CATCH-UP. The in-play budgets are sized for the steady state — a chunk or two arriving as you
     walk — and they are far too tight for the moments when a whole neighbourhood lands at once:
     entering a world, joining one, respawning. Those all dump hundreds of chunks into the
     pipeline with the loading screen already gone, and two finishes plus twelve uploads a frame
     took about five seconds to work through, which is exactly how long the world stayed invisible
     around you.

     Rather than special-casing each of those events, the condition is simply "is a lot of work
     already sitting in the queues" — which is true for all three and false during ordinary play.
     While it holds, spend a bigger slice of the frame: an empty world is a far worse thing to
     look at than a frame that ran a few milliseconds long. */
  const _rush = _loadingWorld || menuScene;   // nothing to stutter; the player is waiting on this
  const _catchUp = genFinishQueue.length > 6 || meshResults.length > 12;
  const _streamDeadline = performance.now() + (_rush ? 30 : _catchUp ? 12 : 5);
  processGenFinish(_rush ? 8 : _catchUp ? 6 : 2, _streamDeadline);
  applyMeshResults(_rush ? 48 : _catchUp ? 32 : 12, _streamDeadline);
  pump();

  /* Title panorama: lift the veil once every chunk in the (small) menu radius has both data and
     geometry, and nothing is still in flight. Any other state — a world loading, or gameplay —
     restores the canvas unconditionally, so an early "Singleplayer" click can never strand it
     invisible. */
  if (menuScene) {
    if (_menuVeil) {
      let ready = true;
      const R = viewDist;
      outerMenu: for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dz * dz > R * R) continue;
          const c = getChunk(playerCX + dx, playerCZ + dz);
          if (!c || !c.data || !(c.meshes[0] || c.meshes[1] || c.meshes[2] || c.meshes[3])) {
            ready = false; break outerMenu;
          }
        }
      const done = ready && !meshResults.length && !genFinishQueue.length && !genQueue.length;
      /* Safety valve: a chunk with nothing to draw (solid rock, or open sky) never gets geometry,
         so "every chunk has a mesh" is not guaranteed to become true. A blank title screen is a
         far worse failure than a little pop-in, so the veil always lifts within 4 seconds. */
      if (done || performance.now() - _menuVeilT > 4000) {
        _menuVeil = false;
        // boot metric: ms from page start to a finished, visible title screen (see __vc.stats)
        if (window.__bootMs === undefined) window.__bootMs = Math.round(performance.now());
        canvas.style.opacity = '1';
        liftBootCover();
        // the panel is one transition behind the terrain, so the menu settles onto a finished view
        setTimeout(() => overlay.classList.remove('veiled'), 120);
      }
    }
  } else if (canvas.style.opacity !== '1') {
    _menuVeil = false;
    canvas.style.opacity = '1';
    overlay.classList.remove('veiled');
    liftBootCover();
  }

  /* Loading screen: dismiss once the player has spawned, the chunks within radius 4 are ready,
     AND the art is in (0.732). Chunk readiness alone used to be enough, which is how a cold join
     landed you in a finished world holding invisible items beside a black chest. */
  if (_loadingWorld) setLoadingStep(!player.spawned ? 'generating terrain'
                                  : !gameAssetsReady ? 'loading textures'
                                  : 'building chunks');
  if (_loadingWorld && player.spawned && gameAssetsReady) {
    let _ldDone = true;
    const _ldR = 4;
    outer: for (let ldz = -_ldR; ldz <= _ldR; ldz++) {
      for (let ldx = -_ldR; ldx <= _ldR; ldx++) {
        if (ldx * ldx + ldz * ldz > _ldR * _ldR) continue;
        const nc = getChunk(playerCX + ldx, playerCZ + ldz);
        if (!nc || !nc.data || nc.meshing || nc.queuedMesh) { _ldDone = false; break outer; }
      }
    }
    // genFinishQueue too: a chunk with data but no lighting pass yet is not actually ready
    if (_ldDone && meshResults.length === 0 && genFinishQueue.length === 0) {
      _loadingWorld = false;
      worldLoadingEl.style.display = 'none';
    }
  }

  /* ---- world simulation: fluids, mobs, growth, falling blocks ---- */
  /* The whole simulation block is skipped on the title screen. The panorama has no physics, no
     fluids, no mobs and no growth — it is a camera pointed at generated terrain — so every one of
     these is dead weight there, and the boot frames are better spent streaming the backdrop in. */
  if (!menuScene) {
    updateSimWake();                        // seed physics for chunks entering the sim radius
    processFalling(dt);
    if (!player.canFly) { updateDrops(dt); updateProjectiles(dt); processLeavesDecay(dt); }
    updateFluids(dt);
    updateEntities(dt);
    updateTNTs(dt);
    updateSaplings();
    processGrassSpread(dt);
    updateFurnaces(dt);
    updateDoors(dt);
    updateBed(dt);
    updateChests(dt);
  }
  /* The armour-stand preview is a single WebGL renderer whose canvas can only live in one panel at
     a time. It follows whoever opened their inventory MOST RECENTLY, and the moment they close it
     falls back to whoever is still in theirs — so opening a second inventory borrows the preview
     and closing it hands the preview straight back, instead of stranding the first player with an
     empty box until they reopen. */
  let pv = -1, pvSeq = -1;
  forEachPlayerState((g, i) => { if (g.invOpen && (g._invSeq || 0) > pvSeq) { pvSeq = g._invSeq || 0; pv = i; } });
  if (pv >= 0) withSlot(pv, () => updateEquipPreview(dt));

  /* ---- sky, lighting & shadow maps, then one render pass per player ---- */
  updateDayNight(dt);
  renderAllViews(dt);

  /* ---- HUD text (after the render so draw/tri stats reflect the main pass) ---- */
  hudT += dt;
  if (hudT > 0.15) {
    hudT = 0;
    forEachPlayerSlot(paintDebugHud);
  }
}

/* Volume fog for the camera currently installed: lava murk, water murk, or the ordinary surface
   range. Called once per viewport so each player's eye gets its own tint — one player underwater
   must not turn everyone else's view blue. */
function applyEyeVolumeFog() {
  const eyeId = getBlock(Math.floor(camera.position.x), Math.floor(camera.position.y), Math.floor(camera.position.z)) & 255;
  const far = viewDist * 16;
  if (eyeId === B.LAVA) {
    sharedUniforms.fogColor.value.set(0.72, 0.22, 0.0);
    renderer.setClearColor(sharedUniforms.fogColor.value);
    sharedUniforms.fogNear.value = 1;
    sharedUniforms.fogFar.value = 6;
    sharedUniforms.uAmbient.value = Math.min(sharedUniforms.uAmbient.value + 0.5, 1.0);
  } else if (eyeId === B.WATER) {
    sharedUniforms.fogColor.value.copy(_skyFogColor).multiplyScalar(0.45).lerp(_uwTint, 0.4);
    renderer.setClearColor(sharedUniforms.fogColor.value);
    sharedUniforms.fogNear.value = 5;
    sharedUniforms.fogFar.value = 36;
    sharedUniforms.uAmbient.value = _skyAmbient * 0.78;
    sharedUniforms.uDirect.value  = _skyDirect  * 0.65;
  } else {
    // restore whatever updateDayNight computed for this instant — the previous viewport may have
    // been submerged and left the murk behind
    sharedUniforms.fogColor.value.copy(_skyFogColor);
    renderer.setClearColor(sharedUniforms.fogColor.value);
    sharedUniforms.uAmbient.value = _skyAmbient;
    sharedUniforms.uDirect.value  = _skyDirect;
    sharedUniforms.fogNear.value = far * 0.55;
    sharedUniforms.fogFar.value  = far * 0.98;
  }
}

/* The first-person arm, drawn on top of the finished view with its own cleared depth buffer.
   Split into its own function because it now runs once per viewport. */
function renderHandPass() {
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
}

// the debug read-out, written into whichever player's pane is currently installed
function paintDebugHud() {
  if (debugHudHidden(activePlayerSlot())) return;    // F3 / pad Back turned it off for this seat
  const p = player.pos, info = renderer.info.render;
  const heading = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const cdir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
  const mins = ((worldTime * 24 + 6) % 24) * 60;          // clock: sunrise = 06:00
  const clock = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.floor(mins % 60)).padStart(2, '0')}`;
  const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
  hudEl.innerHTML =
    `FPS ${fps} / ${fpsLimit ? Math.min(fpsLimit, rafHz) : rafHz} &middot; ${player.flying ? 'flying' : (player._inWater ? 'swim' : 'walking')}${player.fast ? ' &middot; fast' : ''}${player.canFly ? '' : ' &middot; survival'}<br>` +
    `facing ${cdir} ${heading.toFixed(0)}&deg; &middot; ${clock} &middot; Day ${worldDay}<br>` +
    `XYZ ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}<br>` +
    `biome ${mainGen.biomeAt(Math.floor(p.x), Math.floor(p.z))}<br>` +
    `chunk ${cx} , ${cz} &middot; loaded ${chunks.size}<br>` +
    `seed ${SEED} &middot; dist ${viewDist} [ ] &middot; sim ${simDist()}<br>` +
    // what this seat is actually listening to — the quickest answer to "is my controller detected"
    `input ${escapeHtml(inputLabelFor(activePlayerSlot()))}<br>` +
    `draws ${info.calls} &middot; tris ${(info.triangles / 1000).toFixed(0)}k`;
}

