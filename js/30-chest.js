'use strict';
/* voxiCraft — chest: storage block with an animated lid, pairing into a double chest.

   Like the door and the bed, the chunk mesher emits NOTHING for chest cells — each chest is one
   three.js group (base box + hinged lid) built here. The voxel cell stays for collision/raycast.

   variant byte: bits 0-1 facing (0:+Z 1:-Z 2:+X 3:-X).

   Two chests that sit side by side ACROSS their facing form a double chest: both lids animate
   together and the GUI shows both inventories as one tall grid. Each cell keeps its own slot
   array — the UI renders them as two stacked regions ('chest' and 'chest2') so the existing
   drag/drop machinery works unchanged. */

const CHEST_COLS = 7, CHEST_ROWS = 5;                 // wide and short so it fits without scrolling
const CHEST_SLOTS = CHEST_COLS * CHEST_ROWS;          // 35 per cell; a double stacks to 10 x 7
const CHESTS = new Map();                             // "x,y,z" -> record
let activeChest = null;                               // key of the primary cell whose GUI is open
let activeChest2 = null;                              // key of its partner, or null

const chestKey = (x, y, z) => x + ',' + y + ',' + z;
const mkChest = () => ({ slots: new Array(CHEST_SLOTS).fill(null) });

/* ---------------------------------- geometry ---------------------------------- */
// art is a 16px grid: lid occupies the top 5 rows, body the lower 10 (see mkchest.ps1)
const CHEST_LID_H = 5 / 16, CHEST_BASE_H = 10 / 16;
const CHEST_INSET = 1 / 16;                           // chest is 14/16 wide, centred in the cell

const _chestTexCache = {};
function chestTexture(name) {
  if (_chestTexCache[name]) return _chestTexCache[name];
  const t = new THREE.Texture(IMAGES[name]);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  _chestTexCache[name] = t;
  return t;
}
const chestMat = (n) => new THREE.MeshBasicMaterial({ map: chestTexture(n) });

// squeeze a box's side-face V range into one horizontal slice of the sheet
function _cropSideV(geo, v0, v1) {
  const uv = geo.attributes.uv;
  for (const base of [0, 4, 16, 20])                  // +X, -X, +Z, -Z
    for (let i = base; i < base + 4; i++) uv.setY(i, v0 + uv.getY(i) * (v1 - v0));
  for (const base of [4, 20])                         // -X and -Z read mirrored otherwise
    for (let i = base; i < base + 4; i++) uv.setX(i, 1 - uv.getX(i));
  uv.needsUpdate = true;
}

/* Authored with the FRONT at +Z; registerChest rotates the group onto the real facing.
   Cell-local coords: the chest body spans 1/16..15/16 on X and Z. */
function buildChestMesh() {
  const front = chestMat('chest_front'), side = chestMat('chest_side');
  const top = chestMat('chest_top'), bottom = chestMat('chest_bottom');
  const mats = [front, side, top, bottom];

  const w = 1 - CHEST_INSET * 2;
  const baseGeo = new THREE.BoxGeometry(w, CHEST_BASE_H, w);
  baseGeo.translate(0.5, CHEST_BASE_H / 2, 0.5);
  _cropSideV(baseGeo, 0, 1 - CHEST_LID_H);            // body art = lower 10 rows
  const base = new THREE.Mesh(baseGeo, [side, side, side, bottom, front, side]);

  // lid pivots on its BACK edge so it swings up and away from the player
  const lidPivot = new THREE.Group();
  lidPivot.position.set(0.5, CHEST_BASE_H, CHEST_INSET);
  const lidGeo = new THREE.BoxGeometry(w, CHEST_LID_H, w);
  lidGeo.translate(0, CHEST_LID_H / 2, w / 2);        // hinge at the local origin
  _cropSideV(lidGeo, 1 - CHEST_LID_H, 1);             // lid art = top 5 rows
  lidPivot.add(new THREE.Mesh(lidGeo, [side, side, top, bottom, front, side]));

  const group = new THREE.Group();
  group.add(base, lidPivot);
  return { group, lidPivot, mats };
}

/* ---------------------------------- lifecycle ---------------------------------- */
function registerChest(x, y, z, facing) {
  const k = chestKey(x, y, z);
  let rec = CHESTS.get(k);
  if (!rec) { rec = mkChest(); CHESTS.set(k, rec); }
  if (rec.group) return rec;                          // mesh already built
  const m = buildChestMesh();
  m.group.position.set(x, y, z);
  m.group.rotation.y = [0, Math.PI, Math.PI / 2, -Math.PI / 2][facing & 3];
  // rotating about the cell corner swings the body off its cell — shift it back
  const off = [[0, 0], [1, 1], [0, 1], [1, 0]][facing & 3];
  m.group.position.x += off[0];
  m.group.position.z += off[1];
  scene.add(m.group);
  Object.assign(rec, { group: m.group, lidPivot: m.lidPivot, mats: m.mats,
                       x, y, z, facing, lid: 0, lastB: -1 });
  return rec;
}
function removeChestMesh(k) {
  const c = CHESTS.get(k);
  if (!c || !c.group) return;
  scene.remove(c.group);
  c.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  for (const mt of c.mats) mt.dispose();
  c.group = null; c.lidPivot = null; c.mats = null;
}
function clearChests() {
  for (const k of [...CHESTS.keys()]) removeChestMesh(k);
  CHESTS.clear();
  activeChest = activeChest2 = null;
}

/* Chests pair ACROSS their facing: two chests looking the same way, side by side. */
function chestPartner(x, y, z) {
  const val = getBlock(x, y, z);
  if ((val & 255) !== B.CHEST) return null;
  const facing = (val >> 8) & 3;
  const dirs = (facing === 0 || facing === 1) ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    const nv = getBlock(x + dx, y, z + dz);
    if ((nv & 255) === B.CHEST && ((nv >> 8) & 3) === facing) return { x: x + dx, y, z: z + dz };
  }
  return null;
}
// deterministic ordering so both halves agree which cell is "first"
function chestPairOrdered(x, y, z) {
  const p = chestPartner(x, y, z);
  if (!p) return [{ x, y, z }, null];
  const a = { x, y, z };
  const first = (a.x < p.x || (a.x === p.x && a.z < p.z)) ? a : p;
  const second = first === a ? p : a;
  return [first, second];
}

// spill contents and forget the chest when its block goes away
function chestBroken(x, y, z) {
  const k = chestKey(x, y, z);
  const c = CHESTS.get(k);
  removeChestMesh(k);
  if (!c) return;
  if (!player.canFly)
    for (const s of c.slots)
      if (s) for (let n = 0; n < s.count; n++) spawnDrop(s.id, x, y, z);
  CHESTS.delete(k);
  if (activeChest === k || activeChest2 === k) {
    activeChest = activeChest2 = null;
    if (invOpen) toggleInventory(false);
  }
}

// right-click: open the GUI for this chest (plus its partner, if any)
function openChest(x, y, z) {
  const [a, b] = chestPairOrdered(x, y, z);
  registerChest(a.x, a.y, a.z, (getBlock(a.x, a.y, a.z) >> 8) & 3);
  if (b) registerChest(b.x, b.y, b.z, (getBlock(b.x, b.y, b.z) >> 8) & 3);
  activeChest = chestKey(a.x, a.y, a.z);
  activeChest2 = b ? chestKey(b.x, b.y, b.z) : null;
  toggleInventory(true);
}

/* ---------------------------------- per-frame ---------------------------------- */
const CHEST_OPEN_ANGLE = -1.15;
function updateChests(dt) {
  for (const [k, c] of CHESTS) {
    if (!c.group) continue;
    const ch = getChunk(Math.floor(c.x / 16), Math.floor(c.z / 16));
    if (!ch || !ch.data) { c.group.visible = false; continue; }
    if ((getBlock(c.x, c.y, c.z) & 255) !== B.CHEST) { removeChestMesh(k); continue; }
    c.group.visible = true;
    // lid eases toward open/closed; a double chest opens both halves together
    const wantOpen = invOpen && (activeChest === k || activeChest2 === k);
    const target = wantOpen ? 1 : 0;
    if (Math.abs(target - c.lid) > 0.001) {
      const step = Math.min(1, dt * 7);
      c.lid += (target - c.lid) * step;
    } else c.lid = target;
    c.lidPivot.rotation.x = c.lid * CHEST_OPEN_ANGLE;
    // tint by world light at the chest cell (same approximation the doors use)
    const bl = getLightWorld(c.x, c.y, c.z) / 15;
    const sky = getSkyWorld(c.x, c.y, c.z) / 15;
    const skyF = 0.12 + 0.88 * sky * sky;
    const sun = sharedUniforms.uAmbient.value + sharedUniforms.uDirect.value;
    const br = Math.min(1, skyF * sun * 0.92 + (bl * 0.45 + bl * bl * 0.85));
    if (Math.abs(br - c.lastB) > 0.02) {
      c.lastB = br;
      for (const mt of c.mats) mt.color.setScalar(br).convertSRGBToLinear();
    }
  }
}

/* ---------------------------------- GUI ---------------------------------- */
// Rendered to the RIGHT of the inventory. A single chest is CHEST_ROWS x CHEST_COLS; a double
// stacks a second identical grid above it, giving the 14 x 5 the design calls for. The grid
// lives in a fixed-height scroller so a double chest can't run off the screen.
function buildChestPanel() {
  const panel = document.getElementById('chestPanel');
  if (!panel) return;
  const a = activeChest && CHESTS.get(activeChest);
  if (!a) { panel.style.display = 'none'; return; }
  const b = activeChest2 && CHESTS.get(activeChest2);
  panel.style.display = 'flex';
  panel.innerHTML = `<div class="ctitle">${b ? 'Large Chest' : 'Chest'}</div>`;
  const mkGrid = (arr, region) => {
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.dataset.region = region;
    for (let row = 0; row < CHEST_ROWS; row++) {       // row 0 renders at the bottom
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      for (let col = 0; col < CHEST_COLS; col++) {
        const div = document.createElement('div');
        div.className = 'slot';
        div.innerHTML = slotInner(arr[row * CHEST_COLS + col]);
        rowEl.appendChild(div);
      }
      grid.appendChild(rowEl);
    }
    return grid;
  };
  // 5 x 7 fits on screen outright, and a double is only 10 rows — no scroller needed
  if (b) panel.appendChild(mkGrid(b.slots, 'chest2'));      // partner sits above
  panel.appendChild(mkGrid(a.slots, 'chest'));
}

/* ---------------------------------- save / load ---------------------------------- */
function serializeChests() {
  const out = [];
  for (const [k, c] of CHESTS) {
    if (!c.slots.some(s => s)) continue;               // skip empties, they rebuild from the block
    out.push([k, c.slots.map(s => s ? [s.id, s.count, s.dur ?? null] : null)]);
  }
  return out;
}
function restoreChests(list) {
  if (!Array.isArray(list)) return;
  for (const rec of list) {
    if (!Array.isArray(rec) || typeof rec[0] !== 'string') continue;
    const c = mkChest();
    const arr = Array.isArray(rec[1]) ? rec[1] : [];
    for (let i = 0; i < CHEST_SLOTS && i < arr.length; i++) {
      const s = arr[i];
      if (!Array.isArray(s)) continue;
      const [id, count, dur] = s;
      if (!(PROPS[id] || ITEM_PROPS[id])) continue;
      const slot = mkSlot(id, Math.max(1, count | 0));
      if (dur != null) slot.dur = dur;
      c.slots[i] = slot;
    }
    CHESTS.set(rec[0], c);
  }
}
