'use strict';
/* voxiCraft — list-based crafting system (survival only)

   Recipes are a flat list: ingredients on the left, one craft button with the output on
   the right. `E` opens the BASIC list (pocket crafting); right-clicking a crafting bench
   opens the ADVANCED list (basic + bench-only recipes). No grid patterns — having the
   ingredients anywhere in hotbar+inventory is enough. */

/* recipe: { in: [[id, count], ...], out: [id, count] }
   An ingredient id may also be an ARRAY of interchangeable ids — a variant group. Any mix of
   them satisfies the requirement (4 oak + 5 birch planks crafts a bench), and the row's icon
   cycles through the group every CRAFT_VARIANT_MS so you can see what else is accepted. */
const V_PLANKS = [B.PLANKS, B.BIRCH_PLANKS, B.SPRUCE_PLANKS, ];
const V_LOG    = [B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG];
const V_OLOG   = [B.LOG, B.STRIPPED_LOG];
const V_BLOG   = [B.BIRCH_LOG, B.STRIPPED_BIRCH_LOG];
const V_SLOG   = [B.SPRUCE_LOG, B.STRIPPED_SPRUCE_LOG];
const V_STONE  = [B.COBBLE, B.STONE, B.MARBLE, B.LIMESTONE, B.GRANITE];          // anything that takes cobble takes stone too
// leather gear is riveted, not forged: any soft-metal nugget does the job
const V_NUGGET = [ITEM.IRON_NUGGET, ITEM.TIN_NUGGET, ITEM.COPPER_NUGGET];

const RECIPES_BASIC = [
  { in: [[V_OLOG, 1]],                                                       out: [B.PLANKS, 3] },
  { in: [[V_BLOG, 1]],                                                       out: [B.BIRCH_PLANKS, 3] },
  { in: [[V_SLOG, 1]],                                                       out: [B.SPRUCE_PLANKS, 3] },
  { in: [[V_PLANKS, 2]],                                                     out: [ITEM.STICK, 6] },
  { in: [[V_PLANKS, 1]],                                                     out: [B.OAKSLAB, 2] },   // disabled (0.7295)
  { in: [[ITEM.SNOWBALL, 4]],                                                out: [B.SNOW, 1] },
  { in: [[ITEM.WHEAT, 9]],                                                   out: [B.HAY, 1] },
  { in: [[ITEM.CLAY_BALL, 4]],                                               out: [B.CLAY, 1] },
  { in: [[ITEM.COAL, 1]],                                                    out: [ITEM.COAL_CHUNK, 8] },
  { in: [[V_PLANKS, 5], [ITEM.FIBER, 5]],                                    out: [B.CRAFTING_BENCH, 1] },
  { in: [[ITEM.BOWL, 1], [B.RED_MUSHROOM, 1], [B.BROWN_MUSHROOM, 1]],        out: [ITEM.MUSHROOM_STEW, 1] },
  { in: [[ITEM.COAL, 1], [ITEM.STICK, 1], [ITEM.FIBER, 1]],                  out: [B.TORCH, 4] },
  { in: [[ITEM.GLASS_SHARD, 4]],                                             out: [B.GLASS, 1] },
  { in: [[ITEM.SUGAR_CANE, 1]],                                              out: [ITEM.SUGAR, 2] },
  { in: [[B.STONE, 1]],                                                      out: [B.STONE_BRICK, 1] },
  { in: [[ITEM.BRICK, 4]],                                                   out: [B.BRICKS, 1] },
  { in: [[ITEM.STRING, 4]],                                                  out: [B.WOOL, 1] },
  /* Flint tools (0.7341) — the FIRST tier, and the only one reachable with nothing in hand. A
     knapped edge, a handle and a lashing, and every part of that comes out of a bare-handed
     gather: flint from flint stones, fiber from grass, sticks off leaves. No PLANKS, because
     planks need a log and a log is behind the tool gate — but sticks are fine (0.7342), since
     leaves are one of the few things hands still break, and they are a slow drip on purpose. */
  { in: [[ITEM.FLINT, 3], [ITEM.STICK, 2], [ITEM.FIBER, 5]],                 out: [ITEM.FLINT_SWORD, 1] },
  { in: [[ITEM.FLINT, 2], [ITEM.STICK, 3], [ITEM.FIBER, 5]],                 out: [ITEM.FLINT_SHOVEL, 1] },
  { in: [[ITEM.FLINT, 5], [ITEM.STICK, 3], [ITEM.FIBER, 6]],                 out: [ITEM.FLINT_PICKAXE, 1] },
  { in: [[ITEM.FLINT, 4], [ITEM.STICK, 3], [ITEM.FIBER, 6]],                 out: [ITEM.FLINT_HATCHET, 1] },
  { in: [[ITEM.FLINT, 2], [ITEM.STICK, 3], [ITEM.FIBER, 5]],                 out: [ITEM.FLINT_HOE, 1] },
];
const RECIPES_ADVANCED = [
  { in: [[ITEM.COAL_CHUNK, 8]],                                              out: [ITEM.COAL, 1] },
  { in: [[B.STONE, 1], [ITEM.FLINT, 1], [ITEM.COAL, 1]],                     out: [ITEM.GLOW_DUST, 1] },
  // dust packs back into the block it came from, so a light source is craftable rather than found
  { in: [[ITEM.GLOW_DUST, 4]],                                               out: [B.GLOWSTONE, 1] },
  { in: [[V_PLANKS, 3]],                                                     out: [ITEM.BOWL, 4] },
  { in: [[V_STONE, 10]],                                                     out: [B.FURNACE, 1] },
  { in: [[ITEM.IRON_INGOT, 1]],                                              out: [ITEM.IRON_NUGGET, 9] },
  { in: [[ITEM.IRON_NUGGET, 9]],                                             out: [ITEM.IRON_INGOT, 1] },
  { in: [[ITEM.GOLD_INGOT, 1]],                                              out: [ITEM.GOLD_NUGGET, 9] },
  { in: [[ITEM.GOLD_NUGGET, 9]],                                             out: [ITEM.GOLD_INGOT, 1] },
  { in: [[ITEM.TIN_INGOT, 1]],                                               out: [ITEM.TIN_NUGGET, 9] },
  { in: [[ITEM.TIN_NUGGET, 9]],                                              out: [ITEM.TIN_INGOT, 1] },
  { in: [[ITEM.COPPER_INGOT, 1]],                                            out: [ITEM.COPPER_NUGGET, 9] },
  { in: [[ITEM.COPPER_NUGGET, 9]],                                           out: [ITEM.COPPER_INGOT, 1] },
  /* Cloth is spun from fiber, so anything soft or lashed together now costs bush harvest. */
  { in: [[ITEM.FIBER, 10]],                                                  out: [ITEM.CLOTH, 1] },
  { in: [[V_PLANKS, 10], [ITEM.IRON_INGOT, 1], [ITEM.FIBER, 10]],            out: [B.CHEST, 1] },
  { in: [[B.WOOL, 4], [V_PLANKS, 4], [ITEM.CLOTH, 5], [ITEM.FIBER, 10]],     out: [B.BED, 1] },
  { in: [[V_PLANKS, 8], [ITEM.IRON_INGOT, 1], [ITEM.FIBER, 4]],              out: [B.DOOR, 1] },
  { in: [[V_PLANKS, 3]],                                                     out: [B.STAIRS, 2] },   // disabled (0.7295)
  { in: [[ITEM.DIAMOND, 3], [ITEM.STICK, 2], [ITEM.FIBER, 5]],               out: [ITEM.DIAMOND_SWORD, 1] },
  { in: [[ITEM.DIAMOND, 1], [ITEM.STICK, 3], [ITEM.FIBER, 5]],               out: [ITEM.DIAMOND_SHOVEL, 1] },
  { in: [[ITEM.DIAMOND, 5], [ITEM.STICK, 3], [ITEM.FIBER, 5]],               out: [ITEM.DIAMOND_PICKAXE, 1] },
  { in: [[ITEM.DIAMOND, 4], [ITEM.STICK, 3], [ITEM.FIBER, 5]],               out: [ITEM.DIAMOND_HATCHET, 1] },
  { in: [[ITEM.DIAMOND, 2], [ITEM.STICK, 3], [ITEM.FIBER, 5]],               out: [ITEM.DIAMOND_HOE, 1] },
  { in: [[ITEM.GOLD_INGOT, 3], [ITEM.STICK, 2], [ITEM.FIBER, 5]],            out: [ITEM.GOLDEN_SWORD, 1] },
  { in: [[ITEM.GOLD_INGOT, 1], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.GOLDEN_SHOVEL, 1] },
  { in: [[ITEM.GOLD_INGOT, 5], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.GOLDEN_PICKAXE, 1] },
  { in: [[ITEM.GOLD_INGOT, 4], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.GOLDEN_HATCHET, 1] },
  { in: [[ITEM.GOLD_INGOT, 2], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.GOLDEN_HOE, 1] },
  { in: [[ITEM.IRON_INGOT, 3], [ITEM.STICK, 2], [ITEM.FIBER, 5]],            out: [ITEM.IRON_SWORD, 1] },
  { in: [[ITEM.IRON_INGOT, 1], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.IRON_SHOVEL, 1] },
  { in: [[ITEM.IRON_INGOT, 5], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.IRON_PICKAXE, 1] },
  { in: [[ITEM.IRON_INGOT, 4], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.IRON_HATCHET, 1] },
  { in: [[ITEM.IRON_INGOT, 2], [ITEM.STICK, 3], [ITEM.FIBER, 5]],            out: [ITEM.IRON_HOE, 1] },
  { in: [[ITEM.IRON_INGOT, 2], [ITEM.FIBER, 5]],                             out: [ITEM.IRON_SHEARS, 1] },
  { in: [[V_STONE, 3], [ITEM.STICK, 2], [ITEM.FIBER, 5]],                    out: [ITEM.STONE_SWORD, 1] },
  { in: [[V_STONE, 1], [ITEM.STICK, 3], [ITEM.FIBER, 5]],                    out: [ITEM.STONE_SHOVEL, 1] },
  { in: [[V_STONE, 5], [ITEM.STICK, 3], [ITEM.FIBER, 5]],                    out: [ITEM.STONE_PICKAXE, 1] },
  { in: [[V_STONE, 4], [ITEM.STICK, 3], [ITEM.FIBER, 5]],                    out: [ITEM.STONE_HATCHET, 1] },
  { in: [[V_STONE, 2], [ITEM.STICK, 3], [ITEM.FIBER, 5]],                    out: [ITEM.STONE_HOE, 1] },
  { in: [[ITEM.IRON_INGOT, 3]],                                              out: [ITEM.BUCKET, 1] },
  { in: [[ITEM.WHEAT, 3]],                                                   out: [ITEM.FLOUR, 1] },
  { in: [[ITEM.FLOUR, 3], [B.PUMPKIN, 1]],                                   out: [ITEM.PUMPKIN_PIE, 1] },
  { in: [[ITEM.CHARCOAL, 1], [ITEM.SULFUR, 2], [ITEM.FLINT, 1]],             out: [ITEM.GUNPOWDER, 2] },
  { in: [[ITEM.GUNPOWDER, 7], [B.SAND, 10]],                                 out: [B.TNT, 1] },
  { in: [[ITEM.SUGAR_CANE, 3]],                                              out: [ITEM.PAPER, 1] },
  { in: [[ITEM.GOLD_INGOT, 10], [ITEM.APPLE, 1]],                            out: [ITEM.GOLDEN_APPLE, 1] },
  /* Leather set — the tier below iron, and the first armour a player can reach: it costs hide off
     cows and bush fiber rather than ore, with a nugget or two for the buckles. The five pieces
     form one rising ladder, cheapest (gloves) to dearest (chestplate), 2-7 leather / 8-18 fiber /
     1-2 nuggets end to end. */
  { in: [[ITEM.LEATHER, 2], [ITEM.FIBER, 8],  [V_NUGGET, 1]],                out: [ITEM.LEATHER_GLOVES, 1] },
  { in: [[ITEM.LEATHER, 3], [ITEM.FIBER, 10], [V_NUGGET, 1]],                out: [ITEM.LEATHER_BOOTS, 1] },
  { in: [[ITEM.LEATHER, 4], [ITEM.FIBER, 12], [V_NUGGET, 1]],                out: [ITEM.LEATHER_HELMET, 1] },
  { in: [[ITEM.LEATHER, 5], [ITEM.FIBER, 15], [V_NUGGET, 2]],                out: [ITEM.LEATHER_LEGGINGS, 1] },
  { in: [[ITEM.LEATHER, 7], [ITEM.FIBER, 18], [V_NUGGET, 2]],                out: [ITEM.LEATHER_CHESTPLATE, 1] },
  { in: [[ITEM.FIBER, 20], [ITEM.LEATHER, 5], [ITEM.IRON_INGOT, 2], [ITEM.IRON_NUGGET, 5]], out: [ITEM.SADDLE, 1] },
  { in: [[ITEM.IRON_INGOT, 6],  [ITEM.FIBER, 4], [ITEM.CLOTH, 1]],           out: [ITEM.IRON_GLOVES, 1] },
  { in: [[ITEM.IRON_INGOT, 8],  [ITEM.FIBER, 5], [ITEM.CLOTH, 1]],           out: [ITEM.IRON_BOOTS, 1] },
  { in: [[ITEM.IRON_INGOT, 10], [ITEM.FIBER, 6], [ITEM.CLOTH, 1]],           out: [ITEM.IRON_HELMET, 1] },
  { in: [[ITEM.IRON_INGOT, 14], [ITEM.FIBER, 7], [ITEM.CLOTH, 2]],           out: [ITEM.IRON_LEGGINGS, 1] },
  { in: [[ITEM.IRON_INGOT, 18], [ITEM.FIBER, 8], [ITEM.CLOTH, 3]],           out: [ITEM.IRON_CHESTPLATE, 1] },
];

// which list is shown: 'basic' (E / pocket) or 'advanced' (crafting bench = basic + advanced)
var craftMode = 'basic';
/* Recipes for a disabled block (slabs, stairs — see DISABLED_BLOCKS in 13-actions.js) stay in the
   lists above rather than being deleted, so re-enabling one is a single-line change. They are
   filtered out here, which is the only place the UI ever reads the recipes from, so a hidden
   recipe cannot be crafted by any path. */
const _recipeEnabled = (r) => isObtainable(r.out[0]);
const craftRecipes = () =>
  (craftMode === 'advanced' ? [...RECIPES_BASIC, ...RECIPES_ADVANCED] : RECIPES_BASIC).filter(_recipeEnabled);
const idName = (id) => id >= 256 ? ITEM_PROPS[id].name : PROPS[id].name;

// an ingredient entry is either a bare id or a variant group; normalise to a list
const ingIds = (id) => Array.isArray(id) ? id : [id];
// total count of an id across hotbar + inventory
function invCount(id) {
  let n = 0;
  const ids = ingIds(id);
  for (const s of HOTBAR)   if (s && ids.includes(s.id)) n += s.count;
  for (const s of invSlots) if (s && ids.includes(s.id)) n += s.count;
  return n;
}
const canCraft = (r) => r.in.every(([id, n]) => invCount(id) >= n);

// craft on a cloned inventory, commit only if the output fits (no item loss, no partial state)
function doCraft(r) {
  if (!canCraft(r)) return;
  const hot = HOTBAR.map(s => s && { ...s }), inv = invSlots.map(s => s && { ...s });
  for (const [id, need] of r.in) {                  // consume ingredients (inventory first)
    let n = need;
    const ids = ingIds(id);                         // a variant group drains from any member
    for (const arr of [inv, hot])
      for (let i = 0; i < arr.length && n > 0; i++) {
        const s = arr[i];
        if (s && ids.includes(s.id)) {
          const t = Math.min(s.count, n);
          s.count -= t; n -= t;
          if (s.count <= 0) arr[i] = null;
        }
      }
  }
  let [oid, on] = r.out;                            // give output: merge stacks, then empty slots
  const cap = stackSize(oid);
  for (const arr of [hot, inv])
    for (const s of arr)
      if (s && s.id === oid && s.count < cap && on > 0) {
        const t = Math.min(cap - s.count, on);
        s.count += t; on -= t;
      }
  for (const arr of [hot, inv])
    for (let i = 0; i < arr.length && on > 0; i++)
      if (arr[i] == null) { const t = Math.min(cap, on); arr[i] = mkSlot(oid, t); on -= t; }
  if (on > 0) { toast('inventory full'); return; }
  for (let i = 0; i < HOTBAR.length; i++)   HOTBAR[i]   = hot[i] || null;
  for (let i = 0; i < invSlots.length; i++) invSlots[i] = inv[i] || null;
  refreshSlotsUI(); updateHotbar();
  addXP(craftXP(r.out[0]));                         // paid by what you made, not by the click
}

// output-id -> category: blocks (id<256), tools (item with .tool), materials (other items)
function recipeCategory(r) {
  const oid = r.out[0];
  if (oid < 256) return 'blocks';
  const p = ITEM_PROPS[oid];
  if (p?.equip) return 'armor';               // anything worn in an equipment slot
  if (p?.food != null) return 'food';
  return p?.tool ? 'tools' : 'materials';
}
const CRAFT_CATS = ['all', 'blocks', 'materials', 'tools', 'armor', 'food'];
var craftCat = 'all';                      // active tab; kept across rebuilds
function cycleCraftCategory(dir) {         // dir = +1 (RB) / -1 (LB); wraps
  const i = CRAFT_CATS.indexOf(craftCat);
  craftCat = CRAFT_CATS[(i + dir + CRAFT_CATS.length) % CRAFT_CATS.length];
  _craftScroll = 0;
  buildCraftPanel();
}
var _craftScroll = 0;                       // saved scroll position preserved across doCraft rebuild

/* Variant cycling: rather than rebuilding the panel (which would fight the scroll position),
   a ticker rewrites the icon and tooltip of every ingredient that has a variant group. */
const CRAFT_VARIANT_MS = 2000;
let _variantPhase = 0;
setInterval(() => {
  _variantPhase++;
  const panel = invPanel('craftPanel');
  if (!panel || panel.style.display === 'none') return;
  for (const el of panel.querySelectorAll('.cing[data-ids]')) {
    const ids = el.dataset.ids.split(',').map(Number);
    const shown = ids[_variantPhase % ids.length];
    const img = el.querySelector('img');
    if (img) img.src = renderBlockIcon(shown);
    el.dataset.name = idName(shown);
  }
}, CRAFT_VARIANT_MS);

// populates the permanent #craftPanel div whenever the inventory rebuilds
function buildCraftPanel() {
  const panel = invPanel('craftPanel');
  if (!panel) return;
  panel.style.display = 'flex';
  // category tabs: All has no icon (label only), the rest use a themed icon from ITEM/BLOCK
  const CATS = [
    { key: 'all',       label: 'All',       icon: null },
    { key: 'blocks',    label: 'Blocks',    icon: B.CRAFTING_BENCH },
    { key: 'materials', label: 'Materials', icon: ITEM.IRON_INGOT },
    { key: 'tools',     label: 'Tools',     icon: ITEM.IRON_PICKAXE },
    { key: 'armor',     label: 'Armor',     icon: ITEM.IRON_CHESTPLATE },
    { key: 'food',      label: 'Food',      icon: ITEM.APPLE },
  ];
  let tabsHtml = '<div id="craftTabs">';
  for (const c of CATS) {
    const sel = c.key === craftCat ? ' sel' : '';
    const inner = c.icon != null ? `<img src="${renderBlockIcon(c.icon)}" alt="">` : `<span class="tlabel">All</span>`;
    tabsHtml += `<div class="ctab${sel}" data-cat="${c.key}" title="${c.label}">${inner}</div>`;
  }
  tabsHtml += '</div>';
  panel.innerHTML = `<div class="ctitle">${craftMode === 'advanced' ? 'Crafting Bench' : 'Crafting'}</div>` + tabsHtml;
  const list = document.createElement('div');
  list.id = 'craftList';
  // filter by category, then sort so craftable rows float to the top (stable within each group)
  const recs = craftRecipes().filter(r => craftCat === 'all' || recipeCategory(r) === craftCat);
  const idxOf = new Map(recs.map((r, i) => [r, i]));
  recs.sort((a, b) => {
    const ca = canCraft(a), cb = canCraft(b);
    if (ca !== cb) return ca ? -1 : 1;
    return idxOf.get(a) - idxOf.get(b);
  });
  for (const r of recs) {
    const ok = canCraft(r);
    const row = document.createElement('div');
    row.className = 'crow' + (ok ? '' : ' nocraft');
    let html = '';
    for (const [id, n] of r.in) {
      const have = invCount(id) >= n;
      const ids = ingIds(id);
      // variant groups carry their whole id list so the cycler can swap icon + tooltip in place
      const shown = ids[_variantPhase % ids.length];
      const attr = ids.length > 1 ? ` data-ids="${ids.join(',')}"` : '';
      html += `<span class="cing${have ? '' : ' miss'}" data-name="${idName(shown)}" data-id="${shown}"${attr}>` +
              `<img src="${renderBlockIcon(shown)}" alt="">${n > 1 ? `<b>${n}</b>` : ''}</span>`;
    }
    const [oid, on] = r.out;
    html += `<button class="cbtn" data-name="${idName(oid)}" data-id="${oid}">` +
            `<img src="${renderBlockIcon(oid)}" alt="">${on > 1 ? `<b>${on}</b>` : ''}</button>`;
    row.innerHTML = html;
    row.querySelector('.cbtn').addEventListener('click', () => doCraft(r));
    list.appendChild(row);
  }
  panel.appendChild(list);
  list.scrollTop = _craftScroll;             // restore scroll position after any rebuild
  list.addEventListener('scroll', () => { _craftScroll = list.scrollTop; });
  for (const tab of panel.querySelectorAll('.ctab'))
    tab.addEventListener('click', () => { craftCat = tab.dataset.cat; _craftScroll = 0; buildCraftPanel(); });
}
