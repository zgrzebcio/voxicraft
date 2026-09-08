'use strict';
/* voxiCraft — equipment: armor slots, the equipment panel, and the live player preview.

   Layout follows the design sketch: two columns of five slots flanking a player preview, with a
   stats readout underneath.
     left  column: helmet, necklace, chestplate, leggings, boots
     right column: back, belt, gloves, accessories, offhand
   Only the four armor slots accept items today — the other six are placeholders, reserved so the
   layout and save format do not have to change when their items exist.

   Armor uses Minecraft-style points: 20 points = the full 10-icon bar above the hearts, and
   incoming damage is reduced proportionally (see armorDamageMultiplier). */

const EQUIP_SLOTS = [
  { key: 'helmet',      label: 'Helmet',      col: 'l', accepts: 'helmet'     },
  { key: 'necklace',    label: 'Necklace',    col: 'l', accepts: null         },
  { key: 'chestplate',  label: 'Chestplate',  col: 'l', accepts: 'chestplate' },
  { key: 'leggings',    label: 'Leggings',    col: 'l', accepts: 'leggings'   },
  { key: 'boots',       label: 'Boots',       col: 'l', accepts: 'boots'      },
  { key: 'back',        label: 'Back',        col: 'r', accepts: null         },
  { key: 'belt',        label: 'Belt',        col: 'r', accepts: 'belt'       },
  { key: 'gloves',      label: 'Gloves',      col: 'r', accepts: 'gloves'     },
  { key: 'accessories', label: 'Accessories', col: 'r', accepts: null         },
  { key: 'offhand',     label: 'Offhand',     col: 'r', accepts: null         },
];
const EQUIP_INDEX = {};
EQUIP_SLOTS.forEach((s, i) => { EQUIP_INDEX[s.key] = i; });

// live array, indexed to match EQUIP_SLOTS. Swapped out with the inventory on mode change.
var equipSlots = new Array(EQUIP_SLOTS.length).fill(null);

/* Belt: wearing one opens a row of quick-access slots above the equipment panel, sized by the
   belt's own `beltSlots`. They are reserved for utility gear (lantern, spyglass, map, compass,
   clock) — items tagged `beltItem: true`. None exist yet, so the row renders as placeholders. */
const BELT_MAX = 5;
var beltSlots = new Array(BELT_MAX).fill(null);
// how many belt slots are currently usable (0 = no belt worn)
function beltCapacity() {
  const s = equipSlots[EQUIP_INDEX.belt];
  const n = s && ITEM_PROPS[s.id]?.beltSlots;
  return Math.min(BELT_MAX, n || 0);
}
const beltAccepts = (i, id) =>
  i < beltCapacity() && id != null && id >= 256 && !!ITEM_PROPS[id]?.beltItem;

/* Called after any equipment change. Slots beyond the current capacity (belt removed, or
   swapped for a smaller one) spill back into the player's grids, dropping on the floor rather
   than vanishing if there is no room. */
function syncBeltCapacity() {
  const cap = beltCapacity();
  for (let i = cap; i < beltSlots.length; i++) {
    const s = beltSlots[i];
    if (!s) continue;
    beltSlots[i] = null;
    for (let n = 0; n < s.count; n++)
      if (!tryPickup(s.id, s.dur ?? null))
        spawnDrop(s.id, Math.floor(player.pos.x), Math.floor(player.pos.y + 0.5), Math.floor(player.pos.z));
  }
}

// does this item belong in that slot? placeholders accept nothing
function equipAccepts(slotIdx, id) {
  const want = EQUIP_SLOTS[slotIdx] && EQUIP_SLOTS[slotIdx].accepts;
  if (!want || id == null || id < 256) return false;
  return ITEM_PROPS[id]?.equip === want;
}

/* ---------------------------------- stats ---------------------------------- */
function playerArmorPoints() {
  let n = 0;
  for (const s of equipSlots) if (s && ITEM_PROPS[s.id]?.armor) n += ITEM_PROPS[s.id].armor;
  return Math.min(20, n);
}
/* The armor bar is MIXED (0.731). It used to pick ONE sprite set for the whole row — the
   highest-value piece won — so an iron chestplate over leather trousers drew a row of solid iron.
   One icon is worth two points, and the two points inside it can come from DIFFERENT materials:
   that is exactly the case the left-half / right-half sprites exist for. So the bar is driven by
   a flat list of one entry PER POINT, in a fixed equipment order, rather than by a single
   "which material wins" answer.
   Capped at 20 to match playerArmorPoints, so the list and the total can never disagree. */
const ARMOR_BAR_ORDER = ['helmet', 'chestplate', 'leggings', 'boots', 'gloves'];
const _matName = (m) => m ? m.charAt(0).toUpperCase() + m.slice(1) : 'Iron';
function playerArmorPointMats() {
  const out = [];
  for (const key of ARMOR_BAR_ORDER) {
    const s = equipSlots[EQUIP_INDEX[key]];
    const p = s && ITEM_PROPS[s.id];
    if (!p || !p.armor) continue;
    const mat = _matName(p.armorMat);
    for (let i = 0; i < p.armor && out.length < 20; i++) out.push(mat);
  }
  return out;
}
// cheap change-detector for the HUD: repaint the bar when the MIX changes, not just the total
const armorBarSignature = () => playerArmorPointMats().join(',');
// Minecraft's rule: each point cuts 4% of incoming damage, capped at 80%.
function armorDamageMultiplier() {
  return 1 - Math.min(0.8, playerArmorPoints() * 0.04);
}
// one durability point per damaging hit, spread over the worn pieces
function damageArmorDurability() {
  let changed = false;
  for (let i = 0; i < equipSlots.length; i++) {
    const s = equipSlots[i];
    if (!s || s.dur == null) continue;
    s.dur--;
    if (s.dur <= 0) { equipSlots[i] = null; toast(`${ITEM_PROPS[s.id].name} broke`); }
    changed = true;
  }
  if (changed) { saveEquip(); if (invOpen) buildEquipPanel(); }
}
/* Worn-gear stat totals. Every modifier is additive across pieces, so a full iron set (helmet,
   chest, legs, boots, gloves) stacks five -2.5% penalties into -12.5% move speed. */
function _equipSum(field) {
  let n = 0;
  for (const s of equipSlots) {
    const v = s && ITEM_PROPS[s.id]?.[field];
    if (typeof v === 'number') n += v;
  }
  return n;
}
// flat bonus damage added on top of the held weapon (iron gloves = +0.75)
function playerStrength() { return _equipSum('strength'); }

/* ---------------------------------- set bonuses (0.731) ----------------------------------
   Wear all FOUR body pieces of one material and the set does something the pieces alone do not.
   Gloves are deliberately excluded from the test: they are the cheap fifth piece, and letting
   them gate the bonus would mean the bonus vanished the moment a pair broke.

   A bonus is permanent while the set is on — it is not a timer — so it reports `time: Infinity`
   and the panel prints an infinity sign instead of a countdown. Taking a piece off, or wearing
   one out, drops the set and the effect with it, because nothing is stored: it is recomputed from
   what is equipped every time it is asked for. */
const ARMOR_SET_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];
const ARMOR_SET_BONUS = {
  iron:    { name: 'Knockback resistance', knockback: 0.20, good: true,
             desc: 'Full set: +20% knockback resistance' },
  /* Leather does NOT slow you down — it blunts the slowdown the GROUND inflicts. Wading through
     leaf litter and deep snow costs 30% less than it does barefoot, which is what soft boots are
     actually for. It is a multiplier on the penalty, not on your speed. */
  leather: { name: 'Slowness resistance',  terrainDrag: 0.30, good: true,
             desc: 'Full set: leaf and snow slowdown 30% weaker' },
};
// the material every body piece shares, or null if the set is incomplete or mismatched
function playerArmorSet() {
  let mat = null;
  for (const key of ARMOR_SET_SLOTS) {
    const s = equipSlots[EQUIP_INDEX[key]];
    const m = s && ITEM_PROPS[s.id]?.armorMat;
    if (!m) return null;
    if (mat === null) mat = m;
    else if (m !== mat) return null;
  }
  return mat;
}
const armorSetBonus = () => ARMOR_SET_BONUS[playerArmorSet()] || null;
// 0..1 fraction of incoming knockback cancelled (iron set = 0.20)
function playerKnockbackResist() {
  const b = armorSetBonus();
  return b && b.knockback ? Math.min(1, b.knockback) : 0;
}
// 0..1 fraction of the terrain slowdown cancelled (leather set = 0.30)
function playerTerrainDragResist() {
  const b = armorSetBonus();
  return b && b.terrainDrag ? Math.min(1, b.terrainDrag) : 0;
}
/* Everything currently affecting the player, permanent set bonuses first. PLAYER_EFFECTS is still
   the home for genuine TIMED effects; nothing produces one yet. */
function activeEffects() {
  const out = [];
  const b = armorSetBonus();
  if (b) out.push({ name: b.name, time: Infinity, good: b.good });
  for (const e of PLAYER_EFFECTS) out.push(e);
  return out;
}

// multiplier on walking speed; floored so gear can never freeze the player
const playerMoveSpeedMul = () => {
  const b = armorSetBonus();
  return Math.max(0.25, 1 + _equipSum('moveSpeed') + (b && b.moveSpeed ? b.moveSpeed : 0));
};
function playerMoveSpeedPct() { return Math.round(playerMoveSpeedMul() * 100); }
// multiplier on swing rate — >1 swings faster, so it DIVIDES the cooldown
const playerAtkSpeedMul = () => Math.max(0.25, 1 + _equipSum('atkSpeed'));
/* Environmental resistances (0.7295). No item grants either yet and nothing reads them for damage
   — they are stat lines the panel reserves, so the gear that will carry them has somewhere to
   show up. Summed as a fraction (0.15 = 15% resisted) and clamped to 100%. */
const _resPct = (field) => Math.round(Math.min(1, Math.max(-1, _equipSum(field))) * 100);
function playerColdResist() { return _resPct('coldResist'); }
function playerHeatResist() { return _resPct('heatResist'); }
// active timed effects — nothing produces them yet, but the panel already lists them
const PLAYER_EFFECTS = [];

/* ---------------------------------- persistence ---------------------------------- */
// creative gets its own throwaway set so survival gear is never touched
var survEquip = new Array(EQUIP_SLOTS.length).fill(null);
var survBelt  = new Array(BELT_MAX).fill(null);
function saveEquip() {
  if (currentInvMode === 'survival') { survEquip = equipSlots; survBelt = beltSlots; }
}
function loadEquipForMode(mode) {
  equipSlots = mode === 'survival' ? survEquip : new Array(EQUIP_SLOTS.length).fill(null);
  beltSlots  = mode === 'survival' ? survBelt  : new Array(BELT_MAX).fill(null);
}
const _packSlots = (arr) => arr.map(s => s ? [s.id, s.count, s.dur ?? null] : null);
function _unpackSlots(list, len) {
  const out = new Array(len).fill(null);
  if (Array.isArray(list))
    for (let i = 0; i < len && i < list.length; i++) {
      const s = list[i];
      if (!Array.isArray(s) || !ITEM_PROPS[s[0]]) continue;
      const slot = mkSlot(s[0], Math.max(1, s[1] | 0));
      if (s[2] != null) slot.dur = s[2];
      out[i] = slot;
    }
  return out;
}
function serializeEquip() { return _packSlots(equipSlots); }
function serializeBelt()  { return _packSlots(beltSlots); }
function restoreEquip(list, beltList) {
  survEquip = _unpackSlots(list, EQUIP_SLOTS.length);
  survBelt  = _unpackSlots(beltList, BELT_MAX);
  if (currentInvMode === 'survival') { equipSlots = survEquip; beltSlots = survBelt; }
}

/* ---------------------------------- preview ---------------------------------- */
/* A small offscreen three.js render of the player wearing whatever is equipped. Armor is drawn
   as slightly-inflated copies of the body parts, textured from the 64x32 armor-layer sheets in
   textures/Entity/equipment (<mat>_tophalf = helmet + chestplate, <mat>_downhalf = leggings +
   boots). Materials without a sheet simply show no overlay. */
const PREVIEW_W = 132, PREVIEW_H = 200;
let _pvRenderer = null, _pvScene = null, _pvCam = null, _pvModel = null, _pvArmor = null;
const _pvTexCache = {};

// the armor sheets are a 64x32 layout, so V divides by 32 rather than the 64 a skin uses
function _armorUV(geo, w, h, d, u, v) {
  const uv = geo.attributes.uv;
  const put = (face, px, py, pw, ph) => {
    const u0 = px / 64, u1 = (px + pw) / 64;
    const v0 = 1 - (py + ph) / 32, v1 = 1 - py / 32;
    const o = face * 4;
    uv.setXY(o + 0, u0, v1); uv.setXY(o + 1, u1, v1);
    uv.setXY(o + 2, u0, v0); uv.setXY(o + 3, u1, v0);
  };
  put(0, u + d + w, v + d, d, h);
  put(1, u,         v + d, d, h);
  put(2, u + d,     v,     w, d);
  put(3, u + d + w, v,     w, d);
  put(4, u + d,     v + d, w, h);
  put(5, u + 2 * d + w, v + d, w, h);
  uv.needsUpdate = true;
}
function _armorTex(name) {
  if (_pvTexCache[name] !== undefined) return _pvTexCache[name];
  const img = IMAGES[name];
  if (!img) { _pvTexCache[name] = null; return null; }
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  _pvTexCache[name] = t;
  return t;
}
// one inflated overlay piece; `grow` pushes it just outside the skin so it never z-fights
function _armorPiece(tex, w, h, d, u, v, grow) {
  const geo = new THREE.BoxGeometry(w * PX + grow, h * PX + grow, d * PX + grow);
  _armorUV(geo, w, h, d, u, v);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: tex, transparent: true, alphaTest: 0.35,
  }));
}

function _pvInit() {
  if (_pvRenderer) return true;
  const host = invPanel('equipPreview');
  if (!host) return false;
  _pvRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  _pvRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  _pvRenderer.setSize(PREVIEW_W, PREVIEW_H);
  host.appendChild(_pvRenderer.domElement);
  _pvScene = new THREE.Scene();
  _pvCam = new THREE.PerspectiveCamera(30, PREVIEW_W / PREVIEW_H, 0.1, 20);
  _pvCam.position.set(0, 1.0, 4.2);
  _pvCam.lookAt(0, 0.95, 0);
  _pvModel = buildHumanoid();                       // same builder the world entities use
  // model's front is +Z and the camera sits at +Z looking back, so yaw 0 already faces us —
  // the extra PI turned its back to the camera
  _pvModel.root.rotation.y = 0;
  for (const m of _pvModel.mats) m.color.setScalar(1);
  _pvScene.add(_pvModel.root);
  _pvArmor = new THREE.Group();
  _pvModel.root.add(_pvArmor);
  return true;
}

// rebuild the overlay meshes from what is currently equipped
let _pvArmorKey = '';
function _pvSyncArmor() {
  const key = equipSlots.map(s => s ? s.id : 0).join(',');
  if (key === _pvArmorKey) return;
  _pvArmorKey = key;
  // detach old pieces (limb-parented ones live on the limb groups, not _pvArmor)
  for (const g of [_pvArmor, _pvModel.armR, _pvModel.armL, _pvModel.legR, _pvModel.legL])
    for (let i = g.children.length - 1; i >= 0; i--)
      if (g.children[i].userData.armor) { g.children[i].geometry.dispose(); g.remove(g.children[i]); }

  const matOf = (slot) => {
    const s = equipSlots[EQUIP_INDEX[slot]];
    return s ? ITEM_PROPS[s.id]?.armorMat : null;
  };
  const add = (parent, mesh, pos) => {
    mesh.userData.armor = true;
    mesh.position.set(pos[0], pos[1], pos[2]);
    parent.add(mesh);
  };
  const G1 = 0.030, G2 = 0.055;                     // helmet/legs sit closer than the torso layer

  // helmet — head box from the TOP sheet, head region (0,0)
  const helm = matOf('helmet');
  const helmTex = helm && _armorTex(helm + '_tophalf');
  if (helmTex) add(_pvArmor, _armorPiece(helmTex, 8, 8, 8, 0, 0, G2), [0, 28 * PX, 0]);

  // chestplate — torso (16,16) plus both arms (40,16), from the TOP sheet
  const chest = matOf('chestplate');
  const chestTex = chest && _armorTex(chest + '_tophalf');
  if (chestTex) {
    add(_pvArmor, _armorPiece(chestTex, 8, 12, 4, 16, 16, G1), [0, 18 * PX, 0]);
    add(_pvModel.armR, _armorPiece(chestTex, 4, 12, 4, 40, 16, G1), [0, -6 * PX, 0]);
    add(_pvModel.armL, _armorPiece(chestTex, 4, 12, 4, 40, 16, G1), [0, -6 * PX, 0]);
  }
  // leggings — torso + legs from the DOWN sheet, hugged tight to the body
  const legs = matOf('leggings');
  const legsTex = legs && _armorTex(legs + '_downhalf');
  if (legsTex) {
    add(_pvArmor, _armorPiece(legsTex, 8, 12, 4, 16, 16, 0.012), [0, 18 * PX, 0]);
    add(_pvModel.legR, _armorPiece(legsTex, 4, 12, 4, 0, 16, 0.012), [0, -6 * PX, 0]);
    add(_pvModel.legL, _armorPiece(legsTex, 4, 12, 4, 0, 16, 0.012), [0, -6 * PX, 0]);
  }
  // boots — lower legs from the DOWN sheet
  const boots = matOf('boots');
  const bootsTex = boots && _armorTex(boots + '_downhalf');
  if (bootsTex) {
    add(_pvModel.legR, _armorPiece(bootsTex, 4, 12, 4, 0, 16, G2), [0, -6 * PX, 0]);
    add(_pvModel.legL, _armorPiece(bootsTex, 4, 12, 4, 0, 16, G2), [0, -6 * PX, 0]);
  }
  /* Gloves (0.731) — the pair had stats and a recipe but nothing to look at. There is no glove
     region on either sheet, so they borrow the BOTTOM five pixels of the chestplate's arm
     (40,16): on the armour layer that is the cuff, which is exactly what a gauntlet looks like.
     v is 16 + (12 - 5) so the sub-box samples the wrist end, and 4 + 5 = 9 keeps it inside the
     sheet's 32-pixel height. Grown to G2 so it sits outside a chestplate sleeve rather than
     fighting it for depth. */
  const gloves = matOf('gloves');
  const glovesTex = gloves && _armorTex(gloves + '_tophalf');
  if (glovesTex) {
    const cuffY = -(12 - 5 / 2) * PX;               // bottom of a 12-long arm that pivots at the top
    add(_pvModel.armR, _armorPiece(glovesTex, 4, 5, 4, 40, 23, G2), [0, cuffY, 0]);
    add(_pvModel.armL, _armorPiece(glovesTex, 4, 5, 4, 40, 23, G2), [0, cuffY, 0]);
  }
}

let _pvSpin = 0;
function updateEquipPreview(dt) {
  if (!invOpen || !_pvRenderer) return;
  /* One WebGL renderer, one canvas, and up to four inventories open at once (0.728) — so make
     sure the canvas is actually parented into THIS seat's preview box before drawing this seat's
     armour into it. The caller picks a single owner per frame, so this settles immediately rather
     than tugging the canvas back and forth. */
  const host = invPanel('equipPreview');
  if (!host) return;
  if (_pvRenderer.domElement.parentNode !== host) {
    host.appendChild(_pvRenderer.domElement);
    _pvArmorKey = '';                                // different player: force an overlay refresh
  }
  _pvSyncArmor();
  _pvSpin += dt * 0.5;
  _pvModel.root.rotation.y = Math.sin(_pvSpin) * 0.45;   // gentle turntable around front-on
  _pvRenderer.render(_pvScene, _pvCam);
}

/* ---------------------------------- panel ---------------------------------- */
function buildEquipPanel() {
  const panel = invPanel('equipPanel');
  if (!panel) return;
  // Creative has no gear: loadEquipForMode already hands it an empty throwaway array, so leaving
  // the panel hidden is enough to disable armor entirely — slotDescriptors only registers equip
  // and belt slots while the panel is visible, so there is nothing to drag into.
  if (player.canFly) { panel.style.display = 'none'; return; }
  panel.style.display = 'flex';
  const cell = (s, i) => {
    const item = equipSlots[i];
    const ph = s.accepts ? '' : ' ph';
    return `<div class="slot eq${ph}" data-eq="${i}" data-name="${s.label}">${slotInner(item)}` +
           (item ? '' : `<span class="eqTag">${s.label.slice(0, 4)}</span>`) + '</div>';
  };
  let left = '', right = '';
  EQUIP_SLOTS.forEach((s, i) => { (s.col === 'l' ? (left += cell(s, i)) : (right += cell(s, i))); });
  const pts = playerArmorPoints();
  const red = Math.round((1 - armorDamageMultiplier()) * 100);
  const spd = playerMoveSpeedPct();
  const str = playerStrength();
  const atk = playerAtkSpeedMul();
  const sign = (n, unit = '') => (n > 0 ? '+' : '') + (+n.toFixed(2)) + unit;
  const cold = playerColdResist(), heat = playerHeatResist();
  let stats = `<div class="stRow"><span>armor</span><b>${pts}</b></div>` +
              `<div class="stRow"><span>damage reduced</span><b>${red}%</b></div>` +
              `<div class="stRow${spd === 100 ? '' : ' bad'}"><span>move speed</span><b>${spd}%</b></div>` +
              `<div class="stRow${str ? ' good' : ''}"><span>strength</span><b>${sign(str)}</b></div>` +
              `<div class="stRow${atk === 1 ? '' : (atk > 1 ? ' good' : ' bad')}"><span>attack speed</span>` +
              `<b>${Math.round(atk * 100)}%</b></div>` +
              // reserved lines: nothing grants them yet, so they read 0% until gear does
              `<div class="stRow${cold ? ' good' : ''}"><span>cold resistance</span><b>${cold}%</b></div>` +
              `<div class="stRow${heat ? ' good' : ''}"><span>heat resistance</span><b>${heat}%</b></div>` +
              '<div class="stRow slotFree"><span>&mdash;</span><b>&mdash;</b></div>';
  stats += '<div class="ctitle stTitle">Effects</div>';
  const eff = activeEffects();
  stats += eff.length
    ? eff.map(e => {
        // a set bonus lasts as long as the set is worn, so it shows an infinity sign, not a clock
        const t = (e.time === Infinity) ? '&infin;' : e.time + 's';
        return `<div class="stRow eff${e.good === false ? ' bad' : ''}"><span>${e.name}</span><b>${t}</b></div>`;
      }).join('')
    : '<div class="stRow none"><span>no active effects</span></div>';
  // belt row: only present while a belt is worn, sized by that belt's slot count
  const cap = beltCapacity();
  let beltRow = '';
  if (cap > 0) {
    let cells = '';
    for (let i = 0; i < cap; i++)
      cells += `<div class="slot belt" data-belt="${i}" data-name="Belt slot">${slotInner(beltSlots[i])}</div>`;
    beltRow = `<div id="beltRow">${cells}</div>`;
  }
  panel.innerHTML =
    '<div class="ctitle">Equipment</div>' +
    beltRow +
    '<div id="equipBody">' +
      `<div class="eqCol">${left}</div>` +
      '<div id="equipPreview"></div>' +
      `<div class="eqCol">${right}</div>` +
    '</div>' +
    '<div class="ctitle stTitle">Stats</div>' +
    `<div id="equipStats">${stats}</div>`;
  if (_pvRenderer) {                                 // re-attach the existing canvas after rebuild
    invPanel('equipPreview').appendChild(_pvRenderer.domElement);
    _pvArmorKey = '';                                // force an overlay refresh
  } else _pvInit();
}
