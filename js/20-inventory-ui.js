'use strict';
/* voxiCraft — inventory grid UI, drag & drop, radial picker */

const invEl = document.getElementById('inv');
const invWrapEl = document.getElementById('invWrap');
let invOpen = false;

// Slot: null (empty) OR `{id, count}`. `slotInner` renders the 3D icon and a stack-count badge
// when count > 1. Future non-block items would branch on an item table for their flat icon.
const slotArr = (r) => r === 'hot' ? HOTBAR
  : r === 'fur' ? ((activeFurnace && FURNACES.get(activeFurnace)) || mkFurnace()).slots
  : r === 'chest'  ? ((activeChest  && CHESTS.get(activeChest))  || mkChest()).slots
  : r === 'chest2' ? ((activeChest2 && CHESTS.get(activeChest2)) || mkChest()).slots
  : r === 'inv2' ? invSlots2
  : invSlots;
// tools render a durability bar (hidden while still full, MC-style): green -> red as it wears
const slotDurBar = (s) => {
  const maxD = s.dur != null && s.id >= 256 ? ITEM_PROPS[s.id]?.durability : null;
  if (!maxD || s.dur >= maxD) return '';
  const pct = s.dur / maxD;
  return `<span class="dur"><i style="width:${Math.max(4, pct * 100)}%;background:hsl(${(pct * 120) | 0},75%,45%)"></i></span>`;
};
const slotInner = (s) => s == null ? ''
  : `<img class="i3d" src="${renderBlockIcon(s.id)}" alt="">${s.count > 1 ? `<span class="cnt">${s.count}</span>` : ''}${slotDurBar(s)}`;

function buildInventory() {
  // hide both side panels first; the right one is rebuilt below
  const cpEl = document.getElementById('craftPanel');
  if (cpEl) cpEl.style.display = 'none';
  const fpEl = document.getElementById('furnacePanel');
  if (fpEl) fpEl.style.display = 'none';
  const chpEl = document.getElementById('chestPanel');
  if (chpEl) chpEl.style.display = 'none';

  invEl.innerHTML =
    '<div class="title">Inventory</div>' +
    '<div class="hint">drag: hold <b>LMB</b>/<b>A</b> &middot; quick-move: <b>Shift+LMB</b>/<b>Y</b> &middot; sort: <b>MMB</b> &middot; close: <b>E</b>/<b>B</b></div>';
  // one N×9 grid bound to a slot array + region; DOM order == slot index (slot 0 = bottom-left)
  const mkGrid = (arr, region) => {
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.dataset.region = region;
    const rows = Math.ceil(arr.length / 9);       // row count follows the array, not a fixed 3
    for (let row = 0; row < rows; row++) {        // row 0 renders at the bottom
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      for (let col = 0; col < 9; col++) {
        const div = document.createElement('div');
        div.className = 'slot';
        div.innerHTML = slotInner(arr[row * 9 + col]);
        rowEl.appendChild(div);
      }
      grid.appendChild(rowEl);
    }
    return grid;
  };
  // Creative: the overflow palette sits ABOVE the main grid inside a fixed-height scroller, so
  // adding rows to it grows the scroll range instead of the panel.
  if (player.canFly) {
    const scroller = document.createElement('div');
    scroller.className = 'invScroll';
    scroller.appendChild(mkGrid(invSlots2, 'inv2'));
    invEl.appendChild(scroller);
    scroller.scrollTop = scroller.scrollHeight;     // start at the bottom row, next to the main grid
  }
  invEl.appendChild(mkGrid(invSlots, 'inv'));
  // survival: crafting list on the left, plus the furnace GUI on the right when one is open
  if (!player.canFly) buildCraftPanel();
  if (activeFurnace) buildFurnacePanel();
  if (activeChest) buildChestPanel();
}
function refreshSlotsUI() { buildHotbar(); buildInventory(); saveAll(); }

/* ---- virtual cursor + drag ghost (one shared cursor for mouse & gamepad) ---- */
const vcurEl = document.createElement('div');  vcurEl.id = 'vcursor';  document.body.appendChild(vcurEl);
const vdragEl = document.createElement('div'); vdragEl.id = 'vdrag';   document.body.appendChild(vdragEl);
const ctipEl  = document.createElement('div'); ctipEl.id  = 'ctip';    document.body.appendChild(ctipEl);
const invCursor = { x: innerWidth / 2, y: innerHeight / 2, mode: 'mouse' };
let dragFrom = null, dragHeld = null;           // {region,i} being dragged + the block id in hand

// slot geometry is coordinate-based (getBoundingClientRect), so the pointer-events:none hotbar
// row is a valid drag target too — hotbar and grid behave as one connected slot space.
function slotDescriptors() {
  const out = [];
  const hs = hotbarEl.children;
  for (let i = 0; i < hs.length; i++) out.push({ region: 'hot', i, el: hs[i] });
  for (const g of invEl.querySelectorAll('.grid')) {   // one entry per grid; region from data-region
    const region = g.dataset.region, gs = g.querySelectorAll('.slot');
    for (let i = 0; i < gs.length; i++) out.push({ region, i, el: gs[i] });   // DOM order == slot index
  }
  const fp = document.getElementById('furnacePanel');
  if (fp && fp.style.display !== 'none')
    for (const el of fp.querySelectorAll('.slot')) out.push({ region: 'fur', i: +el.dataset.fi, el });
  const chp = document.getElementById('chestPanel');
  if (chp && chp.style.display !== 'none')
    for (const g of chp.querySelectorAll('.grid')) {        // 'chest' and, for a double, 'chest2'
      const region = g.dataset.region, gs = g.querySelectorAll('.slot');
      for (let i = 0; i < gs.length; i++) out.push({ region, i, el: gs[i] });
    }
  return out;
}
function slotAtPoint(x, y) {
  for (const d of slotDescriptors()) {
    const r = d.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return d;
  }
  return null;
}
function nearestSlot(x, y) {
  let best = null, bd = 1e9;
  for (const d of slotDescriptors()) {
    const r = d.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, dist = Math.hypot(x - cx, y - cy);
    if (dist < bd) { bd = dist; best = { region: d.region, i: d.i, el: d.el, cx, cy, dist }; }
  }
  return best;
}
function hoveredSlot() {                         // slot under the cursor, else the nearest if close
  return slotAtPoint(invCursor.x, invCursor.y) || (() => {
    const n = nearestSlot(invCursor.x, invCursor.y); return n && n.dist < 34 ? n : null;
  })();
}

/* ---- item tooltip ----
   One fixed-width panel: name, then the (author-supplied) description, then a stat block that
   depends on what the thing is. Tools list wear + combat + mining numbers, food lists what it
   restores. Blocks and plain materials show just the name and description. */
const _tipNum = (n) => Number.isInteger(n) ? String(n) : (+n).toFixed(2).replace(/\.?0+$/, '');
const _tipEsc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
function itemTooltipHTML(id, dur) {
  if (id == null) return '';
  const isItem = id >= 256;
  const p = isItem ? ITEM_PROPS[id] : PROPS[id];
  if (!p) return '';
  let html = `<div class="tipName">${_tipEsc(p.name || '')}</div>`;
  if (p.desc) html += `<div class="tipDesc">${_tipEsc(p.desc)}</div>`;
  const rows = [];
  if (p.tool) {
    const maxD = p.durability;
    if (maxD) rows.push(['durability', `${dur != null ? dur : maxD}/${maxD}`]);
    if (p.damage != null) rows.push(['damage', _tipNum(p.damage)]);
    if (p.attackSpeed != null) rows.push(['attack speed', _tipNum(p.attackSpeed)]);
    if (p.toolSpeed != null) rows.push(['mine speed', _tipNum(p.toolSpeed)]);
  }
  if (p.food != null) {
    rows.push(['food', _tipNum(p.food)]);
    if (p.foodSat != null) rows.push(['sat', _tipNum(p.foodSat)]);
    if (p.foodSatFull != null) rows.push(['satAtFull', _tipNum(p.foodSatFull)]);
    rows.push(['consume time', _tipNum(p.eatTime ?? EAT_TIME) + 's']);
  }
  if (rows.length) {
    html += '<div class="tipStats">';
    for (const [k, v] of rows) html += `<div class="tipRow"><span>${k}</span><b>${v}</b></div>`;
    html += '</div>';
  }
  return html;
}
// place the panel near the cursor but always fully on screen
function showTooltip(html) {
  ctipEl.innerHTML = html;
  ctipEl.style.display = 'block';
  const r = ctipEl.getBoundingClientRect();
  let x = invCursor.x + 16, y = invCursor.y + 18;
  if (x + r.width > window.innerWidth - 6) x = invCursor.x - r.width - 12;
  if (y + r.height > window.innerHeight - 6) y = invCursor.y - r.height - 12;
  ctipEl.style.left = Math.max(6, x) + 'px';
  ctipEl.style.top = Math.max(6, y) + 'px';
}

// crafting icons: get all .cing (ingredients) and .cbtn (output) with title attributes for tooltips
function getCraftingElements() {
  const out = [];
  const cp = document.getElementById('craftPanel');
  if (!cp || cp.style.display === 'none') return out;
  // data-id carries the real block/item so the tooltip can show the full stat panel, not just a name
  const ings = cp.querySelectorAll('.cing');
  for (const el of ings)
    out.push({ el, title: el.dataset.name || '', id: +el.dataset.id, type: 'craft' });
  for (const btn of cp.querySelectorAll('.cbtn'))
    out.push({ el: btn, title: btn.dataset.name || '', id: +btn.dataset.id, type: 'craft' });
  return out;
}

// nearest interactive element: slots or crafting icons, used for cursor magnet + tooltip
function nearestElement(x, y) {
  let best = null, bd = 1e9;
  for (const d of slotDescriptors()) {
    const r = d.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, dist = Math.hypot(x - cx, y - cy);
    if (dist < bd) { bd = dist; best = { el: d.el, cx, cy, dist, type: 'slot' }; }
  }
  for (const d of getCraftingElements()) {
    const r = d.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, dist = Math.hypot(x - cx, y - cy);
    if (dist < bd) { bd = dist; best = { el: d.el, cx, cy, dist, type: 'craft', title: d.title, id: d.id }; }
  }
  return best;
}

/* ---- drag / transfer actions, shared by mouse and gamepad ---- */
// pick up from a slot into the hand. take: 'all' | 'half' | 1
function pickUp(region, i, take = 'all') {
  if (dragHeld) return;
  const arr = slotArr(region), s = arr[i];
  if (s == null) return;
  const n = Math.min(s.count, take === 'all' ? s.count : take === 'half' ? Math.ceil(s.count / 2) : 1);
  dragHeld = carrySlot(s, n);
  s.count -= n;
  if (s.count <= 0) arr[i] = null;
  dragFrom = { region, i };
  refreshSlotsUI();
}
// place from the hand into a slot. n: 'all' | 1. Different id + full place = swap (item stays in hand).
function placeInto(region, i, n = 'all') {
  if (!dragHeld) return;
  if (region === 'fur') {
    if (i === 2) return;                                     // output: take-only
    if (i === 0 && !FUEL_SMELTS[dragHeld.id]) return;        // fuel slot: coal / coal chunk only
  }
  const arr = slotArr(region), dst = arr[i];
  const want = n === 'all' ? dragHeld.count : 1;
  if (dst == null) {
    arr[i] = carrySlot(dragHeld, want);
    dragHeld.count -= want;
  } else if (dst.id === dragHeld.id && dst.count < stackSize(dst.id)) {
    // same id with room to spare: top the target stack up
    const moved = Math.min(stackSize(dst.id) - dst.count, want);
    dst.count += moved; dragHeld.count -= moved;
  } else if (n === 'all') {                       // swap: target stack goes into the hand
    // Also the path for two of the SAME stack-1 item (tools). Merging there always moves zero,
    // so without the `dst.count < cap` guard above the click silently did nothing — you could
    // never trade a worn pickaxe for a fresh one.
    const tmp = dst; arr[i] = dragHeld; dragHeld = tmp; dragFrom = { region, i };
    refreshSlotsUI(); return;
  }
  if (dragHeld.count <= 0) { dragHeld = null; dragFrom = null; }
  refreshSlotsUI();
}
/* Middle-click sort: tidies just the grid under the cursor (hotbar, inventory, or an open
   chest). Stacks of the same item merge up to their cap first, then everything orders by name
   and empty slots fall to the end. Worn tools keep their own entry so wear is never averaged.
   The creative palette is deliberately excluded — it is a fixed layout, not storage. */
function sortRegion(region) {
  if (region === 'fur') return;                      // furnace slots are positional, not storage
  if (player.canFly && (region === 'hot' || region === 'inv' || region === 'inv2')) {
    toast('sorting is off in creative');
    return;
  }
  const arr = slotArr(region);
  if (!arr || !arr.length) return;
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    if (s.dur != null) { out.push(carrySlot(s, s.count)); continue; }   // tool: keep its wear
    const cap = stackSize(s.id);
    let left = s.count;
    for (const o of out) {                           // top up any partial stack of the same id
      if (o.id !== s.id || o.dur != null || o.count >= cap) continue;
      const m = Math.min(cap - o.count, left);
      o.count += m; left -= m;
      if (left <= 0) break;
    }
    while (left > 0) { const t = Math.min(cap, left); out.push(mkSlot(s.id, t)); left -= t; }
  }
  const nameOf = (s) => (s.id >= 256 ? ITEM_PROPS[s.id]?.name : PROPS[s.id]?.name) || '';
  out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || b.count - a.count);
  for (let i = 0; i < arr.length; i++) arr[i] = out[i] || null;
  refreshSlotsUI();
}

// legacy pad entry points — same click-carry model
function beginDrag(region, i) { pickUp(region, i, 'all'); }
function endDrag(region, i)   { placeInto(region, i, 'all'); }
function cancelDrag() {                          // return the held item to any room in hotbar+inventory
  if (!dragHeld) return;
  const cap = stackSize(dragHeld.id);
  // never auto-return into furnace slots (output is take-only, fuel is restricted)
  for (const arr of [slotArr(dragFrom && dragFrom.region !== 'fur' ? dragFrom.region : 'hot'), HOTBAR, invSlots])
    for (let i = 0; i < arr.length && dragHeld.count > 0; i++) {
      const s = arr[i];
      if (s && s.id === dragHeld.id && s.count < cap) {
        const t = Math.min(cap - s.count, dragHeld.count);
        s.count += t; dragHeld.count -= t;
      } else if (s == null) {
        arr[i] = carrySlot(dragHeld, Math.min(cap, dragHeld.count));
        dragHeld.count -= arr[i].count;
      }
    }
  dragHeld = null; dragFrom = null;
  refreshSlotsUI();
}
// active-furnace push: for items that are BOTH smeltable AND fuel (e.g. logs), prefer the input
// slot first (empty or same id) and only fall through to fuel when input is blocked. Prevents
// shift-clicking a log ending up as fuel while another log is already smelting.
// Returns amount placed (0 = furnace not open, wrong item, or both slots occupied by another id).
function _pushFurnace(id, want) {
  if (!activeFurnace) return 0;
  const f = FURNACES.get(activeFurnace); if (!f) return 0;
  const isSmelt = SMELT[id] !== undefined;
  const isFuel  = FUEL_SMELTS[id] !== undefined;
  if (!isSmelt && !isFuel) return 0;
  const cap = stackSize(id);
  const tryPush = (slotIdx) => {
    const s = f.slots[slotIdx];
    if (s == null) { f.slots[slotIdx] = mkSlot(id, Math.min(cap, want)); _refreshFurnaceSlots(activeFurnace); return f.slots[slotIdx].count; }
    if (s.id === id && s.count < cap) { const m = Math.min(cap - s.count, want); s.count += m; _refreshFurnaceSlots(activeFurnace); return m; }
    return 0;
  };
  // input first if smeltable (empty or same id); then fuel if fuel-capable
  if (isSmelt) { const m = tryPush(1); if (m > 0) return m; }
  if (isFuel)  { const m = tryPush(0); if (m > 0) return m; }
  return 0;
}
// quick-move destinations, in priority order, for a given source region. The second inventory
// grid (invSlots2) only exists in the creative UI (player.canFly), so include it only then —
// otherwise a full first grid wrongly reports "full" while inv2 sits empty.
function destGrids(region) {
  const useInv2 = player.canFly;
  // an open chest is the natural quick-move target: player grids feed it, and its own slots
  // feed back into the player
  const chestArrs = [];
  if (activeChest && CHESTS.get(activeChest)) chestArrs.push(CHESTS.get(activeChest).slots);
  if (activeChest2 && CHESTS.get(activeChest2)) chestArrs.push(CHESTS.get(activeChest2).slots);
  if (region === 'chest' || region === 'chest2')
    return useInv2 ? [HOTBAR, invSlots, invSlots2] : [HOTBAR, invSlots];
  if (chestArrs.length && (region === 'hot' || region === 'inv' || region === 'inv2'))
    return chestArrs;
  if (region === 'hot')  return useInv2 ? [invSlots, invSlots2] : [invSlots];
  if (region === 'inv')  return useInv2 ? [HOTBAR, invSlots2]   : [HOTBAR];
  if (region === 'inv2') return [HOTBAR, invSlots];
  return useInv2 ? [HOTBAR, invSlots, invSlots2] : [HOTBAR, invSlots];   // furnace output etc.
}
// move exactly 1 item to the other grids (ctrl+right-click)
function transferOne(region, i) {
  const arr = slotArr(region), s = arr[i];
  if (s == null) return;
  // furnace open: route smeltables/fuels straight to the matching furnace slot
  if (region !== 'fur' && _pushFurnace(s.id, 1) > 0) {
    s.count--; if (s.count <= 0) arr[i] = null;
    refreshSlotsUI(); return;
  }
  const cap = stackSize(s.id), dests = destGrids(region);
  let placed = false;
  for (const g of dests) { const p = g.find(o => o && o.id === s.id && o.count < cap); if (p) { p.count++; placed = true; break; } }
  if (!placed) for (const g of dests) { const f = g.indexOf(null); if (f >= 0) { g[f] = carrySlot(s, 1); placed = true; break; } }
  if (!placed) { toast('no space'); return; }
  s.count--;
  if (s.count <= 0) arr[i] = null;
  refreshSlotsUI();
}
function instantTransfer(region, i) {           // shove the whole stack across the other grids
  const arr = slotArr(region), s = arr[i];
  if (s == null) return;
  const cap = stackSize(s.id), dests = destGrids(region);
  let remaining = s.count;
  if (region !== 'fur') {                        // furnace priority: dump smeltable/fuel into its slot first
    const moved = _pushFurnace(s.id, remaining);
    remaining -= moved;
    if (remaining === 0) { arr[i] = null; refreshSlotsUI(); return; }
  }
  // merge into partial stacks of the same id first, across every destination grid
  for (const g of dests)
    for (let k = 0; k < g.length && remaining > 0; k++) {
      const o = g[k];
      if (o && o.id === s.id && o.count < cap) {
        const moved = Math.min(cap - o.count, remaining);
        o.count += moved; remaining -= moved;
      }
    }
  // then land the leftover in the first empty slot found across the grids
  if (remaining > 0) {
    let landed = false;
    for (const g of dests) { const f = g.indexOf(null); if (f >= 0) { g[f] = carrySlot(s, remaining); remaining = 0; landed = true; break; } }
    if (!landed) { s.count = remaining; refreshSlotsUI(); toast('no space'); return; }
  }
  arr[i] = null;
  refreshSlotsUI();
}

function toggleInventory(open, mode) {
  if (open === undefined) open = !invOpen;
  if (open === invOpen && mode === undefined) return;
  if (open) { craftMode = mode || 'basic'; buildInventory(); }   // rebuild with the right recipe list
  if (open === invOpen) return;
  invOpen = open;
  invWrapEl.style.display = open ? 'flex' : 'none';
  if (open) {
    if (document.pointerLockElement) document.exitPointerLock();   // free the cursor
    const r = invEl.getBoundingClientRect();
    invCursor.x = r.left + r.width / 2; invCursor.y = r.top + r.height / 2;
    invCursor.mode = getPad() ? 'pad' : 'mouse';
  } else {
    cancelDrag();
    activeFurnace = null;                       // closing always detaches the furnace GUI
    activeChest = activeChest2 = null;          // ...and the chest, which also shuts its lid
    if (lastHoverEl) { lastHoverEl.classList.remove('hover'); lastHoverEl = null; }
    vcurEl.style.display = vdragEl.style.display = 'none';
    if (playing) { lockTries = 0; tryPointerLock(); }
  }
}

// per-frame: clamp + magnet the pad cursor, position the cursor/ghost, and highlight the hover
function invBounds() {
  const a = invWrapEl.getBoundingClientRect(), b = hotbarEl.getBoundingClientRect();
  return { l: Math.min(a.left, b.left) - 8, r: Math.max(a.right, b.right) + 8, t: a.top - 8, bm: b.bottom + 8 };
}
let lastHoverEl = null;
function updateInvCursorVisual(dt) {
  if (!invOpen) {
    if (lastHoverEl) { lastHoverEl.classList.remove('hover'); lastHoverEl = null; }
    vcurEl.style.display = vdragEl.style.display = ctipEl.style.display = 'none';
    return;
  }
  const bnd = invBounds();
  invCursor.x = Math.max(bnd.l, Math.min(bnd.r, invCursor.x));
  invCursor.y = Math.max(bnd.t, Math.min(bnd.bm, invCursor.y));
  if (invCursor.mode === 'pad') {                // magnet snaps to nearest element, but ONLY when
    const n = nearestElement(invCursor.x, invCursor.y);   // the stick is idle — so an active push can
    // crafting icons are small, so they get a wider capture radius and a harder pull
    const snapR = n && n.type === 'craft' ? 120 : 80;
    if (n && n.dist < snapR && (pad.invStick || 0) < 0.2) {
      const k = Math.min(1, dt * (n.type === 'craft' ? 30 : 20));
      invCursor.x += (n.cx - invCursor.x) * k;
      invCursor.y += (n.cy - invCursor.y) * k;
    }
    vcurEl.style.display = 'block';
    vcurEl.style.left = invCursor.x + 'px';
    vcurEl.style.top = invCursor.y + 'px';
  } else {
    vcurEl.style.display = 'none';
  }
  const hov = hoveredSlot(), hovEl = hov ? hov.el : null;
  if (hovEl !== lastHoverEl) {
    if (lastHoverEl) lastHoverEl.classList.remove('hover');
    if (hovEl) hovEl.classList.add('hover');
    lastHoverEl = hovEl;
  }
  // Tooltip: full item panel over any occupied slot, name-only over crafting icons. Suppressed
  // while dragging, since the cursor is already carrying a visible stack.
  const ne = nearestElement(invCursor.x, invCursor.y);
  const tipR = invCursor.mode === 'pad' ? 60 : 24;
  const hovSlot = hov && slotArr(hov.region)[hov.i];
  if (dragHeld) {
    ctipEl.style.display = 'none';
  } else if (hovSlot) {
    showTooltip(itemTooltipHTML(hovSlot.id, hovSlot.dur));
  } else if (ne && ne.type === 'craft' && ne.dist < tipR && ne.title) {
    // recipe icons get the same full panel as a real slot (no durability — it isn't an instance)
    showTooltip(Number.isFinite(ne.id) ? itemTooltipHTML(ne.id, null)
                                       : `<div class="tipName">${_tipEsc(ne.title)}</div>`);
  } else {
    ctipEl.style.display = 'none';
  }
  if (dragHeld) {
    vdragEl.style.display = 'block';
    vdragEl.style.left = invCursor.x + 'px';
    vdragEl.style.top = invCursor.y + 'px';
    const dragKey = dragHeld ? `${dragHeld.id}:${dragHeld.count}` : '';
    if (vdragEl.dataset.id !== dragKey) { vdragEl.innerHTML = slotInner(dragHeld); vdragEl.dataset.id = dragKey; }
  } else {
    vdragEl.style.display = 'none';
    vdragEl.dataset.id = '';
  }
}

function drawRadial() {
  const c = radialCtx, S = 360, cx = S / 2, cy = S / 2, n = HOTBAR.length;
  const step = (Math.PI * 2) / n;
  c.clearRect(0, 0, S, S);
  c.imageSmoothingEnabled = true;   // 3D icons are supersampled — smooth downscale
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * step - step / 2 + 0.02;
    const a1 = a0 + step - 0.04;
    c.beginPath();
    c.arc(cx, cy, 168, a0, a1);
    c.arc(cx, cy, 62, a1, a0, true);
    c.closePath();
    c.fillStyle = i === pad.radialSel ? 'rgba(255,255,255,0.32)' : 'rgba(12,14,22,0.78)';
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.stroke();
    const am = -Math.PI / 2 + i * step, r = 115;
    const hid = slotId(HOTBAR[i]);
    const img = hid != null ? ICON_IMG[hid + ':0'] : null;
    if (img && img.complete) c.drawImage(img, cx + Math.cos(am) * r - 18, cy + Math.sin(am) * r - 18, 36, 36);
    // stack-count badge (bottom-right of the icon disc)
    const cnt = slotCount(HOTBAR[i]);
    if (cnt > 1) {
      c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 3;
      c.font = 'bold 14px sans-serif'; c.textAlign = 'right';
      const tx = cx + Math.cos(am) * r + 18, ty = cy + Math.sin(am) * r + 16;
      c.strokeText(cnt, tx, ty); c.fillText(cnt, tx, ty);
    }
  }
  c.fillStyle = '#fff';
  c.font = 'bold 14px sans-serif';
  c.textAlign = 'center';
  const selId = slotId(HOTBAR[pad.radialSel >= 0 ? pad.radialSel : hotbarSel]);
  c.fillText(selId == null ? 'Empty' : PROPS[selId].name, cx, cy + 5);
}

