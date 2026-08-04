'use strict';
/* voxiCraft — settings, pointer lock, keyboard/mouse/gamepad */

const modeSel = document.getElementById('modeSel');
const fpsSel = document.getElementById('fpsSel');
const distInput = document.getElementById('distInput');
const sensInput = document.getElementById('sensInput');
const shadowSel = document.getElementById('shadowSel');
let playing = false;
let lockTimer = 0, lockTries = 0;

function setPlaying(on) {
  if (on && !currentWorld) { refreshMenu(); return; }   // no world selected — stay on the title
  if (on && !playing) applySettings();      // closing the menu ALWAYS applies the settings,
  playing = on;                             // no matter how it was closed (Play/Esc/Start)
  overlay.style.display = on ? 'none' : 'flex';
  if (!on) {
    if (currentWorld) saveWorld();          // pausing also saves — cheap insurance
    refreshMenu();
    toggleInventory(false);                 // pause menu supersedes the inventory
    clearTimeout(lockTimer);
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
function tryPointerLock() {
  clearTimeout(lockTimer);
  if (!playing || document.pointerLockElement === canvas) return;
  if (lockTries >= 3) {
    toast('mouse look blocked here — gamepad & keys work; click the view to retry');
    return;
  }
  lockTries++;
  let p = null;
  try { p = canvas.requestPointerLock(); } catch { scheduleLockRetry(); }
  if (p && p.catch) p.catch(scheduleLockRetry);
}
// Chrome refuses re-locks for ~1.3s after ESC — wait out the cooldown and try again
function scheduleLockRetry() { lockTimer = setTimeout(tryPointerLock, 1400); }
document.addEventListener('pointerlockerror', () => { if (playing) scheduleLockRetry(); });

function applySettings() {
  // survival-created worlds can never leave survival
  if (currentWorld && currentWorld.mode === 'survival') modeSel.value = 'survival';
  const wasCreative = player.canFly;
  player.canFly = modeSel.value !== 'survival';        // survival: flying disabled entirely
  if (!player.canFly) {
    player.flying = false;
    // fresh vitals when entering survival, and skip fall-damage from the current arc
    if (wasCreative) { player.hp = MAX_HP; player.food = MAX_FOOD; player.fallStart = null; player.vy = 0; }
  }
  // swap inventory sets when the mode changes. Survival persists via saveHotbar/saveInv (they
  // gate on currentInvMode so entering creative can never clobber survival storage).
  const newMode = modeSel.value === 'survival' ? 'survival' : 'creative';
  if (newMode !== currentInvMode) {
    loadInventoryForMode(newMode);
    hotbarSel = 0;
    // MUST rebuild the DOM here — updateHotbar only re-toggles the selected-slot class and
    // would leave the previous mode's icons on screen as ghosts even though HOTBAR is empty.
    buildHotbar();
    if (invOpen) buildInventory();
    flashBlockName();
  }
  if (player.canFly) clearDrops();          // creative has no drops; wipe any survival leftovers
  fpsLimit = +fpsSel.value || 0;
  localStorage.setItem('vc_fps', fpsSel.value);
  const sv = clampi(+sensInput.value || 100, 10, 400);
  sensInput.value = sv;
  sens = sv / 100;
  localStorage.setItem('vc_sens', sv);
  const d = clampi(+distInput.value || viewDist, 4, 32);
  distInput.value = d;
  if (d !== viewDist) { viewDist = d; applyViewDist(); rebuildQueues(); }
  const sr = parseInt(shadowSel.value);
  if (sr !== shadowR) { shadowR = sr; applyShadowDist(); }
}
document.getElementById('worldsBtn').addEventListener('click', () => refreshMenu('worlds'));
document.getElementById('newWorldBtn').addEventListener('click', () => refreshMenu('create'));
document.getElementById('worldsBackBtn').addEventListener('click', () => refreshMenu('home'));
document.getElementById('createBackBtn').addEventListener('click', () => refreshMenu('worlds'));
document.getElementById('createBtn').addEventListener('click', async () => {
  const name = uniqueWorldName(worldNameIn.value);
  const seed = seedInput.value.replace(/[^a-z0-9]/gi, '')
            || Math.random().toString(36).slice(2, 10).toUpperCase();
  const w = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              name, seed, mode: newModeSel.value === 'creative' ? 'creative' : 'survival',
              tickSpeed: clampi(+tickInput.value || 3, 0, 20),   // simulation speed for decay/flow/grass
              terrain: newTerrainSel.value === 'flat' ? 'flat' : 'default',   // fixed at creation
              createdVersion: GAME_VERSION, lastVersion: GAME_VERSION,
              created: Date.now(), lastPlayed: Date.now() };
  WORLDS.unshift(w);
  persistWorlds();
  await loadWorld(w);
  worldNameIn.value = ''; seedInput.value = '';
  setPlaying(true);
  lockTries = 0;
  tryPointerLock();
});
document.getElementById('resumeBtn').addEventListener('click', () => {
  setPlaying(true);
  lockTries = 0;
  tryPointerLock();
});
document.getElementById('quitBtn').addEventListener('click', () => {
  saveWorld();
  toast('world saved');
  currentWorld = null;
  pendingRestore = null;
  startMenuBackdrop();                      // back to the rotating title panorama
  refreshMenu('home');
});
document.getElementById('fsBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
canvas.addEventListener('click', () => {
  if (playing && !pointerLocked && !invOpen) { lockTries = 0; tryPointerLock(); }
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (pointerLocked) clearTimeout(lockTimer);
  else {
    for (const k in keys) keys[k] = false;
    mouseBreak = mousePlace = false;
    if (playing && !invOpen) setPlaying(false); // ESC while mouse-locked -> pause menu
  }                                             // (inventory releases the lock on purpose)
});
document.addEventListener('mousemove', (e) => {
  if (!pointerLocked || player.dead) return;
  player.yaw   -= e.movementX * 0.0022 * sens;
  player.pitch -= e.movementY * 0.0022 * sens;
  player.pitch = Math.max(-1.5697, Math.min(1.5697, player.pitch));
});
document.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'F1') { e.preventDefault(); toggleFullscreen(); return; }
  if (e.code === 'F2') { e.preventDefault(); if (playing) cycleCameraView(); return; }
  // block all browser defaults while game has input focus; F1 handled above, Escape handled below
  if (playing && e.code !== 'Escape') e.preventDefault();
  if (e.code === 'Backquote' && playing && currentWorld) {  // ~ toggles pause without releasing mouse
    if (invOpen) toggleInventory(false);
    setPlaying(!playing);
    return;
  }
  if (e.code === 'Escape') {                // inventory first, then menu toggle / panel back
    if (invOpen) toggleInventory(false);
    else if (playing && !pointerLocked) setPlaying(false);
    else if (!playing && !currentWorld && menuScreen === 'create') refreshMenu('worlds');
    else if (!playing && !currentWorld && menuScreen === 'worlds') refreshMenu('home');
    else if (!playing) setPlaying(true);
    return;
  }
  if (!playing) return;
  if (e.code === 'KeyE' && !e.repeat) { toggleInventory(); return; }
  if (e.code === 'KeyY' && !e.repeat && !invOpen) { dropFromHotbar(e.shiftKey ? 'stack' : 1); return; }
  if (e.code === 'Space' && !e.repeat && !invOpen) jumpTap();
  if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && !e.repeat && !invOpen) player.fast = !player.fast;
  if (!invOpen && e.code.startsWith('Digit')) {
    const n = +e.code.slice(5);
    if (n >= 1 && n <= HOTBAR.length) hotbarSel = n - 1, updateHotbar();
  }
  if (e.code === 'BracketLeft')  { viewDist = clampi(viewDist - 1, 4, 32); distInput.value = viewDist; applyViewDist(); rebuildQueues(); }
  if (e.code === 'BracketRight') { viewDist = clampi(viewDist + 1, 4, 32); distInput.value = viewDist; applyViewDist(); rebuildQueues(); }
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });
// ctrl+wheel is the browser page-zoom gesture; swallow it so scrolling near the game never
// rescales the whole page. Needs passive:false or preventDefault is ignored.
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });
document.addEventListener('wheel', (e) => {
  if (!playing || invOpen) return;
  hotbarSel = (hotbarSel + (e.deltaY > 0 ? 1 : -1) + HOTBAR.length) % HOTBAR.length;
  updateHotbar();
});
// suppress the browser context menu everywhere while in-game (incl. fullscreen + inventory UI)
document.addEventListener('contextmenu', (e) => {
  if (playing || document.fullscreenElement) e.preventDefault();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// unified break/place hold-to-repeat (mouse buttons and gamepad triggers feed the same state)
const act = { break: false, place: false, lastBreak: 0, lastPlace: 0 };
let mouseBreak = false, mousePlace = false;
document.addEventListener('mousedown', (e) => {
  if (!pointerLocked) return;
  if (e.button === 0) mouseBreak = true;
  if (e.button === 2) mousePlace = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseBreak = false;
  if (e.button === 2) mousePlace = false;
});

// inventory mouse drag & drop — coordinate-based (works over the pointer-events:none hotbar)
document.addEventListener('mousemove', (e) => {
  if (!invOpen) return;
  invCursor.mode = 'mouse'; invCursor.x = e.clientX; invCursor.y = e.clientY;
});
// click-carry model (no hold needed):
//   LMB          pick up all / place all       Ctrl+LMB   pick up 1
//   RMB          pick up half / place 1        Ctrl+RMB   move 1 to the other grid
//   Shift+LMB    quick-move; keep held down and sweep over slots to move them all
let shiftSweep = false;
document.addEventListener('mousedown', (e) => {
  if (!invOpen || (e.button !== 0 && e.button !== 2)) return;
  invCursor.mode = 'mouse'; invCursor.x = e.clientX; invCursor.y = e.clientY;
  const s = slotAtPoint(e.clientX, e.clientY);
  if (!s) return;
  e.preventDefault();
  if (e.button === 0) {
    if (e.shiftKey && !dragHeld) { instantTransfer(s.region, s.i); shiftSweep = true; return; }
    if (dragHeld) placeInto(s.region, s.i, 'all');
    else pickUp(s.region, s.i, e.ctrlKey ? 1 : 'all');
  } else {
    if (e.ctrlKey && !dragHeld) { transferOne(s.region, s.i); return; }
    if (dragHeld) placeInto(s.region, s.i, 1);
    else pickUp(s.region, s.i, 'half');
  }
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) shiftSweep = false; });
// middle-click sorts whichever grid the cursor is over (hotbar / inventory / chest)
document.addEventListener('mousedown', (e) => {
  if (!invOpen || e.button !== 1 || dragHeld) return;
  e.preventDefault();                                // also kills the browser autoscroll cursor
  const s = slotAtPoint(e.clientX, e.clientY);
  if (s) sortRegion(s.region);
});
document.addEventListener('auxclick', (e) => { if (invOpen && e.button === 1) e.preventDefault(); });
document.addEventListener('mousemove', (e) => {   // shift+LMB sweep: quick-move everything hovered
  if (!invOpen || !shiftSweep || !e.shiftKey) return;
  const s = slotAtPoint(e.clientX, e.clientY);
  if (s) instantTransfer(s.region, s.i);
});

/* ---------- gamepad ---------- */
const pad = {
  deadzone: 0.16, lookX: 0, lookY: 0,       // smoothed look
  prev: [], radialOpen: false, radialSel: -1,
};
function padAxis(v) {
  const s = Math.abs(v) < pad.deadzone ? 0 : (Math.abs(v) - pad.deadzone) / (1 - pad.deadzone) * Math.sign(v);
  return s * Math.abs(s);                   // quadratic response for fine aiming
}
function getPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const g of pads) if (g && g.connected) return g;
  return null;
}
// inventory gamepad control: left stick drives the virtual cursor; A drags (hold), Y quick-moves
function invGamepad(g, dt, btn, edge) {
  const mx = padAxis(g.axes[0] || 0), my = padAxis(g.axes[1] || 0);
  pad.invStick = Math.hypot(mx, my);              // fed to the magnet so it yields while moving
  if (pad.invStick > 0.001) {
    invCursor.mode = 'pad';
    invCursor.x += mx * 900 * dt;
    invCursor.y += my * 900 * dt;
  }
  // right stick scrolls the crafting recipe list (when present)
  const ry = padAxis(g.axes[3] || 0);
  const clist = document.getElementById('craftList');
  if (clist && Math.abs(ry) > 0.01) clist.scrollTop += ry * 700 * dt;
  const hov = hoveredSlot();
  if (edge(0) && hov) beginDrag(hov.region, hov.i);              // A press = pick up
  if (edge(0) && !hov) {                                         // A on a craft button = craft
    const el = document.elementFromPoint(invCursor.x, invCursor.y);
    const b = el && el.closest ? el.closest('.cbtn') : null;
    if (b) b.click();
  }
  if (pad.prev[0] && !btn(0) && dragHeld) {                      // A release = drop
    if (hov) endDrag(hov.region, hov.i); else cancelDrag();
  }
  if (edge(3) && hov) instantTransfer(hov.region, hov.i);       // Y = quick-move
  // LB (4) / RB (5) cycle crafting-category tabs while inventory panel is open
  if (document.getElementById('craftTabs')) {
    if (edge(4)) cycleCraftCategory(-1);
    if (edge(5)) cycleCraftCategory(+1);
  }
}
function pollGamepad(dt) {
  const g = getPad();
  if (!g) {                                 // disconnected: release held pad actions
    pad.radialOpen = false;
    act.padBreak = act.padPlace = false;
    radialEl.style.display = 'none';
    return { mx: 0, mz: 0, up: false, dn: false };
  }
  const btn = (i) => !!(g.buttons[i] && g.buttons[i].pressed);
  const val = (i) => (g.buttons[i] ? g.buttons[i].value : 0);
  const edge = (i) => btn(i) && !pad.prev[i];

  // death screen: A respawns, every other pad input is swallowed
  if (player.dead) {
    if (edge(0)) respawnPlayer();
    pad.prev = g.buttons.map(b => b.pressed);
    act.padBreak = act.padPlace = false;
    return { mx: 0, mz: 0, up: false, dn: false };
  }

  // Start (9) toggles the menu (or closes the inventory); Back (8) fullscreen; B (1) inventory
  if (edge(9)) { if (invOpen) toggleInventory(false); else setPlaying(!playing); }
  if (edge(8)) toggleFullscreen();
  if (edge(1) && playing) toggleInventory();      // B (East) opens / closes the inventory
  if (invOpen) {                                   // inventory owns the pad: virtual cursor only
    invGamepad(g, dt, btn, edge);
    pad.prev = g.buttons.map(b => b.pressed);
    pad.radialOpen = false;
    act.padBreak = act.padPlace = false;
    radialEl.style.display = 'none';
    return { mx: 0, mz: 0, up: false, dn: false };
  }
  if (!playing) {
    pad.prev = g.buttons.map(b => b.pressed);
    pad.radialOpen = false;
    act.padBreak = act.padPlace = false;
    radialEl.style.display = 'none';
    return { mx: 0, mz: 0, up: false, dn: false };
  }

  // radial hotbar picker: hold North/Y (3), aim with right stick, release to confirm
  const openRadial = btn(3);
  if (openRadial) {
    const rx = padAxis(g.axes[2] || 0), ry = padAxis(g.axes[3] || 0);
    if (Math.hypot(rx, ry) > 0.4) {
      const ang = Math.atan2(rx, -ry);                       // 0 = up, clockwise
      const step = (Math.PI * 2) / HOTBAR.length;
      pad.radialSel = ((Math.round(ang / step) % HOTBAR.length) + HOTBAR.length) % HOTBAR.length;
    }
    if (!pad.radialOpen) pad.radialSel = hotbarSel;
    pad.radialOpen = true;
    drawRadial();
  } else {
    if (pad.radialOpen && pad.radialSel >= 0) { hotbarSel = pad.radialSel; updateHotbar(); }
    pad.radialOpen = false;
  }
  radialEl.style.display = pad.radialOpen ? 'block' : 'none';

  // look (right stick) — smoothed, disabled while the radial is open
  if (!pad.radialOpen) {
    const tx = padAxis(g.axes[2] || 0), ty = padAxis(g.axes[3] || 0);
    const k = Math.min(1, dt * 14);
    pad.lookX += (tx - pad.lookX) * k;
    pad.lookY += (ty - pad.lookY) * k;
    player.yaw   -= pad.lookX * 3.2 * sens * dt;
    player.pitch -= pad.lookY * 2.4 * sens * dt;
    player.pitch = Math.max(-1.5697, Math.min(1.5697, player.pitch));
  }

  // bumpers cycle the hotbar (also work while the radial is open, as a fallback)
  if (edge(4)) { hotbarSel = (hotbarSel + HOTBAR.length - 1) % HOTBAR.length; updateHotbar(); }
  if (edge(5)) { hotbarSel = (hotbarSel + 1) % HOTBAR.length; updateHotbar(); }

  // double-tap A toggles flying (same rule as double-tap Space); L3 toggles sprint
  if (edge(0)) jumpTap();
  if (edge(10)) player.fast = !player.fast;

  // triggers: RT (7) break, LT (6) place — merged into the shared action state below
  act.padBreak = !pad.radialOpen && val(7) > 0.5;
  act.padPlace = !pad.radialOpen && val(6) > 0.5;

  const out = {
    mx: padAxis(g.axes[0] || 0),
    mz: padAxis(g.axes[1] || 0),
    up: btn(0),                              // South / A
    dn: btn(2),                              // West / X — descend & sneak
  };
  pad.prev = g.buttons.map(b => b.pressed);
  return out;
}

