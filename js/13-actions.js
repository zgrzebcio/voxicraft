'use strict';
/* voxiCraft — block break/place, inventory slot model */

/* ---------------------------------- block edit actions ---------------------------------- */
// every placeable block, straight from the registry (raycastable excludes water/air) —
// new blocks registered in VOXEL_CORE automatically appear in the inventory
const PLACEABLE = PROPS.map((p, id) => (p && id !== B.AIR && p.raycast && !p.noInv) ? id : -1).filter(id => id >= 0);

// Inventories are per game mode:
//  - creative: reset to default (one of every block, sorted by ID) every time creative is entered
//  - survival: empty on first join, persists in localStorage, never touched by creative
// Storage keys are namespaced so switching modes cannot leak into the survival inventory.
// Slot model: `null` (empty) OR `{id, count}` where `count >= 1`. Stack cap comes from
// PROPS[id].stack (blocks default 60; future items can set 20/99/etc.).
const DEFAULT_STACK = 60;
const stackSize = (id) => id >= 256 ? (ITEM_PROPS[id]?.stack ?? DEFAULT_STACK) : (PROPS[id]?.stack ?? DEFAULT_STACK);
const slotId    = (s) => s ? s.id : null;
const slotCount = (s) => s ? s.count : 0;
// tools carry their own durability in the slot (`dur` counts down; slot dies at 0)
const mkSlot    = (id, n = 1) => {
  const d = id >= 256 ? ITEM_PROPS[id]?.durability : null;
  return d ? { id, count: n, dur: d } : { id, count: n };
};
// split/move n items out of an existing slot, KEEPING its wear (mkSlot would reset dur to full)
const carrySlot = (src, n) => { const t = mkSlot(src.id, n); if (src.dur != null) t.dur = src.dur; return t; };
function _defaultCreativeInventory() {
  // blocks (sorted) then a few useful items (infinite water bucket) appended to the palette
  const sorted = PLACEABLE.slice().sort((a, b) => a - b).concat([ITEM.WATER_BUCKET, ITEM.LAVA_BUCKET]);
  const hot = new Array(9).fill(null);
  const inv = new Array(27).fill(null);
  const inv2 = new Array(27).fill(null);            // second grid: overflow palette for future blocks
  for (let i = 0; i < sorted.length; i++) {
    if (i < 9) hot[i] = mkSlot(sorted[i]);
    else if (i - 9 < 27) inv[i - 9] = mkSlot(sorted[i]);
    else if (i - 36 < 27) inv2[i - 36] = mkSlot(sorted[i]);
  }
  return { hot, inv, inv2 };
}
// Legacy inventories were arrays of raw IDs; migrate on load so old saves stack from 1.
const _isValidId = (id) => id >= 256 ? ITEM_PROPS[id] != null : PLACEABLE.includes(id);
function _validateSlot(v) {
  if (v === null) return null;
  if (typeof v === 'number' && _isValidId(v)) return mkSlot(v);
  if (v && typeof v === 'object' && _isValidId(v.id)
      && Number.isInteger(v.count) && v.count >= 1 && v.count <= stackSize(v.id)) {
    const out = { id: v.id, count: v.count };
    const maxD = v.id >= 256 ? ITEM_PROPS[v.id]?.durability : null;   // keep tool wear across saves
    if (maxD) out.dur = Number.isInteger(v.dur) && v.dur >= 1 && v.dur <= maxD ? v.dur : maxD;
    return out;
  }
  return null;
}
function _loadSurvivalArr(key, len) {
  try {
    const s = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(s) && s.length === len) return s.map(_validateSlot);
  } catch {}
  return new Array(len).fill(null);
}
const _validArr = (a, len) => {
  const out = new Array(len).fill(null);
  if (Array.isArray(a)) for (let i = 0; i < len; i++) out[i] = _validateSlot(a[i]);
  return out;
};
let currentInvMode = localStorage.getItem('vc_mode') === 'survival' ? 'survival' : 'creative';
// per-world survival items: lives in memory, persisted inside the world save (vc_world_<id>)
// inv2 = second grid. Creative: overflow block palette. Survival: reserved for a future backpack
// (kept empty + persisted for now, but not shown in the survival UI yet).
let survStash = { hot: new Array(9).fill(null), inv: new Array(27).fill(null), inv2: new Array(27).fill(null) };
let HOTBAR, invSlots, invSlots2;
function loadInventoryForMode(mode) {
  currentInvMode = mode;
  if (mode === 'creative') {
    const d = _defaultCreativeInventory();
    HOTBAR = d.hot; invSlots = d.inv; invSlots2 = d.inv2;     // wiped fresh — no save; creative is ephemeral
  } else {
    if (!survStash.inv2) survStash.inv2 = new Array(27).fill(null);   // migrate older saves
    HOTBAR = survStash.hot; invSlots = survStash.inv; invSlots2 = survStash.inv2;   // live refs — world save persists them
  }
}
loadInventoryForMode(currentInvMode);
const saveHotbar = () => { if (currentInvMode === 'survival') survStash.hot = HOTBAR; };
const saveInv    = () => { if (currentInvMode === 'survival') { survStash.inv = invSlots; survStash.inv2 = invSlots2; } };
const saveAll = () => { saveHotbar(); saveInv(); };
let hotbarSel = 0;

const _dir = new THREE.Vector3();
function currentRay() {
  camera.getWorldDirection(_dir);
  return raycastVoxel(camera.position, _dir, 7);
}
// double-slab break: which half did the ray hit, what drops, what stays.
// Box order in SLAB_VAR doubles: [even/own half, odd/other half] — bi is the raycast box index.
function slabBreakInfo(val, bi) {
  const id = val & 255, va = (val >> 8) & 255;
  if (!PROPS[id] || PROPS[id].model !== 'slab' || va < 6) return null;
  if (va < 16) {                                   // same-type double, axis o. Box order [2o, 2o+1].
    const o = va - 6, hA = 2 * o, hB = 2 * o + 1;
    return { dropId: id, remainVal: id | ((bi ? hA : hB) << 8) };
  }
  // mixed double: box0 = id at half v, box1 = partner at half v^1. Break the aimed half, keep other.
  const t = va - 16, v = t & 7, partner = SLAB_IDS[t >> 3];
  if (partner == null) return { dropId: id, remainVal: id | ((v ^ 1) << 8) };   // legacy/unknown fallback
  return bi ? { dropId: partner, remainVal: id | (v << 8) }
            : { dropId: id,      remainVal: partner | ((v ^ 1) << 8) };
}
function doBreak() {
  const hit = currentRay();
  if (!hit) return;
  if (isTNTFuseActive(hit.x, hit.y, hit.z)) return;             // armed TNT is unbreakable
  const inf = slabBreakInfo(getBlock(hit.x, hit.y, hit.z), hit.bi || 0);
  setBlock(hit.x, hit.y, hit.z, inf ? inf.remainVal : B.AIR);   // double slab: only the aimed half
}
let handPlaceSwing = false;   // set on a SUCCESSFUL place; 24-hands consumes it for the swing
// complete a half-filled slab cell with the held slab → double slab. Same type → same-type
// double (6+axis). Different type → mixed double: baseId keeps half v, heldId gets complement,
// encoded 16 + partnerIdx*8 + v (partnerIdx = heldId's slab-registry index, must fit 0..15).
function tryMergeSlab(x, y, z, baseId, v, heldId) {
  let nv;
  if (heldId === baseId) nv = 6 + (v >> 1);
  else {
    const pi = SLAB_IDS.indexOf(heldId);
    if (pi < 0 || pi > 15) return false;           // partner not registerable in the variant byte
    nv = 16 + pi * 8 + v;
  }
  const p = player.pos, R = player.R;              // cell becomes full — don't squash the player
  if (x + 1 > p.x - R && x < p.x + R && y + 1 > p.y && y < p.y + player.H &&
      z + 1 > p.z - R && z < p.z + R) return false;
  setBlock(x, y, z, baseId | (nv << 8));
  handPlaceSwing = true;
  if (!player.canFly) {
    const slot = HOTBAR[hotbarSel];
    slot.count--;
    if (slot.count <= 0) HOTBAR[hotbarSel] = null;
    saveHotbar(); updateHotbar(); buildHotbar();
  }
  return true;
}
// swap the held bucket to a new item id (creative: no change — treated as infinite)
function _swapHeld(newId) {
  if (player.canFly) return;
  HOTBAR[hotbarSel] = newId != null ? mkSlot(newId, 1) : null;
  saveHotbar(); updateHotbar(); buildHotbar();
}
// march the camera ray in small steps; return {x,y,z} of the first LAVA source before any solid
function _rayLava(maxDist = 6) {
  camera.getWorldDirection(_dir);
  const o = camera.position;
  for (let t = 0; t <= maxDist; t += 0.15) {
    const x = Math.floor(o.x + _dir.x * t), y = Math.floor(o.y + _dir.y * t), z = Math.floor(o.z + _dir.z * t);
    const val = getBlock(x, y, z), id = val & 255;
    if (id === B.LAVA) return ((val >> 8) & 15) === 0 ? { x, y, z } : null;   // source only
    if (id !== B.AIR) return null;
  }
  return null;
}
// march the camera ray in small steps; return {x,y,z} of the first WATER cell before any solid
function _rayWater(maxDist = 6) {
  camera.getWorldDirection(_dir);
  const o = camera.position;
  for (let t = 0; t <= maxDist; t += 0.15) {
    const x = Math.floor(o.x + _dir.x * t), y = Math.floor(o.y + _dir.y * t), z = Math.floor(o.z + _dir.z * t);
    const val = getBlock(x, y, z), id = val & 255;
    if (id === B.WATER) return ((val >> 8) & 15) === 0 ? { x, y, z } : null;   // source only, not flowing
    if (id !== B.AIR) return null;          // hit something solid first — no water grabbed
  }
  return null;
}
function useBucket(heldId, hit) {
  handPlaceSwing = true;
  if (heldId === ITEM.BUCKET) {             // fill: try water source first, then lava source
    const w = _rayWater();
    if (w) {
      setBlock(w.x, w.y, w.z, B.AIR);
      dryWaterFrom(w.x, w.y, w.z);
      _swapHeld(ITEM.WATER_BUCKET);
      return;
    }
    const lv = _rayLava();
    if (lv) {
      setBlock(lv.x, lv.y, lv.z, B.AIR);
      queueLavaAround(lv.x, lv.y, lv.z);
      _swapHeld(ITEM.LAVA_BUCKET);
    }
  } else if (heldId === ITEM.WATER_BUCKET) { // pour water
    const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
    const cur = getBlock(px, py, pz) & 255;
    if (cur !== B.AIR && cur !== B.WATER) return;
    setBlock(px, py, pz, B.WATER);
    queueWaterAt(px, py, pz);
    _swapHeld(ITEM.BUCKET);
  } else if (heldId === ITEM.LAVA_BUCKET) {  // pour lava
    const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
    const cur = getBlock(px, py, pz) & 255;
    if (cur !== B.AIR && cur !== B.LAVA) return;
    setBlock(px, py, pz, B.LAVA);
    queueLavaAt(px, py, pz);
    _swapHeld(ITEM.BUCKET);
  }
}
function doPlace() {
  // empty bucket: fill from open water even when nothing solid is behind it (no block hit needed)
  if (slotId(HOTBAR[hotbarSel]) === ITEM.BUCKET) { useBucket(ITEM.BUCKET, null); return; }
  const hit = currentRay();
  if (!hit) return;
  // survival: right-clicking a crafting bench opens the advanced recipe list instead of placing
  if (!player.canFly && hit.id === B.CRAFTING_BENCH) { toggleInventory(true, 'advanced'); return; }
  // survival: right-clicking a furnace opens its smelting GUI
  if (!player.canFly && hit.id === B.FURNACE) { openFurnace(hit.x, hit.y, hit.z); return; }
  // doors open/close in any mode
  if (hit.id === B.DOOR) { toggleDoor(hit.x, hit.y, hit.z); handPlaceSwing = true; return; }
  const heldId = slotId(HOTBAR[hotbarSel]);
  // buckets: fill empty bucket from a water source, or pour a water source from a full one
  if (heldId === ITEM.BUCKET || heldId === ITEM.WATER_BUCKET || heldId === ITEM.LAVA_BUCKET) { useBucket(heldId, hit); return; }
  // sulfur tip: only placeable on the top or bottom face of a sulfur block.
  // Face → variant: top face = 0 (upward tip), bottom face = 1 (downward tip).
  if (heldId === B.SULFUR_UP_TIP) {
    if (hit.id !== B.SULFUR_BLOCK) return;
    if (hit.ny !== 1 && hit.ny !== -1) return;
    const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
    const cur = getBlock(px, py, pz) & 255;
    if (cur !== B.AIR && cur !== B.WATER) return;
    const varb = hit.ny === 1 ? 0 : 1;
    setBlock(px, py, pz, B.SULFUR_UP_TIP | (varb << 8));
    handPlaceSwing = true;
    if (!player.canFly) {
      const s = HOTBAR[hotbarSel]; s.count--;
      if (s.count <= 0) HOTBAR[hotbarSel] = null;
      saveHotbar(); updateHotbar(); buildHotbar();
    }
    return;
  }
  // snow carpet placed onto a cross/billboard plant -> replaces the plant in the same cell
  if (heldId === B.SNOW_CARPET && PROPS[hit.id] && PROPS[hit.id].model === 'cross' && isSolid(hit.x, hit.y - 1, hit.z)) {
    setBlock(hit.x, hit.y, hit.z, B.SNOW_CARPET);
    handPlaceSwing = true;
    if (!player.canFly) {
      const s = HOTBAR[hotbarSel]; s.count--;
      if (s.count <= 0) HOTBAR[hotbarSel] = null;
      saveHotbar(); updateHotbar(); buildHotbar();
    }
    return;
  }
  // snow carpet + snow carpet -> add a layer to the aimed carpet (variant 0..5 = 1..6 layers).
  // Once at 6 layers (full), further clicks fall through to normal placement (a new carpet above).
  if (heldId === B.SNOW_CARPET && hit.id === B.SNOW_CARPET) {
    const hv = (getBlock(hit.x, hit.y, hit.z) >> 8) & 255;
    if (hv < 5) {
      setBlock(hit.x, hit.y, hit.z, B.SNOW_CARPET | ((hv + 1) << 8));
      handPlaceSwing = true;
      if (!player.canFly) {
        const s = HOTBAR[hotbarSel]; s.count--;
        if (s.count <= 0) HOTBAR[hotbarSel] = null;
        saveHotbar(); updateHotbar(); buildHotbar();
      }
      return;
    }
  }
  // grass on grass -> grow a 2-block tall grass (lower + upper), if there's headroom
  if (heldId === B.TALLGRASS && hit.id === B.TALLGRASS && (getBlock(hit.x, hit.y + 1, hit.z) & 255) === B.AIR) {
    setBlock(hit.x, hit.y, hit.z, B.TALL_LOWER);
    setBlock(hit.x, hit.y + 1, hit.z, B.TALL_UPPER);
    handPlaceSwing = true;
    if (!player.canFly) {
      const s = HOTBAR[hotbarSel]; s.count--;
      if (s.count <= 0) HOTBAR[hotbarSel] = null;
      saveHotbar(); updateHotbar(); buildHotbar();
    }
    return;
  }
  const heldSlab = heldId != null && heldId < 256 && PROPS[heldId].model === 'slab';
  // slab merge, case 1: clicked the inner flat face of a single slab → complete THAT cell
  if (heldSlab && PROPS[hit.id].model === 'slab') {
    const hv = (getBlock(hit.x, hit.y, hit.z) >> 8) & 255;
    if (hv < 6) {
      const o = hv >> 1, axisN = o === 0 ? hit.ny : o === 1 ? hit.nx : hit.nz;
      if (axisN === ((hv & 1) ? -1 : 1) && tryMergeSlab(hit.x, hit.y, hit.z, hit.id, hv, heldId)) return;
    }
  }
  const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
  const cur = getBlock(px, py, pz) & 255;
  if (cur !== B.AIR && cur !== B.WATER && cur !== B.LAVA) {  // only into air/water/lava...
    // ...case 2: unless the target cell holds a single slab the held slab can complete
    if (heldSlab && PROPS[cur].model === 'slab') {
      const tv = (getBlock(px, py, pz) >> 8) & 255;
      if (tv < 6 && tryMergeSlab(px, py, pz, cur, tv, heldId)) return;
    }
    return;
  }
  const slot = HOTBAR[hotbarSel];
  let id = slotId(slot);
  if (id == null) return;                                  // empty hotbar slot -> nothing to place
  // items that place a block when used (sugar cane item -> sugar cane block)
  if (id === ITEM.SUGAR_CANE) id = B.SUGAR_CANE;
  if (id >= 256) return;                                   // items (sticks, etc.) are not placeable
  // billboards (torch, mushrooms, any cross model): any face works, but the target cell
  // must sit on a solid block (matches the support-break rule in setBlock)
  if ((PROPS[id].topOnly || PROPS[id].model === 'cross') && !isSolid(px, py - 1, pz)) return;
  // flowers and grass plants require a grass block underneath (not any solid — no dirt/stone/etc.)
  if (id === B.TALLGRASS || id === B.POPPY || id === B.ORCHID || id === B.TALL_LOWER) {
    if ((getBlock(px, py - 1, pz) & 255) !== B.GRASS) return;
  }
  // saplings require grass underneath (same rule as flowers)
  if (id === B.OAK_SAPLING || id === B.BIRCH_SAPLING) {
    if ((getBlock(px, py - 1, pz) & 255) !== B.GRASS) return;
  }
  // sugar cane: on top of an existing cane (stack up to 5), OR on sand/grass/dirt with an
  // adjacent water block at the same y as the ground. Reject otherwise.
  if (id === B.SUGAR_CANE) {
    const below = getBlock(px, py - 1, pz) & 255;
    const isCaneBelow = below === B.SUGAR_CANE;
    if (isCaneBelow) {
      // count column height so far (below the target cell)
      let baseY = py - 1;
      while (baseY > 0 && (getBlock(px, baseY - 1, pz) & 255) === B.SUGAR_CANE) baseY--;
      if (py - baseY >= 5) return;                                       // already 5 tall
    } else {
      if (below !== B.SAND && below !== B.RED_SAND && below !== B.GRASS && below !== B.DIRT) return;
      // must have water at ground level in any of 4 side neighbors of the block BELOW
      let nearWater = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if ((getBlock(px + dx, py - 1, pz + dz) & 255) === B.WATER) { nearWater = true; break; }
      }
      if (!nearWater) return;
    }
  }
  // cactus: only on sand / red sand / cactus, and never touching a solid block on any side
  if (id === B.CACTUS) {
    const below = getBlock(px, py - 1, pz) & 255;
    if (below !== B.SAND && below !== B.RED_SAND && below !== B.CACTUS) return;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      if (PROPS[getBlock(px + dx, py, pz + dz) & 255].solid) return;
  }
  if (PROPS[id].solid) {                                    // don't place a solid inside yourself
    const p = player.pos, R = player.R;
    if (px + 1 > p.x - R && px < p.x + R && py + 1 > p.y && py < p.y + player.H &&
        pz + 1 > p.z - R && pz < p.z + R) return;
  }
  // door: needs headroom + floor, places both halves, spawns the animated mesh
  if (id === B.DOOR) {
    const above = getBlock(px, py + 1, pz) & 255;
    if (above !== B.AIR && above !== B.WATER) return;
    if (!isSolid(px, py - 1, pz)) return;
    const ddx = player.pos.x - (px + 0.5), ddz = player.pos.z - (pz + 0.5);
    const facing = Math.abs(ddx) > Math.abs(ddz) ? (ddx > 0 ? 2 : 3) : (ddz > 0 ? 0 : 1);
    setBlock(px, py, pz, id | (facing << 8));
    setBlock(px, py + 1, pz, id | ((facing | 8) << 8));
    registerDoor(px, py, pz, facing, false);
    handPlaceSwing = true;
    if (!player.canFly) {
      slot.count--;
      if (slot.count <= 0) HOTBAR[hotbarSel] = null;
      saveHotbar(); updateHotbar(); buildHotbar();
    }
    return;
  }
  // rotation variant from placement context
  let varb = 0;
  const rot = PROPS[id].rot;
  const type = PROPS[id].model;
  if (rot === 'side') {
    // front faces the player: facing = horizontal direction from block toward player
    const ddx = player.pos.x - (px + 0.5), ddz = player.pos.z - (pz + 0.5);
    varb = Math.abs(ddx) > Math.abs(ddz) ? (ddx > 0 ? 2 : 3) : (ddz > 0 ? 0 : 1);
  } else if (rot === 'all') {
    if (id === B.LOG) varb = hit.nx ? 1 : hit.nz ? 2 : 0;      // axis = clicked face normal
    else if (type === 'stairs') {
      // full side toward the player; clicking a ceiling face flips them upside-down
      const ddx = player.pos.x - (px + 0.5), ddz = player.pos.z - (pz + 0.5);
      varb = (Math.abs(ddx) > Math.abs(ddz) ? (ddx > 0 ? 2 : 3) : (ddz > 0 ? 0 : 1))
           | (hit.ny === -1 ? 4 : 0);
    }
    else if (type === 'slab' )
      varb = hit.ny === 1 ? 0 : hit.ny === -1 ? 1               // floor / ceiling half
           : hit.nx === 1 ? 2 : hit.nx === -1 ? 3               // vertical halves hug the
           : hit.nz === 1 ? 4 : 5;                              // clicked wall
  }
  setBlock(px, py, pz, id | (varb << 8));
  if (id === B.TNT) armTNT(px, py, pz);          // start the fuse the moment TNT is placed
  if (id === B.OAK_SAPLING || id === B.BIRCH_SAPLING) armSapling(px, py, pz, id);
  // a real block placed on top of grass smothers it back to dirt (billboards/cross don't)
  if (type !== 'cross' && (getBlock(px, py - 1, pz) & 255) === B.GRASS) setBlock(px, py - 1, pz, B.DIRT);
  handPlaceSwing = true;
  // survival: consume one from the stack; creative slots are ephemeral, no decrement
  if (!player.canFly) {
    slot.count--;
    if (slot.count <= 0) HOTBAR[hotbarSel] = null;
    saveHotbar(); updateHotbar(); buildHotbar();
  }
}

