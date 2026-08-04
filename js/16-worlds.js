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
const menuExtras  = document.getElementById('menuExtras');
const menuSub     = document.getElementById('menuSub');
const worldListEl = document.getElementById('worldList');
const worldNameIn = document.getElementById('worldName');
const newModeSel  = document.getElementById('newModeSel');
const tickInput   = document.getElementById('tickInput');
const modeLabel   = document.getElementById('modeLabel');

const worldLoadingEl    = document.getElementById('worldLoading');
const worldLoadingNameEl = document.getElementById('worldLoadingName');
let _loadingWorld = false;   // true while initial chunks are generating; hides loading screen when done

let WORLDS = (() => { try { const a = JSON.parse(localStorage.getItem('vc_worlds')); return Array.isArray(a) ? a : []; } catch { return []; } })();
let currentWorld = null;
let pendingRestore = null;                  // saved player+drops, applied once the chunk under them loads

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
    time: worldTime, worldDay, curMode: currentInvMode,
    survHot: survStash.hot, survInv: survStash.inv, survInv2: survStash.inv2,
    player: { pos: [player.pos.x, player.pos.y, player.pos.z], yaw: player.yaw, pitch: player.pitch,
              hp: player.hp, food: player.food, saturation: player.saturation, flying: player.flying,
              hotSel: hotbarSel,
              spawnPos: player.spawnPos ? player.spawnPos.toArray() : null },
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
  const vd = clampi(+distInput.value || 10, 4, 32);      // leave the 4-chunk panorama distance
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
  resetWorld(w.seed);
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
  glowLights.clear();                        // re-derive glowstone lights from the saved edits
  clearDoors();                              // + rebuild door meshes from saved bottom halves
  clearBeds();                               // and bed meshes from saved FOOT cells
  clearChests();
  if (data && Array.isArray(data.chests)) restoreChests(data.chests);   // contents before meshes
  for (const [k, m] of editStore) {
    const cxz = k.split(','), gx = cxz[0] * 16, gz = cxz[1] * 16;
    for (const [i, v] of m) {
      if (blockLightOf(v) > 0)
        glowLights.add((gx + (i & 15)) + ',' + (i >> 8) + ',' + (gz + ((i >> 4) & 15)));
      if ((v & 255) === B.DOOR && !((v >> 8) & 8))
        registerDoor(gx + (i & 15), i >> 8, gz + ((i >> 4) & 15), (v >> 8) & 3, ((v >> 8) & 4) !== 0);
      if ((v & 255) === B.BED && !((v >> 8) & 8))     // only the foot half owns a mesh
        registerBed(gx + (i & 15), i >> 8, gz + ((i >> 4) & 15), (v >> 8) & 3);
      if ((v & 255) === B.CHEST)
        registerChest(gx + (i & 15), i >> 8, gz + ((i >> 4) & 15), (v >> 8) & 3);
    }
  }
  // only restore survival inventory when the world has a real player save (proves they played it).
  // Any other case (fresh world, ID collision, corrupt/missing data) starts empty.
  const _hasSurvSave = !!(data && data.player && Array.isArray(data.player.pos));
  survStash = {
    hot: _hasSurvSave ? _validArr(data.survHot, 9) : new Array(9).fill(null),
    inv: _hasSurvSave ? _validArr(data.survInv, 27) : new Array(27).fill(null),
    inv2: _hasSurvSave ? _validArr(data.survInv2, 27) : new Array(27).fill(null),   // future backpack
  };
  if (data && typeof data.time === 'number') { worldTime = ((data.time % 1) + 1) % 1; worldDay = typeof data.worldDay === 'number' ? data.worldDay : 0; }
  else { worldTime = 1 / 24; worldDay = 0; }  // new world: start at 07:00, day 0
  // survival-created worlds are locked to survival; creative worlds resume their last mode
  modeSel.value = w.mode === 'survival' ? 'survival' : ((data && data.curMode) || w.mode);
  loadInventoryForMode(modeSel.value === 'survival' ? 'survival' : 'creative');
  hotbarSel = 0; buildHotbar(); buildInventory();
  pendingRestore = (data && data.player && Array.isArray(data.player.pos))
    ? { ...data.player, drops: data.drops, entities: data.entities } : null;
  if (pendingRestore) player.pos.set(pendingRestore.pos[0], 96, pendingRestore.pos[2]); // stream the right chunks
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
  for (const w of sorted) {
    const ts = w.lastPlayed || w.created;
    const d = ts ? new Date(ts) : null;
    const dateStr = d ? d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '—';
    const timeStr = d ? d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' }) : '';
    const row = document.createElement('div');
    row.className = 'wrow';
    row.innerHTML =
      `<div class="wthumb"><span class="wthumb-ph">◻</span></div>` +
      `<div class="wbody">` +
        `<div class="winfo">` +
          `<b>${escapeHtml(w.name)}</b>` +
          `<span class="wseed">seed ${escapeHtml(w.seed)} &middot; ${w.mode}</span>` +
          `<span class="wseed">created v${escapeHtml(w.createdVersion || 'pre-0.443')} &middot; last v${escapeHtml(w.lastVersion || w.createdVersion || 'pre-0.443')}</span>` +
          `<span class="wtime"><span class="wtime-label">last played</span><br>${dateStr} ${timeStr}</span>` +
        `</div>` +
      `</div>` +
      `<div class="wbtns"></div>`;
    // async load thumbnail from IDB
    const thumbEl = row.querySelector('.wthumb');
    idbGet('thumb:' + w.id).then(url => {
      if (!url) return;
      const img = document.createElement('img');
      img.src = url;
      thumbEl.innerHTML = '';
      thumbEl.appendChild(img);
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

let menuScreen = 'home';                    // 'home' | 'worlds' | 'create' | 'pause'
function refreshMenu(screen) {
  if (screen) menuScreen = screen;
  if (currentWorld) menuScreen = 'pause';
  else if (menuScreen === 'pause') menuScreen = 'home';
  const s = menuScreen;
  menuHome.style.display   = s === 'home'   ? 'block' : 'none';
  menuWorlds.style.display = s === 'worlds' ? 'block' : 'none';
  menuCreate.style.display = s === 'create' ? 'block' : 'none';
  menuPause.style.display  = s === 'pause'  ? 'block' : 'none';
  menuExtras.style.display = (s === 'home' || s === 'pause') ? 'block' : 'none';
  // the gamemode dropdown only exists inside worlds CREATED as creative
  modeLabel.style.display  = (s === 'pause' && currentWorld && currentWorld.mode === 'creative') ? 'flex' : 'none';
  menuSub.textContent = s === 'pause'  ? `${currentWorld.name} — paused (auto-saves)`
                      : s === 'worlds' ? 'select a world'
                      : s === 'create' ? 'create a new world'
                      : 'infinite voxel world · greedy-meshed · worker-generated';
  if (s === 'worlds') renderWorldList();
}

/* Minecraft-style title panorama: a fixed scenic overlook on the dedicated "voxicraft" seed
   (forest hilltop with mountains and water in view), rendered at view distance 4 with the
   camera slowly circling. */
const MENU_SPOT = { x: -23.5, y: 176, z: 8.5, pitch: -0.36 };   // above the raised (sea-level 99) terrain
let menuScene = false;
function setHudVisible(v) {
  for (const id of ['hud', 'hotbar', 'crosshair'])
    document.getElementById(id).style.display = v ? '' : 'none';
}
function startMenuBackdrop() {
  menuScene = true;
  clearDoors();
  clearBeds();
  clearChests();
  resetWorld('voxicraft');
  viewDist = 4; applyViewDist(false);       // backdrop only — never persist the 4-chunk distance
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
