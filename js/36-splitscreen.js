'use strict';
/* voxiCraft — split screen: up to four players sharing one world, one canvas and one renderer

   ================================================================================================
   HOW IT WORKS

   The game was written against a single `player`, a single `camera`, a single hotbar and a single
   HUD, and about five hundred places read those directly. Rewriting all of them to take an owner
   argument would have been a rewrite of the whole game, so instead the globals STAY — and this
   file swaps which player they point at.

   Each player owns a "slot": a snapshot of every global that is genuinely per-player (listed in
   SWAP_KEYS). `useSlot(i)` copies the live globals back into the outgoing slot and installs the
   incoming one. The frame loop then ticks and renders each player in turn inside their own slot,
   and everything downstream — movement, mining, the hand, vitals, the HUD — carries on believing
   it is the only player in the world.

   That is why those globals are declared with `var` rather than `let`/`const`: only `var` and
   function declarations become properties of globalThis, which is what lets the swapper address
   them by name instead of needing a hand-written assignment per field.

   What is NOT per player, deliberately: the world itself (blocks, entities, drops, weather, the
   clock), the renderer and scene, and the PAUSE MENU — that one really is for everybody, so it
   stays a single overlay centred on the whole screen. The inventory is not: since 0.728 each seat
   has its own panel inside its own viewport, so several people can rummage at once.
   ================================================================================================ */

const MAX_PLAYERS = 4;

/* Every global that is part of "being a player". Anything not on this list is world state and is
   shared. Order does not matter; each key is read and written through globalThis. */
const SWAP_KEYS = [
  // identity + view
  'player', 'camera',
  // carried items
  'HOTBAR', 'invSlots', 'invSlots2', 'hotbarSel', 'survStash',
  'equipSlots', 'beltSlots', 'survEquip', 'survBelt',
  // what this player is doing right now
  'mining', 'act', 'mouseBreak', 'mousePlace', 'pad', 'crackMat',
  '_bushCd', 'handPlaceSwing', 'handPickSwing', '_eatTimer',
  // this seat's own inventory: its panel, its cursor, what it is dragging and what it has open
  'invOpen', 'invWrapEl', 'invEl', 'vcurEl', 'vdragEl', 'ctipEl',
  'invCursor', 'dragFrom', 'dragHeld', 'lastHoverEl', '_invSeq',
  'craftMode', 'craftCat', '_craftScroll',
  'activeFurnace', 'activeChest', 'activeChest2', 'activeStructBlock',
  // third-person body + melee pacing
  'camView', '_selfModel', '_selfPhase', '_selfPrevX', '_selfPrevZ', '_selfCrouch', '_selfLie',
  '_selfHeld', '_selfHeldId',
  '_atkCooldown', '_lastHeldForAtk', '_plyKick',
  // first-person arm rig
  'handRoot', 'armPivot', 'heldGroup', '_matSkin',
  '_armGlow', '_bobT', '_swimT', '_eatBobT', '_inactive', '_swingT',
  '_prevMining', '_prevBreak', '_prevPlace', '_prevYaw', '_prevPitch', '_heldId',
  // vitals + experience
  'camShake', '_hurtA', 'vitalsDirty', 'vitalsShown',
  'playerXP', 'playerLevel', 'playerXPInLevel', 'playerXPNeeded', 'xpBarDirty', '_xpFlash', '_popSlot',
  // movement bookkeeping + held light
  'wasMoving', 'lastFlying', '_hlId', '_hlLevel', '_hlX', '_hlY', '_hlZ', '_hlRaw',
  // this player's slice of the HUD
  'hudEl', 'blocknameEl', 'hotbarEl', 'interactEl', 'vitalsEl', 'vctx',
  'xpBarEl', 'xpFillEl', 'xpLevelEl', 'xpPopsEl', 'hurtEl',
  'deathEl', 'deathCauseEl', 'deathStatsEl', '_interactShown', 'blocknameTimer',
];

const PSTATE = [];          // one entry per joined player; PSTATE[0] is player one
let activeSlot = 0;

function _captureSlot(i) {
  const g = PSTATE[i].g;
  for (const k of SWAP_KEYS) g[k] = globalThis[k];
}
function _installSlot(i) {
  const g = PSTATE[i].g;
  for (const k of SWAP_KEYS) globalThis[k] = g[k];
}
/* Make slot `i` the one every global refers to. Cheap (a few dozen property copies) and called at
   most a handful of times a frame, so it never shows up in a profile next to chunk meshing. */
function useSlot(i) {
  if (i === activeSlot || !PSTATE[i]) return;
  _captureSlot(activeSlot);
  activeSlot = i;
  _installSlot(i);
}
function withSlot(i, fn) {
  const prev = activeSlot;
  useSlot(i);
  try { return fn(); } finally { useSlot(prev); }
}
// run `fn` as a specific player — used by anything that acts ON a player from outside their tick
// (item pickup, a mob's target, a pane's own respawn button)
function withPlayer(p, fn) {
  const i = PLAYERS.indexOf(p);
  return i < 0 ? fn() : withSlot(i, fn);
}
// run `fn` once in every player's context, restoring the caller's when done
function forEachPlayerSlot(fn) {
  const prev = activeSlot;
  for (let i = 0; i < PSTATE.length; i++) { useSlot(i); fn(i); }
  useSlot(prev);
}
/* Index of the first seat whose stored globals satisfy `pred`, or -1. The live slot's snapshot is
   refreshed first, so the test sees current values for whichever player happens to be installed
   rather than whatever they looked like at the last swap. */
function firstSlotWhere(pred) {
  _captureSlot(activeSlot);
  for (let i = 0; i < PSTATE.length; i++) if (pred(PSTATE[i].g, i)) return i;
  return -1;
}
// read/modify each player's stored globals WITHOUT swapping (for bookkeeping like cache flags)
function forEachPlayerState(fn) {
  _captureSlot(activeSlot);                        // the live slot's copy must be current first
  for (let i = 0; i < PSTATE.length; i++) fn(PSTATE[i].g, i);
  _installSlot(activeSlot);                        // ...and any change to it written back
}
const activePlayerSlot = () => activeSlot;
const hudPanes = () => PSTATE.map(s => s.pane);
/* Players are named (0.721). The name is what the pane tag shows, what a "someone else has the
   inventory open" message uses, and what the world save keys the roster on — so the same people
   come back with the same pockets next time the world is opened. */
const defaultPlayerName = (i) => 'Player ' + (i + 1);
const playerLabel = (p) => (p && p.name) || defaultPlayerName(PLAYERS.indexOf(p));
function setPlayerName(slot, name) {
  const st = PSTATE[slot];
  if (!st) return;
  st.player.name = String(name || '').trim().slice(0, 16) || defaultPlayerName(slot);
  const tag = st.pane.querySelector('.paneTag');
  if (tag) tag.textContent = st.player.name;
  attachNameTag(st.selfModel, st.player.name);
}

/* ================================================================================================
   NAME TAGS (0.727)

   The label floating over a player's head, for everyone else on the couch. A THREE.Sprite, because
   a sprite re-faces the camera at render time — which is exactly what four viewports rendering the
   same scene from four different eyes need, for free.

   It normally draws THROUGH the world (depthTest off) so you can keep track of someone behind a
   wall. Sneaking turns that off: the tag is occluded by blocks like anything else, and dims by
   half — so crouching is how you stop broadcasting where you are.

   Layer 1 is the "never casts a shadow" layer the sky dome and selection box already use, which
   keeps the tag out of both shadow passes.                                                       */
const NAME_TAG_FONT = "600 44px 'Segoe UI', system-ui, sans-serif";
const NAME_TAG_H = 0.26;              // world units tall
function _nameTagTexture(name) {
  const pad = 14, fs = 44;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = NAME_TAG_FONT;
  const w = Math.ceil(probe.measureText(name).width) + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.max(8, w); c.height = fs + pad;
  const g = c.getContext('2d');       // sizing the canvas resets the context, so style it after
  g.font = NAME_TAG_FONT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(0,0,0,0.42)';   // the plate behind the text, as Minecraft does it
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff';
  g.fillText(name, c.width / 2, c.height / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return { tex: t, aspect: c.width / c.height };
}
function attachNameTag(model, name) {
  if (!model) return null;
  const { tex, aspect } = _nameTagTexture(name);
  let s = model.nameTag;
  if (!s) {
    s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
      sizeAttenuation: true,
    }));
    s.renderOrder = 10;               // after the world, so depthTest:false actually reads on top
    s.layers.set(1);
    s.position.y = 2.12;              // just clear of a 1.8-tall model's head
    model.root.add(s);
    model.nameTag = s;
  } else {
    s.material.map?.dispose();
    s.material.map = tex;
    s.material.needsUpdate = true;
  }
  s.userData.baseW = NAME_TAG_H * aspect;      // the render pass scales up from these with range
  s.userData.baseH = NAME_TAG_H;
  s.scale.set(s.userData.baseW, s.userData.baseH, 1);
  return s;
}

/* A sprite with size attenuation shrinks with distance, which is right for an object and wrong for
   a label — across a field the name became a smear. Beyond NAME_TAG_FULL_D the sprite is scaled in
   proportion to its distance, which exactly cancels the attenuation and holds the tag at a
   constant size on screen; inside that it attenuates normally, so someone next to you does not get
   a billboard. Capped so a player half a world away is not a wall of text.

   This has to happen per viewport, not once a frame: with four cameras "the distance" is a
   different number in each of them. */
const NAME_TAG_FULL_D = 14, NAME_TAG_MAX_K = 7;
function _scaleNameTagFor(model, cam) {
  const s = model.nameTag;
  if (!s || !s.visible) return;
  const d = cam.position.distanceTo(model.root.position);
  const k = Math.min(NAME_TAG_MAX_K, Math.max(1, d / NAME_TAG_FULL_D));
  s.scale.set(s.userData.baseW * k, s.userData.baseH * k, 1);
}
const playerRoster = () => PSTATE.map((s, i) => s.player.name || defaultPlayerName(i));

/* ================================================================================================
   HUD PANES

   Each player gets a copy of the heads-up display parked over their own viewport. Player one keeps
   the ORIGINAL elements (moved, not cloned) so nothing that grabbed them at load time goes stale;
   players two to four get deep clones.

   Two CSS details make this work with no changes to the existing HUD rules:
     - duplicate ids are fine for CSS (`#hotbar` matches every element carrying that id); only
       document.getElementById cares, and nothing reaches these through it any more.
     - the inner wrapper carries a `transform`, which makes it the containing block for its
       `position: fixed` descendants. So `#hotbar { bottom: 6px }` lands at the bottom of the PANE
       rather than the bottom of the window, and the scale shrinks the whole HUD to suit a
       quarter-screen viewport.                                                                   */
const HUD_PANE_IDS = ['hud', 'crosshair', 'interact', 'blockname', 'vitals',
                      'xpBar', 'xpPops', 'hotbar', 'deathScreen', 'invWrap'];
/* The virtual cursor, the drag ghost and the item tooltip stay on the BODY rather than inside the
   pane, one set per player. They are positioned in raw screen coordinates — the same space mouse
   events arrive in — so putting them inside the pane's scaled wrapper would transform them twice.
   Keeping them out also means the tooltip stays readable at full size in a quarter viewport. */
const CURSOR_PANE_IDS = ['vcursor', 'vdrag', 'ctip'];

function _makePane(index) {
  const pane = document.createElement('div');
  pane.className = 'hudPane';
  pane.dataset.player = String(index + 1);
  const inner = document.createElement('div');
  inner.className = 'hudScale';
  pane.appendChild(inner);
  for (const id of HUD_PANE_IDS) {
    const src = document.getElementById(id);
    if (!src) continue;
    inner.appendChild(index === 0 ? src : src.cloneNode(true));
  }
  // the damage vignette is created (not appended) by 19-vitals.js — one per pane
  inner.appendChild(index === 0 ? hurtEl : hurtEl.cloneNode(true));
  /* ...and this seat's cursor / drag ghost / tooltip. These stay on the body in unscaled screen
     space, so they are hung off the pane object rather than nested inside it. */
  pane._cursors = {};
  for (const id of CURSOR_PANE_IDS) {
    const src = document.getElementById(id);
    if (!src) continue;
    let el = src;
    if (index > 0) { el = src.cloneNode(false); document.body.appendChild(el); }
    pane._cursors[id] = el;
  }
  // a corner tag naming whose quarter this is; hidden when playing solo
  const tag = document.createElement('div');
  tag.className = 'paneTag';
  tag.textContent = defaultPlayerName(index);
  pane.appendChild(tag);
  document.body.appendChild(pane);
  return pane;
}

// bind the swapped HUD globals to this pane's elements, and return them for the slot snapshot
function _bindPaneDom(pane, g) {
  const q = (sel) => pane.querySelector(sel);
  g.hudEl        = q('#hud');
  g.blocknameEl  = q('#blockname');
  g.hotbarEl     = q('#hotbar');
  g.interactEl   = q('#interact');
  g.vitalsEl     = q('#vitals');
  g.vctx         = g.vitalsEl.getContext('2d');
  g.vctx.imageSmoothingEnabled = false;
  g.xpBarEl      = q('#xpBar');
  g.xpFillEl     = q('#xpFill');
  g.xpLevelEl    = q('#xpLevel');
  g.xpPopsEl     = q('#xpPops');
  g.hurtEl       = q('#hurtOverlay');
  g.deathEl      = q('#deathScreen');
  g.deathCauseEl = q('#deathCause');
  g.deathStatsEl = q('#deathStats');
  // this seat's own inventory panel, and its cursor set (which lives on the body — see _makePane)
  g.invWrapEl = q('#invWrap');
  g.invEl     = q('#inv');
  g.vcurEl    = pane._cursors.vcursor;
  g.vdragEl   = pane._cursors.vdrag;
  g.ctipEl    = pane._cursors.ctip;
  g.invOpen   = false;
  g.invCursor = { x: innerWidth / 2, y: innerHeight / 2, mode: 'mouse' };
  g.dragFrom = null; g.dragHeld = null; g.lastHoverEl = null; g._invSeq = 0;
  g.craftMode = 'basic'; g.craftCat = 'all'; g._craftScroll = 0;
  g.activeFurnace = null; g.activeChest = null; g.activeChest2 = null; g.activeStructBlock = null;
  g.crackMat = newCrackMat();          // this seat mines at its own stage — see 14-mining.js
  g._interactShown = '';
  g.blocknameTimer = 0;
  // a seat that had its debug text hidden last session opens that way again
  const slot = PSTATE.length;              // this pane's seat number (it is pushed right after)
  if (typeof debugHudHidden === 'function' && debugHudHidden(slot)) g.hudEl.style.display = 'none';
  const btn = q('#respawnBtn');
  if (btn) btn.addEventListener('click', () => { const p = g.player; withPlayer(p, respawnPlayer); });
}

/* ================================================================================================
   LAYOUT
   1 player  — the whole window (identical to single player, scale 1)
   2 players — split top / bottom, the way console split screen has always done it
   3 or 4    — 2x2 quadrants, reading order; with three players the fourth quarter stays empty
   ================================================================================================ */
function _viewRects(n) {
  const W = window.innerWidth, H = window.innerHeight;
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  const vert = splitDir === 'v';
  if (n === 2) return vert
    ? [{ x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H }]
    : [{ x: 0, y: 0, w: W, h: H / 2 }, { x: 0, y: H / 2, w: W, h: H / 2 }];
  // three columns fill the window completely, which beats a 2x2 grid with a dead black quarter
  if (n === 3 && vert) {
    const c = W / 3;
    return [0, 1, 2].map(i => ({ x: i * c, y: 0, w: c, h: H }));
  }
  const hw = W / 2, hh = H / 2;
  const quads = [{ x: 0, y: 0, w: hw, h: hh }, { x: hw, y: 0, w: hw, h: hh },
                 { x: 0, y: hh, w: hw, h: hh }, { x: hw, y: hh, w: hw, h: hh }];
  return quads.slice(0, n);
}
// true when the chosen layout leaves part of the window with nobody in it
const _layoutHasGap = (n) => n === 3 && splitDir !== 'v';

/* Roughly what the HUD needs to lay out at scale 1. The width is deliberately the CORE — the
   inventory columns and the hotbar — not the full row including the crafting and equipment side
   panels: a three-column layout is genuinely narrow, and it is far better to let those side panels
   run off the edges than to shrink the grid and the block icons until nobody can read them.
   The height carries the extra grid row 0.7292 added (4x8 instead of 3x9). */
const HUD_FIT_W = 860, HUD_FIT_H = 760;

function relayoutSplitScreen() {
  const n = Math.max(1, PSTATE.length);
  const rects = _viewRects(n);
  const W = window.innerWidth, H = window.innerHeight;
  document.body.classList.toggle('split', n > 1);
  for (let i = 0; i < PSTATE.length; i++) {
    const st = PSTATE[i], r = rects[i];
    // WebGL's viewport origin is the BOTTOM-left corner; the DOM's is the top-left one
    st.view = { x: r.x, y: r.y, w: r.w, h: r.h, gx: r.x, gy: H - r.y - r.h };
    st.camera.aspect = r.w / Math.max(1, r.h);
    st.camera.updateProjectionMatrix();
    /* HUD scale: as large as this viewport can hold, rather than a share of the window.

       It used to be the geometric mean of the viewport's area — 0.5 in a quadrant — which made the
       inventory text and block icons genuinely unreadable at three and four players. Sizing to FIT
       instead is both bigger and safer: the HUD needs roughly HUD_FIT_W x HUD_FIT_H CSS pixels to
       lay out, so the largest honest scale is whatever makes that fit, capped at 1. A quadrant of
       a 1080p screen lands near 0.87 instead of 0.5, and a tall narrow pane (vertical 2-player)
       gets more still, because it genuinely has the room. */
    const s = clampi(Math.min(r.w / HUD_FIT_W, r.h / HUD_FIT_H) * 100, 45, 100) / 100;
    const pane = st.pane, inner = pane.firstElementChild;
    pane.style.left = r.x + 'px';   pane.style.top    = r.y + 'px';
    pane.style.width = r.w + 'px';  pane.style.height = r.h + 'px';
    inner.style.width  = (r.w / s) + 'px';
    inner.style.height = (r.h / s) + 'px';
    inner.style.transform = 'scale(' + s + ')';
    st.hudScale = s;
  }
}

/* ================================================================================================
   JOIN / LEAVE
   ================================================================================================ */
function _newPlayerState(index) {
  // Start from a structural copy of player one so every field (including ones added later by
  // other systems) exists, then give the parts that must not be shared their own objects.
  const src = PLAYERS[0];
  const p = Object.assign({}, src);
  p.pos = src.pos.clone();
  p.profileId = null;                 // set by the caller — never inherited from player one
  p.sleepingAt = null;                // ...nor player one's bed, which Object.assign would copy
  p.spawnPos = null; p.homeSpawn = null; p.spawnBedKey = null;
  p.vy = 0; p.fallStart = null; p.dead = false; p.spawned = false;
  p.hp = MAX_HP; p.food = MAX_FOOD; p.saturation = MAX_SATURATION; p.air = MAX_AIR;
  p.flying = src.canFly; p.fast = false; p.sneaking = false;
  p.aliveT = 0; p._dmgCause = null; p._kick = { x: 0, z: 0 };
  p.yaw = Math.random() * Math.PI * 2; p.pitch = 0;
  return p;
}

function joinPlayer(name) {
  const index = PSTATE.length;
  if (index >= MAX_PLAYERS) return null;
  const p = _newPlayerState(index);
  p.name = String(name || '').trim().slice(0, 16) || defaultPlayerName(index);
  PLAYERS.push(p);
  INPUT_BIND[index] = 'auto';           // until they pick a controller through "Change input"
  PLAYER_CHUNKS.push([1e9, 1e9]);
  const g = {};
  // world-facing pieces this player owns
  g.player   = p;
  g.camera   = newPlayerCamera();
  const body = buildHumanoid();
  body.root.visible = false;
  scene.add(body.root);
  g._selfModel = body;
  g._selfPhase = 0; g._selfPrevX = p.pos.x; g._selfPrevZ = p.pos.z; g._selfCrouch = 0; g._selfLie = 0;
  const held = new THREE.Group();
  body.armR.add(held);
  g._selfHeld = held; g._selfHeldId = undefined;
  g.camView = 0;
  g._atkCooldown = 0; g._lastHeldForAtk = undefined; g._plyKick = p._kick;
  // its own arm rig, since the first-person pose is integrated frame to frame
  const rig = buildHandRig();
  g.handRoot = rig.root; g.armPivot = rig.pivot; g.heldGroup = rig.held; g._matSkin = rig.matSkin;
  g._armGlow = 0; g._bobT = 0; g._swimT = 0; g._eatBobT = 0; g._inactive = 0; g._swingT = -1;
  g._prevMining = false; g._prevBreak = false; g._prevPlace = false;
  g._prevYaw = 0; g._prevPitch = 0; g._heldId = undefined;
  // input + action state
  g.mining = { active: false, x: 0, y: 0, z: 0, elapsed: 0, needed: 0, stage: -1 };
  g.act = { break: false, place: false, lastBreak: 0, lastPlace: 0, padPick: false };
  g.mouseBreak = false; g.mousePlace = false;
  g.pad = { deadzone: 0.16, lookX: 0, lookY: 0, prev: [], radialOpen: false, radialSel: -1 };
  g.invOpen = false; g._bushCd = 0; g.handPlaceSwing = false; g.handPickSwing = false;
  g._eatTimer = 0;
  // carried items — a fresh set in whichever mode the world is in
  g.survStash = { hot: new Array(HOTBAR_SLOTS).fill(null), inv: new Array(INV_SLOTS).fill(null), inv2: new Array(INV2_SLOTS).fill(null) };
  g.survEquip = new Array(EQUIP_SLOTS.length).fill(null);
  g.survBelt  = new Array(BELT_MAX).fill(null);
  // vitals + XP
  g.camShake = { t: 0, dur: 0.25, amp: 0 };
  g._hurtA = 0; g.vitalsDirty = true; g.vitalsShown = false;
  g.playerXP = 0; g.playerLevel = 0; g.playerXPInLevel = 0; g.playerXPNeeded = 40;
  g.xpBarDirty = true; g._xpFlash = 0; g._popSlot = 0;
  g.wasMoving = false; g.lastFlying = p.flying;
  g._hlId = undefined; g._hlLevel = 0; g._hlX = null; g._hlY = null; g._hlZ = null; g._hlRaw = 0;

  const pane = _makePane(index);
  _bindPaneDom(pane, g);
  const st = { g, pane, player: p, camera: g.camera, selfModel: body, hand: rig,
               view: { x: 0, y: 0, w: 1, h: 1, gx: 0, gy: 0 }, handVisible: false, hit: null };
  PSTATE.push(st);
  setPlayerName(index, p.name);
  // fill HOTBAR / invSlots / equipment for the world's current mode, in this player's own context
  withSlot(index, () => { loadInventoryForMode(currentInvMode); hotbarSel = 0; buildHotbar(); });
  relayoutSplitScreen();
  return p;
}

function leavePlayer() {
  if (PSTATE.length <= 1) return;
  const i = PSTATE.length - 1;
  const st = PSTATE[i];
  // hand back anything the departing player was holding onto GLOBALLY, while their slot still
  // exists: the shared inventory panel, and their held-light source (which has to be un-lit
  // properly, not just forgotten, or the glow it cast would stay burned into the chunk).
  withSlot(i, () => {
    toggleInventory(false);
    updatePlayerLight(i, 0, 0, 0, 0);
  });
  if (activeSlot === i) useSlot(0);
  // ...then drop everything they owned out of the scene and the DOM
  scene.remove(st.selfModel.root);
  if (st.selfModel.nameTag) {
    st.selfModel.nameTag.material.map?.dispose();
    st.selfModel.nameTag.material.dispose();
  }
  handScene.remove(st.hand.root);
  const hi = HAND_RIGS.indexOf(st.hand); if (hi >= 0) HAND_RIGS.splice(hi, 1);
  const ci = CAMERAS.indexOf(st.camera);  if (ci >= 0) CAMERAS.splice(ci, 1);
  st.pane.remove();
  PSTATE.pop();
  PLAYERS.pop();
  PLAYER_CHUNKS.pop();
  INPUT_BIND.pop();
  if (inputCapture && inputCapture.slot >= PSTATE.length) cancelInputCapture();
  relayoutSplitScreen();
  rebuildQueues();                 // the departing player's chunk ring is no longer wanted
}

/* Set the player count from the menu. Growing spawns the new players next to player one; shrinking
   drops the highest-numbered ones. */
function setPlayerCount(n) {
  n = clampi(n | 0, 1, MAX_PLAYERS);
  while (PSTATE.length < n) {
    const p = joinPlayer();
    if (!p) break;
    seatNewPlayer(p);
  }
  while (PSTATE.length > n) leavePlayer();
  return PSTATE.length;
}

/* Put a freshly joined player on the ground beside player one. Nothing is streamed around them
   yet, so this only matters once player one has actually spawned — until then they wait, and the
   frame loop's ordinary spawn path picks them up. */
function seatNewPlayer(p) {
  const host = PLAYERS[0];
  if (!host.spawned) return;
  const a = Math.random() * Math.PI * 2;
  const x = host.pos.x + Math.cos(a) * 1.6, z = host.pos.z + Math.sin(a) * 1.6;
  const sy = surfaceY(Math.floor(x), Math.floor(z));
  p.pos.set(x, Math.max(sy + 1, host.pos.y), z);
  p.spawnPos = host.spawnPos ? host.spawnPos.clone() : p.pos.clone();
  p.spawned = true;
  p.vy = 0;
}

/* ================================================================================================
   INPUT ROUTING (0.722)

   A browser does not hand a page its gamepads on request: nothing appears in navigator.getGamepads
   until the page has seen a user gesture AND the pad itself has sent something — a pad sitting
   idle since before the tab opened is invisible, which is exactly the "my controller isn't
   detected" case. `gamepadconnected` is what announces one, and the roster says in plain words to
   press a button on a pad that has not spoken yet.

   Nothing is CACHED: the pad list is re-read on every query, because the Gamepad objects a browser
   hands back are frozen snapshots — holding one from an earlier call gives you a controller whose
   buttons never move again. Assignment is by the pad's own stable `index`, never by "the Nth pad
   in the list", since that list reshuffles the moment somebody's batteries die.

   INPUT_BIND[slot] is what each seat listens to:
     'auto'   pick the first pad nobody else has claimed (player one only takes one when playing
              alone, so a split-screen player one keeps keyboard and mouse to themselves)
     'kbd'    keyboard and mouse only — no pad
     <number> that exact gamepad index, chosen by the player through "Change input"
   The keyboard always drives player one whatever their bind says; the bind only decides pads. */
const INPUT_BIND = ['auto'];

/* Read the pad list. Deliberately paranoid (0.723), because this is the one call everything else
   depends on and it behaves differently in every engine:
     - the result is a GamepadList in some browsers, which is array-LIKE but not iterable, so a
       for...of over it throws rather than returning nothing;
     - entries are null for empty slots;
     - `connected` is absent on some implementations, so testing `=== true` silently drops a pad
       that is genuinely there. Only an explicit `false` means disconnected.
   The returned Gamepad objects are SNAPSHOTS, not live views — which is why nothing caches them
   and every reader calls this again. */
function connectedPads() {
  const out = [];
  let list = null;
  try { list = navigator.getGamepads ? navigator.getGamepads() : null; } catch { list = null; }
  if (!list) return out;
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (g && g.connected !== false && g.buttons) out.push(g);
  }
  return out;
}
const padByIndex = (idx) => connectedPads().find(g => g.index === idx) || null;

/* Which pad drives a seat, resolved LIVE on every call against the current list.

   0.722 cached the resolved Gamepad objects once a frame, which was the regression: a cached
   snapshot is frozen, so anything reading it between refreshes saw a controller that never moved.
   Resolving here is four seats against a handful of pads — cheap enough that caching bought
   nothing and cost detection. */
function padForSlot(slot) {
  const live = connectedPads();
  if (!live.length) return null;
  const b = INPUT_BIND[slot];
  if (b === 'kbd') return null;
  if (typeof b === 'number') return live.find(g => g.index === b) || null;
  /* 'auto': hand out the unclaimed pads in seat order. Pads explicitly bound to another seat are
     reserved even while that seat's controller is unplugged, so a flat battery never silently
     donates someone's pad to the player below them. */
  const claimed = new Set();
  for (let i = 0; i < PSTATE.length; i++)
    if (i !== slot && typeof INPUT_BIND[i] === 'number') claimed.add(INPUT_BIND[i]);
  for (let i = 0; i < PSTATE.length; i++) {
    if (INPUT_BIND[i] === 'kbd' || typeof INPUT_BIND[i] === 'number') continue;
    if (i === 0 && PSTATE.length > 1) continue;      // split screen: seat one is keyboard and mouse
    const g = live.find(p => !claimed.has(p.index));
    if (!g) break;
    claimed.add(g.index);
    if (i === slot) return g;
  }
  // Floor: playing alone is exactly the pre-split-screen case — one player, one pad, no policy.
  return (PSTATE.length <= 1 && slot === 0) ? (live[0] || null) : null;
}
// a human-readable name for what a seat is listening to, for the roster
function inputLabelFor(slot) {
  const g = padForSlot(slot);
  if (g) {
    const named = (g.id || '').split('(')[0].trim();
    const suffix = typeof INPUT_BIND[slot] === 'number' ? '' : ' (auto)';
    return (slot === 0 ? 'keyboard + ' : '') + (named || 'gamepad ' + g.index) + suffix;
  }
  if (slot === 0) return 'keyboard + mouse';
  return typeof INPUT_BIND[slot] === 'number'
    ? 'controller ' + INPUT_BIND[slot] + ' — not connected'
    : 'no controller yet — press a button on one';
}
// how many players could join right now given what is plugged in (player one needs no pad)
const supportedPlayerCount = () => Math.min(MAX_PLAYERS, 1 + connectedPads().length);

/* A pad only becomes visible to the page once it announces itself, so these events are the real
   detection path — not polling. Both re-resolve the assignment and refresh the roster if it is on
   screen, so plugging a controller in mid-menu updates the list you are looking at. */
window.addEventListener('gamepadconnected', (e) => {
  const nm = ((e.gamepad && e.gamepad.id) || '').split('(')[0].trim() || 'controller';
  if (typeof toast === 'function') toast(`${nm} connected`);
  if (typeof renderSplitPanel === 'function') renderSplitPanel();
});
window.addEventListener('gamepaddisconnected', () => {
  if (typeof renderSplitPanel === 'function') renderSplitPanel();
});

/* ================================================================================================
   "CHANGE INPUT" — bind a seat to whichever device speaks next

   While capturing, the game shows "Waiting for input for <name>" and watches every pad plus the
   keyboard. The first button, trigger or stick push claims that pad for the seat; a key claims
   keyboard-only, which is player one's alone. Baselines are taken at the start so a button being
   HELD when capture opens cannot instantly claim it.
   ================================================================================================ */
let inputCapture = null;              // { slot, name, base: Map(padIndex -> {btn:[], axes:[]}) }
const inputWaitEl = document.getElementById('inputWait');
const inputWaitTextEl = document.getElementById('inputWaitText');
const inputWaitHintEl = document.getElementById('inputWaitHint');

function _padSnapshot() {
  const m = new Map();
  for (const g of connectedPads())
    m.set(g.index, { btn: g.buttons.map(b => b.value), axes: g.axes.slice() });
  return m;
}
function beginInputCapture(slot) {
  if (!PSTATE[slot]) return;
  inputCapture = { slot, name: playerLabel(PSTATE[slot].player), base: _padSnapshot() };
  inputWaitTextEl.textContent = `Waiting for input for ${inputCapture.name}`;
  inputWaitHintEl.textContent = slot === 0
    ? 'Press a button on a controller to use it — or any key for keyboard and mouse only. Esc cancels.'
    : 'Press a button on the controller this player will use. Esc cancels.';
  inputWaitEl.style.display = 'flex';
}
function cancelInputCapture() {
  inputCapture = null;
  inputWaitEl.style.display = 'none';
}
function _finishCapture(bind, what) {
  const slot = inputCapture.slot, who = inputCapture.name;
  // one device, one seat: whoever else was holding it explicitly falls back to auto
  if (typeof bind === 'number')
    for (let i = 0; i < PSTATE.length; i++)
      if (i !== slot && INPUT_BIND[i] === bind) INPUT_BIND[i] = 'auto';
  INPUT_BIND[slot] = bind;
  cancelInputCapture();
  if (typeof toast === 'function') toast(`${who}: ${what}`);
  if (typeof renderSplitPanel === 'function') renderSplitPanel();
}
// a key press while capturing — keyboard is player one's device, nobody else can take it
function inputCaptureKey() {
  if (!inputCapture) return false;
  if (inputCapture.slot !== 0) {
    if (typeof toast === 'function') toast('players 2-4 need a controller — press a button on one');
    return true;                       // swallowed either way: the game must not act on this key
  }
  _finishCapture('kbd', 'keyboard + mouse');
  return true;
}
/* Watch every pad for something that MOVED since capture opened. Runs every frame from the main
   loop, menu open or not, because binding is done from the pause menu. */
function pollInputCapture() {
  if (!inputCapture) return;
  for (const g of connectedPads()) {
    const b = inputCapture.base.get(g.index);
    let hit = false;
    for (let i = 0; i < g.buttons.length; i++) {
      const v = g.buttons[i].value, was = b ? (b.btn[i] || 0) : 0;
      if (v > 0.6 && v - was > 0.4) { hit = true; break; }
    }
    if (!hit) for (let i = 0; i < g.axes.length; i++) {
      const was = b ? (b.axes[i] || 0) : 0;
      if (Math.abs(g.axes[i] - was) > 0.6) { hit = true; break; }
    }
    if (!hit) continue;
    const nm = (g.id || '').split('(')[0].trim() || ('gamepad ' + g.index);
    _finishCapture(g.index, nm);
    return;
  }
}

/* ================================================================================================
   PER-FRAME ENTRY POINTS (called from 22-main-loop.js)
   ================================================================================================ */
// keep the streaming centres current; a crossing rebuilds the union of every player's ring
function syncPlayerChunks() {
  let moved = false;
  for (let i = 0; i < PSTATE.length; i++) {
    const p = PSTATE[i].player;
    const cx = Math.floor(p.pos.x / 16), cz = Math.floor(p.pos.z / 16);
    const pc = PLAYER_CHUNKS[i];
    if (pc[0] !== cx || pc[1] !== cz) { pc[0] = cx; pc[1] = cz; moved = true; }
    if (i === 0) { playerCX = cx; playerCZ = cz; }
  }
  if (moved) { _wakeIdle = false; rebuildQueues(); }
}

/* One render pass per player: its own viewport, its own scissor rectangle (so each view clears to
   its own sky colour and its own underwater tint), its own bodies-visible decision, and its own
   first-person arm on top. */
function renderAllViews(dt) {
  /* The title panorama is one camera pointed at scenery — nobody has joined it and nothing in it
     is playable, so it draws once through player one's view whatever the player count says. */
  const n = menuScene ? 1 : PSTATE.length;
  for (let i = 0; i < PSTATE.length; i++) PSTATE[i].pane.style.display = i < n ? '' : 'none';
  const full = n <= 1 ? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight,
                          gx: 0, gy: 0 } : null;
  renderer.setScissorTest(n > 1);
  for (let i = 0; i < n; i++) {
    const st = PSTATE[i], v = full || st.view;
    useSlot(i);
    const want = v.w / Math.max(1, v.h);
    if (Math.abs(camera.aspect - want) > 1e-4) { camera.aspect = want; camera.updateProjectionMatrix(); }
    renderer.setViewport(v.gx, v.gy, v.w, v.h);
    renderer.setScissor(v.gx, v.gy, v.w, v.h);
    /* Bodies. A player sees their OWN body only in third person, and always sees everyone
       else's — that is the whole point of sharing a world. */
    for (let j = 0; j < n; j++) {
      const other = PSTATE[j];
      other.selfModel.root.visible = (j === i)
        ? !!other.player._bodyVisibleToSelf
        : (other.player.spawned && !menuScene);
      // a name tag is for everyone ELSE — nobody needs their own name hanging over their head
      if (other.selfModel.nameTag) {
        other.selfModel.nameTag.visible = (j !== i) && other.selfModel.root.visible;
        _scaleNameTagFor(other.selfModel, camera);     // hold it legible at range, for THIS eye
      }
    }
    // this player's aimed block outline / crack overlay (both are single shared scene objects)
    const sel = st.sel;
    selBox.visible = !!sel;
    if (sel) { selBox.position.set(sel.px, sel.py, sel.pz); selBox.scale.set(sel.sx, sel.sy, sel.sz); selBox.updateMatrix(); }
    const cr = st.crack;
    crackMesh.visible = !!cr;
    // the seat's OWN material, so its stage is the one this viewport shows (0.734)
    if (crackMesh.material !== crackMat) crackMesh.material = crackMat;
    if (cr) { crackMesh.position.set(cr.px, cr.py, cr.pz); crackMesh.scale.set(cr.sx, cr.sy, cr.sz); }
    alignSkyTo(camera);                  // the dome is drawn around THIS eye
    applyEyeVolumeFog();                 // water / lava murk for THIS eye, restored per pass
    renderer.render(scene, camera);
    /* first-person hand — its own depth buffer, always on top. Only the active player's rig is
       visible; clearDepth is scissored to this viewport, so it never wipes a finished one. */
    for (let j = 0; j < n; j++) HAND_RIGS[j].root.visible = (j === i) && PSTATE[j].handVisible;
    if (camView === 0 && PSTATE[i].handVisible) {
      handCam.aspect = v.w / Math.max(1, v.h);
      handCam.updateProjectionMatrix();
      renderHandPass();
    }
  }
  /* A 2x2 grid with three players leaves one quarter with nobody in it. Nothing ever draws there,
     and with the scissor test on nothing ever clears it either — so it would hold whatever was on
     screen when the third player joined, forever. Wipe it explicitly. (Three columns fill the
     window, so the vertical layout needs none of this.) */
  if (_layoutHasGap(n)) {
    const W = window.innerWidth, H = window.innerHeight;
    renderer.setViewport(W / 2, 0, W / 2, H / 2);
    renderer.setScissor(W / 2, 0, W / 2, H / 2);
    renderer.setClearColor(0x000000);
    renderer.clear(true, true, false);
  }
  for (const st of PSTATE) st.selfModel.root.visible = false;   // leave the scene tidy for shadows
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  useSlot(0);                            // DOM events between frames always belong to player one
}

/* ================================================================================================
   PERSISTENCE — keyed by PROFILE, not by slot (0.721)

   A save holds one record per person who has played that world, tagged with their profile id.
   Slot numbers are not stable across sessions — being player three yesterday and player two today
   is still the same person — so the records are matched on profile, and the roster of profiles is
   what the world reopens with.

   Player one's record is ALSO written to the legacy top-level `player` / `surv*` fields so an
   older build still opens the save and reads it as an ordinary single-player world.
   ================================================================================================ */
function _serializeSlot(i) {
  const g = PSTATE[i].g, p = g.player;
  return {
    profile: p.profileId || null,
    name: p.name || defaultPlayerName(i),
    pos: [+p.pos.x.toFixed(2), +p.pos.y.toFixed(2), +p.pos.z.toFixed(2)],
    yaw: p.yaw, pitch: p.pitch, hp: p.hp, food: p.food, saturation: p.saturation,
    flying: p.flying, hotSel: g.hotbarSel,
    spawnPos: p.spawnPos ? p.spawnPos.toArray() : null,
    homeSpawn: p.homeSpawn ? p.homeSpawn.toArray() : null,
    spawnBedKey: p.spawnBedKey || null,
    survHot: g.survStash.hot, survInv: g.survStash.inv, survInv2: g.survStash.inv2,
    survEquip: g.survEquip, survBelt: g.survBelt,
    xp: g.playerXP,
  };
}
/* Everyone currently playing, plus everyone the save already knew about who is not in this
   session — dropping out for one evening must not erase what you were carrying. */
function serializePlayerRecords() {
  _captureSlot(activeSlot);            // the installed slot's snapshot has to be current first
  const out = [], seen = new Set();
  for (let i = 0; i < PSTATE.length; i++) {
    const rec = _serializeSlot(i);
    if (rec.profile) seen.add(rec.profile);
    out.push(rec);
  }
  for (const [id, rec] of _recByProfile)
    if (id && !seen.has(id)) out.push(rec);
  return out;
}

/* Records from the save, waiting to be claimed. A record is consumed the moment its owner is
   actually seated, and seating is DEFERRED until the ground under their stored position exists —
   placing them the instant the world data arrived was a real bug: the chunk had not streamed in
   yet, so they dropped through an empty world and starved before it caught up. */
let _recByProfile = new Map();
let _savedRoster = [];               // profile ids this world was last played with, in slot order

function restorePlayerRecords(data) {
  _recByProfile = new Map();
  _savedRoster = [];
  const list = data && Array.isArray(data.players) ? data.players : null;
  if (list) {
    for (const rec of list) {
      if (!rec || !Array.isArray(rec.pos)) continue;
      if (rec.profile) _recByProfile.set(rec.profile, rec);
      _savedRoster.push(rec.profile || null);
    }
  } else if (data && data.player && Array.isArray(data.player.pos) && data.player.profile) {
    // a save written before `players` existed still names its owner
    _recByProfile.set(data.player.profile, {
      ...data.player, survHot: data.survHot, survInv: data.survInv, survInv2: data.survInv2,
      survEquip: data.survEquip, survBelt: data.survBelt,
      xp: data.xp && data.xp.xp,
    });
    _savedRoster.push(data.player.profile);
  }
  resetExtraPlayers();
}
// the record belonging to a profile, or null — used by loadWorld to seat player one correctly
const playerRecordFor = (profileId) => (profileId && _recByProfile.get(profileId)) || null;

/* Which saved profiles should rejoin when this world opens: everyone the save knew about except
   whoever is already player one, skipping profiles that have since been deleted. */
function autoJoinSavedRoster() {
  if (!currentWorld || !currentWorld.split) return;
  const mine = PSTATE[0].player.profileId;
  for (const id of _savedRoster) {
    if (!id || id === mine) continue;
    if (PSTATE.length >= MAX_PLAYERS) break;
    if (PSTATE.some(s => s.player.profileId === id)) continue;
    const prof = typeof profileById === 'function' ? profileById(id) : null;
    if (!prof) continue;                       // profile deleted since — their record just waits
    const p = joinPlayer(prof.name);
    if (!p) break;
    p.profileId = id;
  }
}

/* Wipe every extra slot back to a clean player. Runs on every world load: carrying the previous
   world's pockets into the next one would be a duplication bug. `restoreXP` is deliberately not
   used — it also clears the player-placed block ledger, which is world state shared by everyone. */
function resetExtraPlayers() {
  for (let i = 1; i < PSTATE.length; i++) {
    withSlot(i, () => {
      player.spawned = false; player.dead = false;
      player.vy = 0; player.fallStart = null; player.aliveT = 0; player._dmgCause = null;
      player.hp = MAX_HP; player.food = MAX_FOOD; player.saturation = MAX_SATURATION; player.air = MAX_AIR;
      player.spawnPos = null;
      survStash = { hot: new Array(HOTBAR_SLOTS).fill(null), inv: new Array(INV_SLOTS).fill(null), inv2: new Array(INV2_SLOTS).fill(null) };
      restoreEquip(null, null);
      setXP(0);
      hotbarSel = 0;
      loadInventoryForMode(currentInvMode);
      buildHotbar();
      vitalsDirty = true; xpBarDirty = true;
    });
  }
}

/* Leaving mid-session parks what you were carrying back in the pending map, so re-adding the same
   profile in the same session hands it straight back instead of starting them empty. */
function stashPlayerRecord(slot) {
  if (slot <= 0 || slot >= PSTATE.length) return;
  _captureSlot(activeSlot);
  const rec = _serializeSlot(slot);
  if (rec.profile) _recByProfile.set(rec.profile, rec);
}

const hasPendingExtraRestore = (slot) => {
  const st = PSTATE[slot];
  return !!(st && playerRecordFor(st.player.profileId));
};
/* Try to seat the player in `slot` from their saved record. Returns true once done — the frame
   loop keeps asking until the chunk under their stored position has streamed in. Called with that
   slot's globals already installed. */
function applyExtraPlayerRestore(slot) {
  const rec = playerRecordFor(player.profileId);
  if (!rec) return false;
  const c = getChunk(Math.floor(rec.pos[0] / 16), Math.floor(rec.pos[2] / 16));
  if (!c || !c.data) return false;                    // ground not there yet — ask again next frame
  _recByProfile.delete(player.profileId);             // consumed
  player.pos.set(rec.pos[0], rec.pos[1], rec.pos[2]);
  if (typeof rec.yaw === 'number') player.yaw = rec.yaw;
  if (typeof rec.pitch === 'number') player.pitch = rec.pitch;
  player.hp = typeof rec.hp === 'number' ? rec.hp : MAX_HP;
  player.food = typeof rec.food === 'number' ? rec.food : MAX_FOOD;
  player.saturation = typeof rec.saturation === 'number' ? rec.saturation : MAX_SATURATION;
  player.flying = !!rec.flying && player.canFly;
  player.vy = 0; player.fallStart = null;
  player.spawnPos = Array.isArray(rec.spawnPos)
    ? new THREE.Vector3(rec.spawnPos[0], rec.spawnPos[1], rec.spawnPos[2]) : null;
  player.homeSpawn = Array.isArray(rec.homeSpawn)
    ? new THREE.Vector3(rec.homeSpawn[0], rec.homeSpawn[1], rec.homeSpawn[2]) : null;
  player.spawnBedKey = rec.spawnBedKey || null;
  survStash = migrateStash(rec.survHot, rec.survInv, rec.survInv2);
  restoreEquip(rec.survEquip, rec.survBelt);
  loadInventoryForMode(currentInvMode);
  if (typeof rec.hotSel === 'number' && rec.hotSel >= 0 && rec.hotSel < HOTBAR_SLOTS) hotbarSel = rec.hotSel;
  if (typeof rec.xp === 'number') setXP(rec.xp);
  buildHotbar();
  player.spawned = true;
  vitalsDirty = true; xpBarDirty = true;
  return true;
}
// same thing, but for a player added from the pause menu right now (their chunks are already in)
const applyExtraPlayerRestoreNow = (slot) => withSlot(slot, () => applyExtraPlayerRestore(slot));

/* ================================================================================================
   BOOT
   ================================================================================================ */
function initSplitScreen() {
  // slot 0 adopts the globals exactly as every other file left them
  const pane = _makePane(0);
  const g = {};
  const st = { g, pane, player: PLAYERS[0], camera, selfModel: _selfModel, hand: HAND_RIGS[0],
               view: { x: 0, y: 0, w: 1, h: 1, gx: 0, gy: 0 }, handVisible: false, hit: null };
  PSTATE.push(st);
  _captureSlot(0);                     // snapshot the live globals into slot 0...
  _bindPaneDom(pane, g);               // ...then point its HUD at pane 0
  _installSlot(0);
  PLAYERS[0]._kick = _plyKick;
  // player one plays as the selected profile (37-profiles.js keeps this in step)
  PLAYERS[0].profileId = typeof activeProfileId !== 'undefined' ? activeProfileId : null;
  PLAYERS[0].name = typeof activeProfileName === 'function' ? activeProfileName() : defaultPlayerName(0);
  relayoutSplitScreen();
  window.addEventListener('resize', relayoutSplitScreen);
}
