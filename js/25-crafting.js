'use strict';
/* voxiCraft — list-based crafting system (survival only)

   Recipes are a flat list: ingredients on the left, one craft button with the output on
   the right. `E` opens the BASIC list (pocket crafting); right-clicking a crafting bench
   opens the ADVANCED list (basic + bench-only recipes). No grid patterns — having the
   ingredients anywhere in hotbar+inventory is enough. */

// recipe: { in: [[id, count], ...], out: [id, count] }
const RECIPES_BASIC = [
  { in: [[B.LOG, 1]],                                                        out: [B.PLANKS, 3] },
  { in: [[B.BIRCH_LOG, 1]],                                                  out: [B.BIRCH_PLANKS, 3] },
  { in: [[B.PLANKS, 2]],                                                     out: [ITEM.STICK, 6] },
  { in: [[B.BIRCH_PLANKS, 2]],                                               out: [ITEM.STICK, 6] },
  { in: [[B.PLANKS, 1]],                                                     out: [B.OAKSLAB, 2] },
  { in: [[ITEM.SNOWBALL, 4]],                                                out: [B.SNOW, 1] },
  { in: [[ITEM.WHEAT, 9]],                                                   out: [B.HAY, 1] },
  { in: [[ITEM.CLAY_BALL, 4]],                                               out: [B.CLAY, 1] },
  { in: [[ITEM.COAL, 1]],                                                    out: [ITEM.COAL_CHUNK, 8] },
  { in: [[B.PLANKS, 4]],                                                     out: [B.CRAFTING_BENCH, 1] },
  { in: [[B.BIRCH_PLANKS, 4]],                                               out: [B.CRAFTING_BENCH, 1] },
  { in: [[ITEM.BOWL, 1], [B.RED_MUSHROOM, 1], [B.BROWN_MUSHROOM, 1]],        out: [ITEM.MUSHROOM_STEW, 1] },
  { in: [[ITEM.COAL, 1], [ITEM.STICK, 1]],                                   out: [B.TORCH, 4] },
  { in: [[ITEM.GLASS_SHARD, 4]],                                             out: [B.GLASS, 1] },
  { in: [[ITEM.SUGAR_CANE, 1]],                                              out: [ITEM.SUGAR, 2] },
  { in: [[B.STONE, 1]],                                                      out: [B.STONE_BRICK, 1] },
  { in: [[ITEM.BRICK, 4]],                                                   out: [B.BRICKS, 1] },
];
const RECIPES_ADVANCED = [
  { in: [[ITEM.COAL_CHUNK, 8]],                                              out: [ITEM.COAL, 1] },
  { in: [[B.STONE, 1], [ITEM.FLINT, 1], [ITEM.COAL, 1]],                     out: [ITEM.GLOW_DUST, 1] },
  { in: [[B.PLANKS, 3]],                                                     out: [ITEM.BOWL, 4] },
  { in: [[B.BIRCH_PLANKS, 3]],                                               out: [ITEM.BOWL, 4] },
  { in: [[B.COBBLE, 8]],                                                     out: [B.FURNACE, 1] },
  { in: [[ITEM.IRON_INGOT, 1]],                                              out: [ITEM.IRON_NUGGET, 9] },
  { in: [[ITEM.IRON_NUGGET, 9]],                                             out: [ITEM.IRON_INGOT, 1] },
  { in: [[ITEM.GOLD_INGOT, 1]],                                              out: [ITEM.GOLD_NUGGET, 9] },
  { in: [[ITEM.GOLD_NUGGET, 9]],                                             out: [ITEM.GOLD_INGOT, 1] },
  { in: [[ITEM.TIN_INGOT, 1]],                                               out: [ITEM.TIN_NUGGET, 9] },
  { in: [[ITEM.TIN_NUGGET, 9]],                                              out: [ITEM.TIN_INGOT, 1] },
  { in: [[ITEM.COPPER_INGOT, 1]],                                            out: [ITEM.COPPER_NUGGET, 9] },
  { in: [[ITEM.COPPER_NUGGET, 9]],                                           out: [ITEM.COPPER_INGOT, 1] },
  { in: [[B.PLANKS, 6]],                                                     out: [B.DOOR, 1] },
  { in: [[B.PLANKS, 3]],                                                     out: [B.STAIRS, 2] },
  { in: [[ITEM.DIAMOND, 1], [ITEM.STICK, 3]],                                out: [ITEM.DIAMOND_SHOVEL, 1] },
  { in: [[ITEM.DIAMOND, 5], [ITEM.STICK, 3]],                                out: [ITEM.DIAMOND_PICKAXE, 1] },
  { in: [[ITEM.DIAMOND, 4], [ITEM.STICK, 3]],                                out: [ITEM.DIAMOND_HATCHET, 1] },
  { in: [[ITEM.DIAMOND, 3], [ITEM.STICK, 3]],                                out: [ITEM.DIAMOND_HOE, 1] },
  { in: [[ITEM.GOLD_INGOT, 1], [ITEM.STICK, 3]],                             out: [ITEM.GOLDEN_SHOVEL, 1] },
  { in: [[ITEM.GOLD_INGOT, 5], [ITEM.STICK, 3]],                             out: [ITEM.GOLDEN_PICKAXE, 1] },
  { in: [[ITEM.GOLD_INGOT, 4], [ITEM.STICK, 3]],                             out: [ITEM.GOLDEN_HATCHET, 1] },
  { in: [[ITEM.GOLD_INGOT, 3], [ITEM.STICK, 3]],                             out: [ITEM.GOLDEN_HOE, 1] },
  { in: [[ITEM.IRON_INGOT, 1], [ITEM.STICK, 3]],                             out: [ITEM.IRON_SHOVEL, 1] },
  { in: [[ITEM.IRON_INGOT, 5], [ITEM.STICK, 3]],                             out: [ITEM.IRON_PICKAXE, 1] },
  { in: [[ITEM.IRON_INGOT, 4], [ITEM.STICK, 3]],                             out: [ITEM.IRON_HATCHET, 1] },
  { in: [[ITEM.IRON_INGOT, 3], [ITEM.STICK, 3]],                             out: [ITEM.IRON_HOE, 1] },
  { in: [[B.COBBLE, 1], [ITEM.STICK, 3]],                                    out: [ITEM.STONE_SHOVEL, 1] },
  { in: [[B.COBBLE, 5], [ITEM.STICK, 3]],                                    out: [ITEM.STONE_PICKAXE, 1] },
  { in: [[B.COBBLE, 4], [ITEM.STICK, 3]],                                    out: [ITEM.STONE_HATCHET, 1] },
  { in: [[B.COBBLE, 3], [ITEM.STICK, 3]],                                    out: [ITEM.STONE_HOE, 1] },
  { in: [[B.PLANKS, 1], [ITEM.STICK, 3]],                                    out: [ITEM.WOODEN_SHOVEL, 1] },
  { in: [[B.PLANKS, 5], [ITEM.STICK, 3]],                                    out: [ITEM.WOODEN_PICKAXE, 1] },
  { in: [[B.PLANKS, 4], [ITEM.STICK, 3]],                                    out: [ITEM.WOODEN_HATCHET, 1] },
  { in: [[B.PLANKS, 3], [ITEM.STICK, 3]],                                    out: [ITEM.WOODEN_HOE, 1] },
  { in: [[ITEM.IRON_INGOT, 3]],                                              out: [ITEM.BUCKET, 1] },
  { in: [[ITEM.WHEAT, 3]],                                                   out: [ITEM.FLOUR, 1] },
  { in: [[ITEM.FLOUR, 3], [B.PUMPKIN, 1]],                                   out: [ITEM.PUMPKIN_PIE, 1] },
  { in: [[ITEM.CHARCOAL, 1], [ITEM.SULFUR, 2], [ITEM.FLINT, 1]],             out: [ITEM.GUNPOWDER, 2] },
  { in: [[ITEM.GUNPOWDER, 7], [B.SAND, 10]],                                 out: [B.TNT, 1] },
  { in: [[ITEM.SUGAR_CANE, 3]],                                              out: [ITEM.PAPER, 1] },
  { in: [[ITEM.GOLD_INGOT, 10], [ITEM.APPLE, 1]],                            out: [ITEM.GOLDEN_APPLE, 1] },
];

// which list is shown: 'basic' (E / pocket) or 'advanced' (crafting bench = basic + advanced)
let craftMode = 'basic';
const craftRecipes = () => craftMode === 'advanced' ? [...RECIPES_BASIC, ...RECIPES_ADVANCED] : RECIPES_BASIC;
const idName = (id) => id >= 256 ? ITEM_PROPS[id].name : PROPS[id].name;

// total count of an id across hotbar + inventory
function invCount(id) {
  let n = 0;
  for (const s of HOTBAR)   if (s && s.id === id) n += s.count;
  for (const s of invSlots) if (s && s.id === id) n += s.count;
  return n;
}
const canCraft = (r) => r.in.every(([id, n]) => invCount(id) >= n);

// craft on a cloned inventory, commit only if the output fits (no item loss, no partial state)
function doCraft(r) {
  if (!canCraft(r)) return;
  const hot = HOTBAR.map(s => s && { ...s }), inv = invSlots.map(s => s && { ...s });
  for (const [id, need] of r.in) {                  // consume ingredients (inventory first)
    let n = need;
    for (const arr of [inv, hot])
      for (let i = 0; i < arr.length && n > 0; i++) {
        const s = arr[i];
        if (s && s.id === id) {
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
}

// output-id -> category: blocks (id<256), tools (item with .tool), materials (other items)
function recipeCategory(r) {
  const oid = r.out[0];
  if (oid < 256) return 'blocks';
  return ITEM_PROPS[oid]?.tool ? 'tools' : 'materials';
}
const CRAFT_CATS = ['all', 'blocks', 'materials', 'tools'];
let craftCat = 'all';                      // active tab; kept across rebuilds
function cycleCraftCategory(dir) {         // dir = +1 (RB) / -1 (LB); wraps
  const i = CRAFT_CATS.indexOf(craftCat);
  craftCat = CRAFT_CATS[(i + dir + CRAFT_CATS.length) % CRAFT_CATS.length];
  _craftScroll = 0;
  buildCraftPanel();
}
let _craftScroll = 0;                       // saved scroll position preserved across doCraft rebuild

// populates the permanent #craftPanel div whenever the inventory rebuilds
function buildCraftPanel() {
  const panel = document.getElementById('craftPanel');
  if (!panel) return;
  panel.style.display = 'flex';
  // category tabs: All has no icon (label only), the rest use a themed icon from ITEM/BLOCK
  const CATS = [
    { key: 'all',       label: 'All',       icon: null },
    { key: 'blocks',    label: 'Blocks',    icon: B.CRAFTING_BENCH },
    { key: 'materials', label: 'Materials', icon: ITEM.IRON_INGOT },
    { key: 'tools',     label: 'Tools',     icon: ITEM.IRON_PICKAXE },
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
      html += `<span class="cing${have ? '' : ' miss'}" data-name="${idName(id)}">` +
              `<img src="${renderBlockIcon(id)}" alt="">${n > 1 ? `<b>${n}</b>` : ''}</span>`;
    }
    const [oid, on] = r.out;
    html += `<button class="cbtn" data-name="${idName(oid)}">` +
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
