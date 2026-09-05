'use strict';
/* voxiCraft — world saves (IndexedDB), menu screens, title panorama */

/* ================================================================================================
   INPUT — keyboard + mouse (pointer lock) and Gamepad API (standard mapping, index-based).
   ================================================================================================ */
const keys = {};
let pointerLocked = false;

const overlay = document.getElementById('overlay');
const seedInput = document.getElementById('seedInput');
seedInput.value = (new URLSearchParams(location.search).get('seed') || '').replace(/[^a-z0-9]/gi, '');

/* ================================================================================================
   WORLDS — named save files in localStorage. `vc_worlds` holds the registry; each world's
   data (block edits, drops, survival inventory, player state, time) lives in vc_world_<id>.
   Unlimited worlds; names deduplicate by appending +1 (World, World1, World2, ...).
   Survival-created worlds are locked to survival; creative-created ones may switch freely.
   ================================================================================================ */
const menuHome    = document.getElementById('menuHome');
const menuWorlds  = document.getElementById('menuWorlds');
const menuCreate  = document.getElementById('menuCreate');
const menuPause   = document.getElementById('menuPause');
const menuProfiles = document.getElementById('menuProfiles');
const menuExtras  = document.getElementById('menuExtras');
const menuSub     = document.getElementById('menuSub');
const worldListEl = document.getElementById('worldList');
const worldNameIn = document.getElementById('worldName');
const newModeSel  = document.getElementById('newModeSel');
const newTerrainSel = document.getElementById('newTerrainSel');
const newSplitChk = document.getElementById('newSplitChk');
const tickInput   = document.getElementById('tickInput');
const modeLabel   = document.getElementById('modeLabel');

const worldLoadingEl    = document.getElementById('worldLoading');
const worldLoadingNameEl = document.getElementById('worldLoadingName');
let _loadingWorld = false;   // true while initial chunks are generating; hides loading screen when done

let WORLDS = (() => { try { const a = JSON.parse(localStorage.getItem('vc_worlds')); return Array.isArray(a) ? a : []; } catch { return []; } })();
let currentWorld = null;
let pendingRestore = null;                  // player one's own saved state, applied once their chunk loads
let pendingWorldRestore = null;             // drops + loose mobs, applied once anything is loaded (0.721)

/* World DATA lives in IndexedDB (structured clone — no localStorage 5MB ceiling); only the
   small registry stays in localStorage. Legacy localStorage saves migrate over on load, and
   beforeunload keeps a synchronous localStorage copy since unload-time IDB writes can drop. */
let idb = null;
const idbReady = new Promise((res) => {
  try {
    const rq = indexedDB.open('voxicraft', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('worlds');
    rq.onsuccess = () => { idb = rq.result; res(); };
    rq.onerror = () => res();
  } catch { res(); }
});
const idbPut = (id, data) => new Promise((res, rej) => {
  if (!idb) return rej(new Error('no idb'));
  const tx = idb.transaction('worlds', 'readwrite');
  tx.objectStore('worlds').put(data, id);
  tx.oncomplete = res;
  tx.onerror = () => rej(tx.error);
});
const idbGet = (id) => new Promise((res) => {
  if (!idb) return res(undefined);
  try {
    const rq = idb.transaction('worlds', 'readonly').objectStore('worlds').get(id);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(undefined);
  } catch { res(undefined); }
});
const idbDel = (id) => { if (idb) try { idb.transaction('worlds', 'readwrite').objectStore('worlds').delete(id); } catch {} };

const persistWorlds = () => localStorage.setItem('vc_worlds', JSON.stringify(WORLDS));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function uniqueWorldName(raw) {
  const base = (raw || '').trim().slice(0, 24) || 'World';
  if (!WORLDS.some(w => w.name === base)) return base;
  let n = 1;
  while (WORLDS.some(w => w.name === base + n)) n++;
  return base + n;
}

function saveWorld(syncToLS = false) {
  if (!currentWorld) return;
  const edits = {};
  for (const [k, m] of editStore) if (m.size) edits[k] = [...m];
  const drops = DROPS.map(r => [r.id,
    +r.group.position.x.toFixed(2), +r.group.position.y.toFixed(2), +r.group.position.z.toFixed(2),
    +r.vx.toFixed(2), +r.vy.toFixed(2), +r.vz.toFixed(2),
    Math.round(r.age * 10) / 10, Math.max(0, +(r.pickupDelay || 0).toFixed(2))]);
  const furnaces = [...FURNACES].map(([k, f]) =>
    [k, f.slots, +f.burn.toFixed(2), +f.burnMax.toFixed(2), +f.progress.toFixed(3)]);
  const data = {
    savedAt: Date.now(),
    edits, drops, furnaces, entities: serializeEntities(), chests: serializeChests(),
    entChunks: serializeEntChunks(),      // chunks that already rolled their mob population
    // structures: which chunks were already rolled, unopened loot markers, structure-block setups
    structPlaced: serializeStructPlaced(), structLoot: serializePendingLoot(),
    structBlocks: serializeStructBlocks(),
    time: worldTime, worldDay, curMode: currentInvMode,
    survHot: survStash.hot, survInv: survStash.inv, survInv2: survStash.inv2,
    survEquip: serializeEquip(), survBelt: serializeBelt(),
    xp: serializeXP(),                    // total experience + the player-placed block ledger
    player: { pos: [player.pos.x, player.pos.y, player.pos.z], yaw: player.yaw, pitch: player.pitch,
              hp: player.hp, food: player.food, saturation: player.saturation, flying: player.flying,
              hotSel: hotbarSel, profile: player.profileId || null,
              spawnPos: player.spawnPos ? player.spawnPos.toArray() : null },
    /* One record per person who has played this world, tagged with their profile (0.721) — see
       the header of 36-splitscreen.js's persistence section. Player one ALSO keeps writing the
       original top-level fields above, so an older build still opens this save. */
    players: serializePlayerRecords(),
  };
  const id = currentWorld.id;
  if (syncToLS) {           // unload path: synchronous localStorage copy, IDB may not finish
    try { localStorage.setItem('vc_world_' + id, JSON.stringify(data)); } catch {}
  }
  idbPut(id, data)
    .then(() => { if (!syncToLS) localStorage.removeItem('vc_world_' + id); })
    .catch(() => {
      try { localStorage.setItem('vc_world_' + id, JSON.stringify(data)); }
      catch { toast('save failed — storage full'); }
    });
  if (!syncToLS) _captureThumb(id);   // update thumbnail on every async save
  currentWorld.lastPlayed = Date.now();
  currentWorld.savedDay = worldDay;    // in-game day at the moment of the save, shown in the list
  persistWorlds();
}

async function loadWorld(w) {
  if (currentWorld && currentWorld !== w) saveWorld();   // switching worlds: save the old one first
  currentWorld = w;
  menuScene = false;
  setHudVisible(true);
  _loadingWorld = true;
  worldLoadingNameEl.textContent = w.name;
  worldLoadingEl.style.display = 'flex';
  // everything the title screen did not need — icons, item sprites, prefabs — starts here, behind
  // the loading screen, where there is already something covering the wait
  ensureGameAssets();
  const vd = clampi(+distInput.value || 10, 4, 32);      // leave the short panorama distance
  if (vd !== viewDist) { viewDist = vd; applyViewDist(); }
  randomTickSpeed = clampi(+w.tickSpeed || 3, 0, 20);     // world's simulation-speed setting
  if (!w.createdVersion) w.createdVersion = 'pre-0.443';  // legacy worlds predate version stamping
  w.lastVersion = GAME_VERSION;                           // record the version this session joined on
  persistWorlds();
  await idbReady;
  let data = await idbGet(w.id);
  let ls = null;
  try { ls = JSON.parse(localStorage.getItem('vc_world_' + w.id)); } catch {}
  if (ls && (!data || (ls.savedAt || 0) > (data.savedAt || 0))) data = ls;   // pick the newest copy
  setPlayerCount(1);                  // the roster is per world; the previous one's players leave
  resetWorld(w.seed, w.terrain);      // worlds saved before 0.665 have no `terrain` -> 'default'
  if (data && data.edits)
    for (const k in data.edits) { const m = new Map(data.edits[k]); if (m.size) editStore.set(k, m); }
  FURNACES.clear();                          // restore per-block furnace state
  activeFurnace = null;
  if (data && Array.isArray(data.furnaces))
    for (const rec of data.furnaces) {
      if (!Array.isArray(rec) || typeof rec[0] !== 'string') continue;
      const f = mkFurnace();
      f.slots = _validArr(rec[1], 3);
      f.burn = Math.max(0, +rec[2] || 0);
      f.burnMax = Math.max(1, +rec[3] || 1);
      f.progress = Math.min(1, Math.max(0, +rec[4] || 0));
      // saved edits may carry the lit-front variant; claiming "lit" here forces the first
      // tick to write the correct variant either way (same-value writes are no-ops)
      f.lit = true;
      FURNACES.set(rec[0], f);
    }
  glowClear();                               // re-derive glowstone lights from the saved edits
  clearDoors();                              // + rebuild door meshes from saved bottom halves
  clearBeds();                               // and bed meshes from saved FOOT cells
  clearChests();
  if (data && Array.isArray(data.chests)) restoreChests(data.chests);   // contents before meshes
  // structure state must land BEFORE any chunk streams in, or already-rolled chunks re-roll
  restoreStructPlaced(data && data.structPlaced);
  // same rule for mobs: this must land before any chunk streams in, or it re-rolls its population
  restoreEntChunks(data && data.entChunks);
  restorePendingLoot(data && data.structLoot);
  restoreStructBlocks(data && data.structBlocks);
  for (const [k, m] of editStore) {
    const cxz = k.split(','), gx = cxz[0] * 16, gz = cxz[1] * 16;
    for (const [i, v] of m) {
      if (blockLightOf(v) > 0)
        glowAdd(gx + (i & 15), i >> 8, gz + ((i >> 4) & 15));
      if ((v & 255) === B.DOOR && !((v >> 8) & 8))
        registerDoor(gx + (i & 15), i >> 8, gz + ((i >> 4) & 15), (v >> 8) & 3,
                     ((v >> 8) & 4) !== 0, ((v >> 8) & DOOR_HINGE_R) !== 0);
      if ((v & 255) === B.BED && !((v >> 8) & 8))     // only the foot half owns a mesh
        registerBed(gx + (i & 15), i >> 8, gz + ((i >> 4) & 15), (v >> 8) & 3);
      if ((v & 255) === B.CHEST)
        registerChest(gx + (i & 15), i >> 8, gz + ((i >> 4) & 15), (v >> 8) & 3);
    }
  }
  /* Who is player one in this world?  (0.721)
     The save holds one record per profile, so the person sitting at the keyboard gets THEIR OWN
     things back — even if they were player three last time. Only when the save has no record for
     them (a world they have never joined, or one written before profiles existed) does the legacy
     top-level record apply, and that in turn only when it is unowned. */
  restorePlayerRecords(data);
  const _mine = playerRecordFor(player.profileId);
  const _legacy = (data && data.player && Array.isArray(data.player.pos) && !data.player.profile)
                ? data.player : null;
  const _own = _mine || _legacy;
  // only restore survival inventory when there is a real record to restore (proves they played it).
  // Any other case (fresh world, ID collision, corrupt/missing data) starts empty.
  survStash = _own
    ? migrateStash(_own.survHot ?? data.survHot, _own.survInv ?? data.survInv, _own.survInv2 ?? data.survInv2)
    : migrateStash(null, null, null);
  // worn gear (and anything on the belt) rides with the survival stash
  restoreEquip(_own ? (_own.survEquip ?? data.survEquip) : null,
               _own ? (_own.survBelt ?? data.survBelt) : null);
  restoreXP(_own ? (typeof _own.xp === 'number' ? { xp: _own.xp, placed: (data.xp && data.xp.placed) } : data.xp) : null);
  if (data && typeof data.time === 'number') { worldTime = ((data.time % 1) + 1) % 1; worldDay = typeof data.worldDay === 'number' ? data.worldDay : 0; }
  else { worldTime = 1 / 24; worldDay = 0; }  // new world: start at 07:00, day 0
  // survival-created worlds are locked to survival; creative worlds resume their last mode
  modeSel.value = w.mode === 'survival' ? 'survival' : ((data && data.curMode) || w.mode);
  loadInventoryForMode(modeSel.value === 'survival' ? 'survival' : 'creative');
  hotbarSel = 0; buildHotbar(); buildInventory();
  /* Drops and loose mobs are WORLD state, not player state: they are restored exactly once, no
     matter whose profile is sitting in seat one — including a profile that has never opened this
     world and therefore has no record of its own to spawn from. */
  pendingWorldRestore = (data && (data.drops || data.entities))
    ? { drops: data.drops, entities: data.entities } : null;
  pendingRestore = _own ? { ..._own } : null;
  if (pendingRestore) player.pos.set(pendingRestore.pos[0], 96, pendingRestore.pos[2]); // stream the right chunks
  else if (data && data.player && Array.isArray(data.player.pos))
    player.pos.set(data.player.pos[0], 96, data.player.pos[2]);  // new face: still start where the world is built
  // everyone else this world was last played with rejoins, if their profile still exists
  autoJoinSavedRoster();
  refreshMenu();
  // capture first thumbnail after chunks settle (~4s)
  const _thumbId = w.id;
  setTimeout(() => { if (currentWorld && currentWorld.id === _thumbId) _captureThumb(_thumbId); }, 4000);
}

function restoreDrops(list) {
  if (!Array.isArray(list)) return;
  for (const d of list) {
    if (!Array.isArray(d) || d.length < 4) continue;
    const [id, x, y, z, vx = 0, vy = 0, vz = 0, age = 0, pd = 0] = d;
    if (!PLACEABLE.includes(id) && !ITEM_PROPS[id]) continue;
    const rec = spawnDrop(id, Math.floor(x), Math.floor(y), Math.floor(z), { x: vx, y: vy, z: vz }, pd);
    if (rec) { rec.group.position.set(x, y, z); rec.age = age; }
  }
}

function deleteWorld(w) {
  WORLDS = WORLDS.filter(x => x !== w);
  persistWorlds();
  localStorage.removeItem('vc_world_' + w.id);
  idbDel(w.id);
  if (currentWorld === w) { currentWorld = null; pendingRestore = null; }
  refreshMenu();
}

function _captureThumb(id) {
  try {
    const url = renderer.domElement.toDataURL('image/jpeg', 0.4);
    idbPut('thumb:' + id, url).catch(() => {});
  } catch (e) {}
}

function renderWorldList() {
  worldListEl.innerHTML = '';
  if (!WORLDS.length) {
    worldListEl.innerHTML = '<div class="wempty">no worlds yet — name one and press Create</div>';
    return;
  }
  const sorted = [...WORLDS].sort((a, b) => (b.lastPlayed || b.created || 0) - (a.lastPlayed || a.created || 0));
  /* "12 Mar, 14:03" — short. The year is dropped: these are save files, not archives, and the
     whole point of the rewrite below is that everything fits on ONE line under the name. */
  const _stamp = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }) + ', ' +
           d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  };
  for (const w of sorted) {
    const row = document.createElement('div');
    row.className = 'wrow';
    /* One name, one info line. It used to be a name plus three stacked lines, which the row's
       fixed height then clipped — which is why the timestamps I added were nowhere to be seen.
       `savedDay` is the in-game day the world was last written at, so the line says both when you
       last played in real time and how far along the world itself is. */
    const bits = [
      `seed ${escapeHtml(w.seed)}`,
      escapeHtml(w.mode),
      `created ${_stamp(w.created)}`,
      `played ${_stamp(w.lastPlayed || w.created)}`,
    ];
    if (w.split) bits.push('split screen');
    if (typeof w.savedDay === 'number') bits.push(`day ${w.savedDay}`);
    bits.push(`v${escapeHtml(w.lastVersion || w.createdVersion || 'pre-0.443')}`);
    row.innerHTML =
      `<div class="wshade"></div>` +
      `<div class="wbody">` +
        `<div class="winfo">` +
          `<b>${escapeHtml(w.name)}</b>` +
          `<span class="wseed">${bits.join(' &middot; ')}</span>` +
        `</div>` +
      `</div>` +
      `<div class="wbtns"></div>`;
    /* The save's own screenshot IS the row now — stretched across it as a background, with a
       scrim over the top for legibility — instead of a separate 104px thumbnail box beside the
       text. Same image, same IDB key; it just fills the space it used to sit next to. */
    idbGet('thumb:' + w.id).then(url => {
      if (!url) return;
      row.style.backgroundImage = `url("${url}")`;
      row.classList.add('has-thumb');
    });
    const btns = row.querySelector('.wbtns');
    const play = document.createElement('button');
    play.textContent = 'Play';
    play.onclick = async () => { await loadWorld(w); setPlaying(true); lockTries = 0; tryPointerLock(); };
    const del = document.createElement('button');
    del.textContent = '✕';
    del.className = 'wdel';
    del.title = 'delete world';
    del.onclick = () => { if (confirm(`Delete world "${w.name}" forever?`)) deleteWorld(w); };
    btns.append(play, del);
    worldListEl.appendChild(row);
  }
}

let menuScreen = 'home';                    // 'home' | 'worlds' | 'create' | 'pause' | 'profiles'
function refreshMenu(screen) {
  if (screen) menuScreen = screen;
  /* First run has no profile, and a save has to belong to somebody — so until one exists the
     profile screen IS the menu. Enforced here rather than only at boot, so no path (Escape, a quit
     to title, deleting the last profile) can slip past it. */
  if (needsFirstProfile()) menuScreen = 'profiles';
  else if (menuScreen !== 'profiles') {
    if (currentWorld) menuScreen = 'pause';
    else if (menuScreen === 'pause') menuScreen = 'home';
  }
  const s = menuScreen;
  menuHome.style.display     = s === 'home'     ? 'block' : 'none';
  menuWorlds.style.display   = s === 'worlds'   ? 'block' : 'none';
  menuCreate.style.display   = s === 'create'   ? 'block' : 'none';
  menuPause.style.display    = s === 'pause'    ? 'block' : 'none';
  menuProfiles.style.display = s === 'profiles' ? 'block' : 'none';
  menuExtras.style.display = (s === 'home' || s === 'pause') ? 'block' : 'none';
  // the gamemode dropdown only exists inside worlds CREATED as creative
  modeLabel.style.display  = (s === 'pause' && currentWorld && currentWorld.mode === 'creative') ? 'flex' : 'none';
  menuSub.textContent = s === 'pause'    ? `${currentWorld.name} — paused (auto-saves)`
                      : s === 'worlds'   ? 'select a world'
                      : s === 'create'   ? 'create a new world'
                      : s === 'profiles' ? (needsFirstProfile() ? 'who is playing?' : 'profiles on this device')
                      : 'infinite voxel world · greedy-meshed · worker-generated';
  if (s === 'worlds') renderWorldList();
  if (s === 'profiles') renderProfiles();
  if (s === 'pause') renderSplitPanel();     // the split-screen roster lives on the pause screen
  paintProfileLabel();
}

/* Minecraft-style title panorama: a fixed scenic overlook on the dedicated "voxicraft" seed
   (forest hilltop with mountains and water in view), rendered at view distance 4 with the
   camera slowly circling. */
const MENU_SPOT = { x: 34, y: 165, z: 284, pitch: -0.36 };   // above the raised (sea-level 99) terrain
let menuScene = false;
function setHudVisible(v) {
  /* vitals and the XP bar were missing from this list, so quitting to the title screen left the
     hearts, hunger and level bar sitting over the panorama. They own their own visibility while
     playing (survival only), so hiding is unconditional but SHOWING is left to them — otherwise
     this would force a creative player's heart row back on. */
  /* Every one of these lives inside a per-player HUD pane now (0.72), so the sweep runs over all
     the panes rather than over document ids — with four players there are four of each. */
  for (const [i, pane] of hudPanes().entries()) {
    for (const sel of ['#hud', '#hotbar', '#crosshair']) {
      const el = pane.querySelector(sel);
      if (!el) continue;
      // ...but never un-hide debug text this seat deliberately turned off with F3 / pad Back
      const off = !v || (sel === '#hud' && debugHudHidden(i));
      el.style.display = off ? 'none' : '';
    }
    if (!v) for (const sel of ['#vitals', '#xpBar', '#xpPops'])
      { const el = pane.querySelector(sel); if (el) el.style.display = 'none'; }
  }
  if (!v) {
    // both of those cache their last shown state and only touch the DOM on a change, so the
    // cached flags have to be cleared or neither would ever come back — for every player
    forEachPlayerState((g) => {
      g.vitalsShown = false;
      if (g.xpBarEl) g.xpBarEl._shown = undefined;
    });
  }
}
/* The panorama is not allowed to be watched while it assembles: the canvas is held at zero
   opacity until the whole 5-chunk radius has data AND geometry, then fades up. Chunks popping in
   one by one behind the title is the single most "unfinished" thing a voxel game can show, and
   the fill takes well under a second anyway — this just makes sure none of it is on screen. */
let _menuVeil = false, _menuVeilT = 0;
/* The boot cover is removed from the DOM once faded, so it can never sit over the game as an
   invisible layer. Idempotent — every reveal path calls it, and only the first one does work. */
function liftBootCover() {
  const el = document.getElementById('bootCover');
  if (!el || el.classList.contains('gone')) return;
  el.classList.add('gone');
  setTimeout(() => el.remove(), 600);
}
function startMenuBackdrop() {
  menuScene = true;
  _menuVeil = true;
  _menuVeilT = performance.now();
  canvas.style.opacity = '0';
  overlay.classList.add('veiled');          // menu waits for the panorama, then eases in with it
  clearDoors();
  clearBeds();
  clearChests();
  resetWorld('voxicraft');
  viewDist = 5; applyViewDist(false);       // backdrop only — never persist this short distance
  worldTime = 0.15;                         // late morning: bright, long shadows
  player.pos.set(MENU_SPOT.x, MENU_SPOT.y, MENU_SPOT.z);
  player.spawned = true;                    // skip the spawn snap entirely
  player.canFly = true; player.flying = true; player.vy = 0;
  player.pitch = MENU_SPOT.pitch;
  setHudVisible(false);
}

// Starting a world no longer waits for pointer lock: it always starts the game, and pointer
// lock is acquired opportunistically afterwards. Embedded contexts (like an app preview pane)
// can deny pointer lock outright — in which case the game still runs with gamepad + keyboard,
// and clicking the view retries the lock.
