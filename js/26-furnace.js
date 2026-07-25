'use strict';
/* voxiCraft — furnace: per-block smelting state, tick, and GUI panel

   State lives in FURNACES ("x,y,z" -> record), persisted inside the world save.
   slots: [0]=fuel, [1]=input, [2]=output. Fuel is measured in smelt CHARGES:
   coal = 8 smelts, coal chunk = 1. A charge batch is consumed from the fuel slot
   when a smelt needs it; each finished smelt burns one charge. The furnace keeps
   smelting while the GUI is closed, and the block's front face swaps to the
   burning texture (variant V.FURNACE_ON) whenever it is actively smelting. */

const FURNACES = new Map();                 // "x,y,z" -> {slots, burn, burnMax, progress, lit}
let activeFurnace = null;                   // key of the furnace whose GUI is open (null = none)

const SMELT = { [B.SAND]: B.GLASS, [B.COBBLE]: B.STONE,       // input id -> output id
                [ITEM.RAW_IRON]: ITEM.IRON_INGOT, [ITEM.RAW_GOLD]: ITEM.GOLD_INGOT,
                [B.LOG]: ITEM.CHARCOAL, [B.BIRCH_LOG]: ITEM.CHARCOAL,
                [ITEM.CLAY_BALL]: ITEM.BRICK, [ITEM.FLOUR]: ITEM.BREAD,
                [ITEM.RAW_COPPER]: ITEM.COPPER_INGOT, [ITEM.RAW_TIN]: ITEM.TIN_INGOT,
};
const FUEL_SMELTS = {                                          // fuel id -> smelts' worth of burn
  [ITEM.COAL]: 8, [ITEM.COAL_CHUNK]: 1, [ITEM.CHARCOAL]: 4,
  [B.LOG]: 2, [B.BIRCH_LOG]: 2, [B.PLANKS]: 0.75, [ITEM.STICK]: 0.25,
  [ITEM.WOODEN_PICKAXE]: 2.5, [ITEM.WOODEN_HATCHET]: 2, [ITEM.WOODEN_HOE]: 1.5, [ITEM.WOODEN_SHOVEL]: 1, 
};
const SMELT_TIME = 6;                                          // seconds per item

const furnaceKey = (x, y, z) => x + ',' + y + ',' + z;
const mkFurnace = () => ({ slots: [null, null, null], burn: 0, burnMax: 1, progress: 0, lit: false });

function openFurnace(x, y, z) {
  const k = furnaceKey(x, y, z);
  if (!FURNACES.has(k)) FURNACES.set(k, mkFurnace());
  activeFurnace = k;
  toggleInventory(true);
}

// block was broken (or replaced): spill contents, forget state, close the GUI if it was open
function furnaceBroken(x, y, z) {
  const k = furnaceKey(x, y, z);
  const f = FURNACES.get(k);
  if (!f) return;
  FURNACES.delete(k);
  if (!player.canFly)
    for (const s of f.slots) if (s) for (let n = 0; n < s.count; n++) spawnDrop(s.id, x, y, z);
  if (activeFurnace === k) { activeFurnace = null; if (invOpen) toggleInventory(false); }
}

function updateFurnaces(dt) {
  for (const [k, f] of FURNACES) {
    const p = k.split(','), x = +p[0], y = +p[1], z = +p[2];
    if ((getBlock(x, y, z) & 255) !== B.FURNACE) continue;   // chunk unloaded (0) — tick pauses
    const inn = f.slots[1], out = f.slots[2];
    const res = inn ? SMELT[inn.id] : undefined;
    // output rule: result must fit — empty slot, or same id with room
    const canSmelt = res !== undefined && (!out || (out.id === res && out.count < stackSize(res)));
    // ignite only when a smelt can start — but once lit, fuel burns down to zero regardless
    if (f.burn <= 0 && canSmelt) {
      const fuel = f.slots[0];
      const n = fuel ? FUEL_SMELTS[fuel.id] : 0;
      if (n) {
        fuel.count--;
        if (fuel.count <= 0) f.slots[0] = null;
        f.burn = f.burnMax = n * SMELT_TIME;
        _refreshFurnaceSlots(k);
      }
    }
    const lit = f.burn > 0;
    if (lit) f.burn = Math.max(0, f.burn - dt);
    if (lit && canSmelt) {
      f.progress += dt / SMELT_TIME;
      if (f.progress >= 1) {
        f.progress = 0;
        inn.count--;
        if (inn.count <= 0) f.slots[1] = null;
        if (out) out.count++; else f.slots[2] = mkSlot(res, 1);
        _refreshFurnaceSlots(k);
      }
    } else f.progress = 0;
    if (lit !== f.lit) {                                     // swap the front face + light on/off
      f.lit = lit;
      const facing = (getBlock(x, y, z) >> 8) & 3;           // keep the rotation bits
      setBlock(x, y, z, B.FURNACE | ((facing | (lit ? V.FURNACE_ON : 0)) << 8));
    }
  }
  _updateFurnaceBars();
}

/* ---- GUI ---- */
// layout:  [input] [progress→] [output]
//          [flame]
//          [fuel]
function buildFurnacePanel() {
  const panel = document.getElementById('furnacePanel');
  if (!panel) return;
  const f = activeFurnace && FURNACES.get(activeFurnace);
  if (!f) { panel.style.display = 'none'; return; }
  panel.style.display = 'flex';
  const bar = (cls) =>
    `<div class="fbar ${cls}"><img class="fbase" src="textures/Gui/Interactables/Lit_progress.png" alt="">` +
    `<div class="ffill"><img src="textures/Gui/Interactables/Lit_progress.png" alt=""></div></div>`;
  panel.innerHTML =
    `<div class="ctitle">Furnace</div>` +
    `<div id="furnGrid">` +
      `<div class="fcol">` +
        `<div class="slot" data-fi="1">${slotInner(f.slots[1])}</div>` +
        bar('ffuel') +
        `<div class="slot" data-fi="0">${slotInner(f.slots[0])}</div>` +
      `</div>` +
      bar('fprog rot') +
      `<div class="slot fout" data-fi="2">${slotInner(f.slots[2])}</div>` +
    `</div>`;
  _updateFurnaceBars();
}

// refresh only the three furnace slots in place (does not disturb the drag ghost)
function _refreshFurnaceSlots(k) {
  if (!invOpen || activeFurnace !== k) return;
  const panel = document.getElementById('furnacePanel');
  const f = FURNACES.get(k);
  if (!panel || !f) return;
  for (const el of panel.querySelectorAll('.slot'))
    el.innerHTML = slotInner(f.slots[+el.dataset.fi]);
}

// per-frame: fuel bar drains top-to-bottom, progress bar (rotated 90°) fills left-to-right
function _updateFurnaceBars() {
  if (!invOpen || !activeFurnace) return;
  const panel = document.getElementById('furnacePanel');
  const f = FURNACES.get(activeFurnace);
  if (!panel || !f || panel.style.display === 'none') return;
  const fuelFill = panel.querySelector('.ffuel .ffill');
  const progFill = panel.querySelector('.fprog .ffill');
  if (fuelFill) fuelFill.style.height = Math.round((f.burn / f.burnMax) * 100) + '%';
  if (progFill) progFill.style.height = Math.round(f.progress * 100) + '%';
}
