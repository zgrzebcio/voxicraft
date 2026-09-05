'use strict';
/* voxiCraft — settings, pointer lock, keyboard/mouse/gamepad */

const modeSel = document.getElementById('modeSel');
const fpsSel = document.getElementById('fpsSel');
const distInput = document.getElementById('distInput');
const simInput  = document.getElementById('simInput');
const sensInput = document.getElementById('sensInput');
const shadowSel = document.getElementById('shadowSel');
const splitDirSel = document.getElementById('splitDirSel');
let playing = false;
let lockTimer = 0, lockTries = 0;
/* Which device the player last actually used. Drives the key glyph in the on-screen interact
   prompt, so plugging in a pad mid-game relabels it without a reload. Keyboard/mouse claim it on
   real input only; pollGamepad claims it when a button or stick genuinely moves, never merely
   because a pad is connected — an idle controller must not steal the label from the keyboard. */
let lastInputDevice = 'kbd';

function setPlaying(on) {
  if (on && !currentWorld) { refreshMenu(); return; }   // no world selected — stay on the title
  if (on && !playing) applySettings();      // closing the menu ALWAYS applies the settings,
  playing = on;                             // no matter how it was closed (Play/Esc/Start)
  overlay.style.display = on ? 'none' : 'flex';
  if (!on) {
    if (currentWorld) saveWorld();          // pausing also saves — cheap insurance
    refreshMenu();
    // the pause menu is for EVERYONE, so it supersedes every seat's inventory, not just this one
    forEachPlayerSlot(() => toggleInventory(false));
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
  // gamemode is a property of the WORLD, so it lands on every split-screen player at once
  const creative = modeSel.value !== 'survival';
  for (const p of PLAYERS) {
    const wasCreative = p.canFly;
    p.canFly = creative;                             // survival: flying disabled entirely
    if (!creative) {
      p.flying = false;
      // fresh vitals when entering survival, and skip fall-damage from the current arc
      if (wasCreative) { p.hp = MAX_HP; p.food = MAX_FOOD; p.fallStart = null; p.vy = 0; }
    }
  }
  // swap inventory sets when the mode changes. Survival persists via saveHotbar/saveInv (they
  // gate on currentInvMode so entering creative can never clobber survival storage).
  const newMode = modeSel.value === 'survival' ? 'survival' : 'creative';
  if (newMode !== currentInvMode) {
    // ...and each player carries their OWN stash, so the swap runs once per player context
    forEachPlayerSlot(() => {
      loadInventoryForMode(newMode);
      hotbarSel = 0;
      // MUST rebuild the DOM here — updateHotbar only re-toggles the selected-slot class and
      // would leave the previous mode's icons on screen as ghosts even though HOTBAR is empty.
      buildHotbar();
      flashBlockName();
    });
    if (invOpen) buildInventory();
  }
  if (creative) clearDrops();               // creative has no drops; wipe any survival leftovers
  fpsLimit = +fpsSel.value || 0;
  localStorage.setItem('vc_fps', fpsSel.value);
  const sv = clampi(+sensInput.value || 100, 10, 400);
  sensInput.value = sv;
  sens = sv / 100;
  localStorage.setItem('vc_sens', sv);
  const d = clampi(+distInput.value || viewDist, 4, 32);
  distInput.value = d;
  if (d !== viewDist) { viewDist = d; applyViewDist(); rebuildQueues(); }
  // simulation radius: nothing to rebuild — every gated system reads simDist() per tick
  const sd = clampi(+simInput.value || simRadius, SIM_DIST_MIN, SIM_DIST_MAX);
  simInput.value = sd;
  if (sd !== simRadius) { simRadius = sd; localStorage.setItem('vc_sim', sd); }
  const sr = parseInt(shadowSel.value);
  if (sr !== shadowR) { shadowR = sr; applyShadowDist(); }
  applySplitDir();
}
/* Split screen membership is per-world and driven by the pause-menu roster (see 37-profiles.js).
   How the window is DIVIDED is a display preference like the others. It also applies on CHANGE,
   not only when the menu closes, so you can see the layout you picked while picking it. */
function applySplitDir() {
  const sdir = splitDirSel.value === 'v' ? 'v' : 'h';
  if (sdir === splitDir) return;
  splitDir = sdir;
  localStorage.setItem('vc_splitdir', sdir);
  relayoutSplitScreen();
}
splitDirSel.addEventListener('change', applySplitDir);
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
              // split screen is fixed at creation too: the save keeps a roster of profiles, and a
              // world that never had one should not sprout half-filled player records later
              split: !!newSplitChk.checked,
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
  pendingWorldRestore = null;
  setPlayerCount(1);                        // the roster belongs to the world, not to the title screen
  startMenuBackdrop();                      // back to the rotating title panorama
  refreshMenu('home');
});
document.getElementById('fsBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
/* Mute toggles. #menuExtras hosts them, so the same pair shows on the title screen and on the
   pause menu without a second copy of the markup. The glyph IS the state: struck-through = off. */
{
  const musicBtn = document.getElementById('musicBtn'), sfxBtn = document.getElementById('sfxBtn');
  const paint = () => {
    musicBtn.textContent = musicMuted ? '♪̸' : '♪';
    musicBtn.title = musicMuted ? 'Music off — click to unmute' : 'Music on — click to mute';
    musicBtn.style.opacity = musicMuted ? '0.45' : '1';
    sfxBtn.textContent = sfxMuted ? '\u{1F507}' : '\u{1F50A}';
    sfxBtn.title = sfxMuted ? 'Sound effects off — click to unmute' : 'Sound effects on — click to mute';
    sfxBtn.style.opacity = sfxMuted ? '0.45' : '1';
  };
  musicBtn.addEventListener('click', (e) => { e.stopPropagation(); setMusicMuted(!musicMuted); paint(); });
  sfxBtn.addEventListener('click',   (e) => { e.stopPropagation(); setSfxMuted(!sfxMuted); paint(); });
  paint();
}
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
  if (e.movementX || e.movementY) lastInputDevice = 'kbd';
  player.yaw   -= e.movementX * 0.0022 * sens;
  player.pitch -= e.movementY * 0.0022 * sens;
  player.pitch = Math.max(-1.5697, Math.min(1.5697, player.pitch));
});
document.addEventListener('keydown', (e) => {
  /* Rebinding a seat: the keypress IS the answer, so it never reaches the game. Escape cancels
     rather than binding — nobody means "my input device is the escape key". */
  if (typeof inputCapture !== 'undefined' && inputCapture) {
    e.preventDefault();
    if (e.code === 'Escape') cancelInputCapture();
    else if (!e.repeat) inputCaptureKey();
    return;
  }
  keys[e.code] = true;
  lastInputDevice = 'kbd';
  if (e.code === 'F1') { e.preventDefault(); toggleFullscreen(); return; }
  if (e.code === 'F2') { e.preventDefault(); if (playing) cycleCameraView(); return; }
  if (e.code === 'F3') { e.preventDefault(); toggleDebugHud(0); return; }   // keyboard is seat one
  /* Tab is the inventory key. It has to be handled BEFORE the `!playing` guard below so it also
     closes an open inventory, and it must preventDefault in both directions: left to the browser,
     Tab walks focus out of the canvas onto page chrome, and once focus lands there keystrokes
     stop reaching the game entirely. Menus keep normal Tab navigation. */
  if (e.code === 'Tab' && (playing || invOpen)) {
    e.preventDefault();
    if (!e.repeat) toggleInventory();
    return;
  }
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
    else if (!playing && menuScreen === 'profiles' && !needsFirstProfile())
      refreshMenu(currentWorld ? 'pause' : 'home');
    else if (!playing && !currentWorld && menuScreen === 'create') refreshMenu('worlds');
    else if (!playing && !currentWorld && menuScreen === 'worlds') refreshMenu('home');
    else if (!playing) setPlaying(true);
    return;
  }
  if (!playing) return;
  if (e.code === 'KeyY' && !e.repeat && !invOpen) { dropFromHotbar(e.shiftKey ? 'stack' : 1); return; }
  // KeyE (bush pickup) is HELD, not tapped — driven from the frame loop off `keys`, not here
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
var act = { break: false, place: false, lastBreak: 0, lastPlace: 0, padPick: false };
var mouseBreak = false, mousePlace = false;
document.addEventListener('mousedown', (e) => {
  if (!pointerLocked) return;
  lastInputDevice = 'kbd';
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
var pad = {
  deadzone: 0.16, lookX: 0, lookY: 0,       // smoothed look
  prev: [], radialOpen: false, radialSel: -1,
};
function padAxis(v) {
  const s = Math.abs(v) < pad.deadzone ? 0 : (Math.abs(v) - pad.deadzone) / (1 - pad.deadzone) * Math.sign(v);
  return s * Math.abs(s);                   // quadratic response for fine aiming
}
/* The pad belonging to whichever player is currently installed. Solo, that is simply the first
   connected pad (unchanged behaviour); in split screen player one keeps keyboard and mouse and
   the pads go to players two upward in connection order — see padForSlot in 36-splitscreen.js. */
function getPad() {
  if (typeof padForSlot === 'function') return padForSlot(activePlayerSlot());
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
    const cs = invScale();                 // a quarter-screen panel gets a quarter-speed cursor
    invCursor.x += mx * 900 * cs * dt;
    invCursor.y += my * 900 * cs * dt;
  }
  /* Right stick scrolls whichever list is under it: the crafting recipes in survival, the
     creative block palette in creative. Both are open at once for nobody, so a straight
     either/or is enough — and the palette had no pad scroll at all before 0.704. */
  const ry = padAxis(g.axes[3] || 0);
  if (Math.abs(ry) > 0.01) {
    const list = invPanel('craftList') || document.querySelector('#inv .invScroll');
    if (list) list.scrollTop += ry * 700 * dt;
  }
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
  if (invPanel('craftTabs')) {
    if (edge(4)) cycleCraftCategory(-1);
    if (edge(5)) cycleCraftCategory(+1);
  }
}
function pollGamepad(dt) {
  const g = getPad();
  if (!g) {                                 // disconnected: release held pad actions
    pad.radialOpen = false;
    act.padBreak = act.padPlace = act.padPick = false;
    radialEl.style.display = 'none';
    return { mx: 0, mz: 0, up: false, dn: false };
  }
  const btn = (i) => !!(g.buttons[i] && g.buttons[i].pressed);
  const val = (i) => (g.buttons[i] ? g.buttons[i].value : 0);
  const edge = (i) => btn(i) && !pad.prev[i];
  /* While a seat is being rebound, the button press IS the answer — it must not also open a menu
     or swing a pickaxe. `prev` is still updated so releasing it afterwards can't fire a stale edge. */
  if (typeof inputCapture !== 'undefined' && inputCapture) {
    pad.prev = g.buttons.map(b => b.pressed);
    act.padBreak = act.padPlace = act.padPick = false;
    return { mx: 0, mz: 0, up: false, dn: false };
  }
  // real pad activity (not just "a pad is plugged in") takes over the prompt's key glyph
  if (g.buttons.some(b => b.pressed || b.value > 0.5) ||
      g.axes.some(a => Math.abs(a) > 0.35)) lastInputDevice = 'pad';

  // death screen: A respawns, every other pad input is swallowed
  if (player.dead) {
    if (edge(0)) respawnPlayer();
    pad.prev = g.buttons.map(b => b.pressed);
    act.padBreak = act.padPlace = act.padPick = false;
    return { mx: 0, mz: 0, up: false, dn: false };
  }

  // Start (9) toggles the menu (or closes the inventory); Back (8) fullscreen; B (1) inventory
  if (edge(9)) { if (invOpen) toggleInventory(false); else setPlaying(!playing); }
  if (edge(8)) toggleFullscreen();                // Back / Share
  if (edge(12)) toggleDebugHud(activePlayerSlot());   // D-pad Up hides this seat's debug text
  if (edge(14) && playing) cycleCameraView();         // D-pad Left cycles perspective (F2's twin)
  /* D-pad Down drops one of the held item — the pad's twin of Y. Deliberately no stack modifier:
     every button that could serve as one already means something while playing (the triggers mine
     and place, the bumpers cycle the hotbar), and a mis-modified drop throws away a whole stack. */
  if (edge(13) && playing && !invOpen) dropFromHotbar(1);
  /* B (East) is the "back out of this" button: it closes the pause menu if that is what is in
     front of you, and otherwise opens or closes the inventory. setPlaying declines when there is
     no world loaded, so on the title screen it does nothing. */
  if (edge(1)) { if (!playing) setPlaying(true); else toggleInventory(); }
  if (invOpen) {                                   // inventory owns the pad: virtual cursor only
    invGamepad(g, dt, btn, edge);
    pad.prev = g.buttons.map(b => b.pressed);
    pad.radialOpen = false;
    act.padBreak = act.padPlace = act.padPick = false;
    radialEl.style.display = 'none';
    return { mx: 0, mz: 0, up: false, dn: false };
  }
  if (!playing) {
    pad.prev = g.buttons.map(b => b.pressed);
    pad.radialOpen = false;
    act.padBreak = act.padPlace = act.padPick = false;
    radialEl.style.display = 'none';
    return { mx: 0, mz: 0, up: false, dn: false };
  }

  /* North (3) is bush pickup, the pad twin of E. It used to hold open a radial hotbar picker;
     that never got finished or maintained and the bumpers already cycle the hotbar, so the radial
     is retired. `pad.radialOpen` stays pinned false — the trigger handling below still reads it. */
  act.padPick = btn(3);                          // held, like the keyboard bind
  pad.radialOpen = false;
  radialEl.style.display = 'none';

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

