'use strict';
/* voxiCraft — experience & levels (0.7)

   WHAT COUNTS
   -----------
   Experience comes from doing things to the WORLD, never from rearranging your own build.
   Breaking a naturally-generated block pays; breaking a block you placed yourself pays nothing,
   and placing one never pays at all. Without that rule a stack of dirt is an infinite XP loop:
   place, break, place, break. `playerPlaced` (below) is the ledger that makes the distinction.

   NO ORBS
   -------
   There is no floating orb entity. A gain applies to the total the instant it is earned, which
   also means there is nothing to lose on death: `playerXP` is untouched when you die, and the
   respawn keeps the level you had. Levels are a permanent record of what you have done, and are
   here to be spent on skill points later — nothing consumes them yet.

   THE CURVE
   ---------
   Each level costs THREE TIMES the last: 40, 120, 360, 1080, ... Deliberately steep — a level is
   meant to be an achievement worth a skill point, not a thing you tick over every few minutes. */

let playerXP = 0;                  // total experience points earned this world, never spent
let playerLevel = 0;               // derived from playerXP; cached so the HUD needn't recompute
let playerXPInLevel = 0, playerXPNeeded = 40;  // progress within the current level

const XP_LEVEL_BASE = 40, XP_LEVEL_MUL = 3;
// points needed to go from `lvl` to `lvl + 1`: 40, 120, 360, 1080, ...
function xpToNext(lvl) { return XP_LEVEL_BASE * Math.pow(XP_LEVEL_MUL, lvl); }
// recompute level + in-level progress from the running total
function _recalcLevel() {
  let lvl = 0, rest = playerXP;
  for (;;) {
    const need = xpToNext(lvl);
    if (rest < need) break;
    rest -= need; lvl++;
  }
  const leveled = lvl > playerLevel;
  playerLevel = lvl;
  playerXPInLevel = rest;
  playerXPNeeded = xpToNext(lvl);
  return leveled;
}

/* The one entry point. Silently ignored in creative — a build mode has nothing to earn. */
function addXP(n) {
  if (!(n > 0)) return;
  if (typeof player !== 'undefined' && player.canFly) return;
  const gain = Math.round(n);
  playerXP += gain;
  const leveled = _recalcLevel();
  xpBarDirty = true;
  _queueXPPop(gain);
  if (leveled) {
    if (typeof playSound === 'function') playSound('levelUp', { gain: 0.8 });
    if (typeof toast === 'function') toast(`Level ${playerLevel}`);
    _xpFlash = 0.7;
  }
}
// world load / reset
function setXP(total) {
  playerXP = Math.max(0, Math.floor(+total || 0));
  playerLevel = 0;
  _recalcLevel();
  xpBarDirty = true;
}
function resetXP() { setXP(0); }

/* ---- what each source is worth ----
   A plain block is a single point; anything that took a tool, a fight or a furnace pays more.
   Ores are far and away the best rate — they are the reason to go down, and the only source that
   makes the ×3 curve climbable at any speed. */
const XP_BLOCK_DEFAULT = 1;
const XP_BLOCK = {};
{
  const set = (id, n) => { XP_BLOCK[id] = n; };
  set(B.COAL_ORE, 14); set(B.IRON_ORE, 22); set(B.COPPER_ORE, 18); set(B.TIN_ORE, 18);
  set(B.GOLD_ORE, 35); set(B.DIAMOND_ORE, 70);
  set(B.SULFUR_BLOCK, 8); set(B.OBSIDIAN, 25); set(B.GLOWSTONE, 12);
  // scenery is free — you are not going to grind a level out of grass
  set(B.TALLGRASS, 0); set(B.TALL_LOWER, 0); set(B.TALL_UPPER, 0);
  set(B.LEAVES, 0); set(B.BIRCH_LEAVES, 0); set(B.SPRUCE_LEAVES, 0);
  set(B.CARPET, 0); set(B.SNOW_CARPET, 0); set(B.COBBLESTONE, 0); set(B.STONE_BRICK, 0);
}
const XP_MOB = 25;                 // a kill — a fight is worth a good few ore veins' worth of swing
const XP_HARVEST = 1;              // a bush pickup that actually yielded something
const XP_SMELT = 3;                // one item out of a furnace

/* Crafting pays by what you MADE. Converting a log into planks is not an accomplishment; forging
   a diamond pickaxe or a chestplate is. Anything not listed falls back to XP_CRAFT_DEFAULT. The
   bulk shape-changers below still pay 1 — a token for the work — which is small enough that
   looping them is a far worse rate than simply mining. */
const XP_CRAFT_DEFAULT = 2;
const XP_CRAFT = {};
{
  const set = (id, n) => { XP_CRAFT[id] = n; };
  // pure conversions / bulk: a token point each
  set(B.PLANKS, 1); set(B.BIRCH_PLANKS, 1); set(B.SPRUCE_PLANKS, 1);
  set(ITEM.STICK, 1); set(B.OAKSLAB, 1); set(B.STONE_BRICK, 1);
  set(ITEM.IRON_NUGGET, 1); set(ITEM.IRON_INGOT, 1); set(ITEM.GOLD_NUGGET, 1);
  set(ITEM.GOLD_INGOT, 1); set(ITEM.TIN_NUGGET, 1); set(ITEM.TIN_INGOT, 1);
  set(ITEM.COPPER_NUGGET, 1); set(ITEM.COPPER_INGOT, 1); set(ITEM.COAL_CHUNK, 1);
  set(ITEM.COAL, 1); set(B.SNOW, 1); set(B.CLAY, 1); set(B.HAY, 1);
  // simple goods
  set(B.TORCH, 1); set(ITEM.BOWL, 1); set(ITEM.PAPER, 1); set(ITEM.SUGAR, 1);
  set(ITEM.FLOUR, 2); set(ITEM.CLOTH, 4); set(B.GLASS, 2); set(B.BRICKS, 2);
  // stations and furniture: a real milestone the first time
  set(B.CRAFTING_BENCH, 10); set(B.FURNACE, 15); set(B.CHEST, 12);
  set(B.BED, 25); set(B.DOOR, 10); set(B.TNT, 30);
  // tools, by tier — the shape of your progression, so the payout follows it
  const toolTier = (n, ...ids) => { for (const i of ids) set(i, n); };
  toolTier(6,  ITEM.WOODEN_SWORD, ITEM.WOODEN_SHOVEL, ITEM.WOODEN_PICKAXE, ITEM.WOODEN_HATCHET, ITEM.WOODEN_HOE);
  toolTier(12, ITEM.STONE_SWORD, ITEM.STONE_SHOVEL, ITEM.STONE_PICKAXE, ITEM.STONE_HATCHET, ITEM.STONE_HOE);
  toolTier(30, ITEM.IRON_SWORD, ITEM.IRON_SHOVEL, ITEM.IRON_PICKAXE, ITEM.IRON_HATCHET, ITEM.IRON_HOE);
  toolTier(40, ITEM.GOLDEN_SWORD, ITEM.GOLDEN_SHOVEL, ITEM.GOLDEN_PICKAXE, ITEM.GOLDEN_HATCHET, ITEM.GOLDEN_HOE);
  toolTier(80, ITEM.DIAMOND_SWORD, ITEM.DIAMOND_SHOVEL, ITEM.DIAMOND_PICKAXE, ITEM.DIAMOND_HATCHET, ITEM.DIAMOND_HOE);
  set(ITEM.IRON_SHEARS, 20); set(ITEM.BUCKET, 15);
  // armor scales with how much iron went into it
  set(ITEM.IRON_GLOVES, 35); set(ITEM.IRON_BOOTS, 45); set(ITEM.IRON_HELMET, 55);
  set(ITEM.IRON_LEGGINGS, 75); set(ITEM.IRON_CHESTPLATE, 95);
  // food
  set(ITEM.MUSHROOM_STEW, 4); set(ITEM.PUMPKIN_PIE, 8); set(ITEM.GOLDEN_APPLE, 60);
  set(ITEM.GUNPOWDER, 6); set(ITEM.GLOW_DUST, 8);
}
const craftXP = (outId) => (XP_CRAFT[outId] != null ? XP_CRAFT[outId] : XP_CRAFT_DEFAULT);

/* Loot chests pay by TABLE, not by what happened to roll out of it — the reward is for finding
   and opening the thing. A table declares its own `xp: [min, max]` (supply crate = 4..10); one
   without the field falls back to this range. Paid once, on the first open, alongside the roll. */
const XP_LOOT_DEFAULT = [3, 8];
function awardLootXP(table) {
  const r = table && Array.isArray(table.xp) ? table.xp : XP_LOOT_DEFAULT;
  const lo = Math.max(0, r[0] | 0), hi = Math.max(lo, r[1] | 0);
  addXP(lo + Math.floor(Math.random() * (hi - lo + 1)));
}

/* ---- the player-placed ledger ----
   Keys are "x,y,z". A cell goes in when the player places into it and comes out the moment that
   block is broken (or overwritten), so the set only ever holds standing player work. Falling
   sand/gravel and blocks pushed around by fluids are not tracked — the ledger is about intent,
   and those cases are too marginal to be worth an XP exploit. */
const playerPlaced = new Set();
let _placingByPlayer = false;      // set around a place action; setBlock reads it
const pkey = (x, y, z) => x + ',' + y + ',' + z;
// wrap a placement so every setBlock it performs is credited to the player
function withPlayerPlacement(fn) {
  const prev = _placingByPlayer;
  _placingByPlayer = true;
  try { return fn(); } finally { _placingByPlayer = prev; }
}
function notePlacedCell(x, y, z, newId) {
  if (newId === B.AIR) playerPlaced.delete(pkey(x, y, z));
  else if (_placingByPlayer) playerPlaced.add(pkey(x, y, z));
}
// true when this cell is the player's own work — and clears it, since it is being broken now
function takePlayerPlaced(x, y, z) {
  const k = pkey(x, y, z);
  if (!playerPlaced.has(k)) return false;
  playerPlaced.delete(k);
  return true;
}
/* Award for breaking a block. Player-placed cells pay nothing AND lose their mark, so the
   dirt-tower loop nets exactly zero however many times it is run. */
function awardBlockXP(x, y, z, id) {
  if (takePlayerPlaced(x, y, z)) return;
  const n = XP_BLOCK[id] != null ? XP_BLOCK[id] : XP_BLOCK_DEFAULT;
  addXP(n);
}

function serializeXP() { return { xp: playerXP, placed: [...playerPlaced] }; }
function restoreXP(rec) {
  playerPlaced.clear();
  if (!rec) { resetXP(); return; }
  setXP(rec.xp);
  if (Array.isArray(rec.placed)) for (const k of rec.placed) playerPlaced.add(k);
}

/* ---- HUD bar ----
   Minecraft's placement (a strip above the hotbar, level number centred on it) but a plain
   smooth bar rather than the segmented notch sprite — a light-green fill on a dark track. */
const xpBarEl = document.getElementById('xpBar');
const xpFillEl = document.getElementById('xpFill');
const xpLevelEl = document.getElementById('xpLevel');
const xpPopsEl = document.getElementById('xpPops');
let xpBarDirty = true;
let _xpFlash = 0;                  // seconds of level-up glow left

/* ---- gain popups ----
   A "+N" that drifts up off the RIGHT end of the bar and fades. Every gain gets its OWN number:
   two "+3"s in a row read as two picks, which is the honest thing to show — they are not summed
   into a "+6" that hides how it was earned.

   Separate numbers only work if they do not land on top of each other, so each new popup is
   dealt the next slot in a rotating ladder: a fixed vertical step per slot, alternating a few
   pixels left and right. Consecutive gains stagger up the ladder and stay individually legible
   even when they arrive in the same second. */
const XP_POP_SLOTS = 5;            // rungs before the ladder wraps
const XP_POP_STEP = 15;            // px of vertical separation per rung
let _popSlot = 0;
function _queueXPPop(n) {
  if (!xpPopsEl || n <= 0) return;
  const el = document.createElement('div');
  el.className = 'xpPop';
  el.textContent = '+' + n;
  el.style.setProperty('--dy0', (_popSlot * XP_POP_STEP) + 'px');
  el.style.setProperty('--dx', ((_popSlot % 2) ? 7 : -3) + 'px');
  _popSlot = (_popSlot + 1) % XP_POP_SLOTS;
  xpPopsEl.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function updateXPBar(dt) {
  if (!xpBarEl) return;
  const show = typeof currentInvMode !== 'undefined' && currentInvMode === 'survival'
               && typeof playing !== 'undefined' && playing && !menuScene;
  if (_xpFlash > 0) { _xpFlash = Math.max(0, _xpFlash - (dt || 0)); xpBarDirty = true; }
  if (xpBarEl._shown !== show) {
    xpBarEl.style.display = show ? 'block' : 'none';
    if (xpPopsEl) xpPopsEl.style.display = show ? 'block' : 'none';
    xpBarEl._shown = show;
  }
  if (!show || !xpBarDirty) return;
  xpBarDirty = false;
  const frac = playerXPNeeded > 0 ? Math.max(0, Math.min(1, playerXPInLevel / playerXPNeeded)) : 0;
  xpFillEl.style.width = (frac * 100).toFixed(2) + '%';
  xpLevelEl.textContent = playerLevel > 0 ? String(playerLevel) : '';
  xpBarEl.classList.toggle('flash', _xpFlash > 0);
}
