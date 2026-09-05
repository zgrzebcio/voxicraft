'use strict';
/* voxiCraft — hud, toast, hotbar DOM */

/* ================================================================================================
   HUD — fps, coords, selected block, hotbar, radial picker.
   ================================================================================================ */
var hudEl = document.getElementById('hud');
var blocknameEl = document.getElementById('blockname');
const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 3000);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() =>
    toast('fullscreen blocked — press F1 (gamepad presses don’t count as a user gesture)'));
}

/* ---- debug read-out (0.723) ----
   F3, or Back/Share on a pad, hides the corner text. It is PER SEAT: in split screen one player
   wanting a clean view should not strip the coordinates off everyone else's quarter. The choice is
   remembered per seat number, which is the useful default — whoever sits down there next gets the
   same view they left. */
let hudTextHidden = (() => {
  try { const a = JSON.parse(localStorage.getItem('vc_hudoff')); return Array.isArray(a) ? a : []; }
  catch { return []; }
})();
function toggleDebugHud(slot = (typeof activePlayerSlot === 'function' ? activePlayerSlot() : 0)) {
  hudTextHidden[slot] = !hudTextHidden[slot];
  localStorage.setItem('vc_hudoff', JSON.stringify(hudTextHidden));
  const el = PSTATE[slot] && PSTATE[slot].g.hudEl;
  if (el) { el.style.display = hudTextHidden[slot] ? 'none' : ''; if (!hudTextHidden[slot]) hudT = 1e9; }
}
const debugHudHidden = (slot) => !!hudTextHidden[slot];
var hotbarEl = document.getElementById('hotbar');
const radialEl = document.getElementById('radial');
const radialCtx = radialEl.getContext('2d');

/* ---- interact prompt under the crosshair ----
   Shown only while a bush pickup is actually available, and labelled with the key on whichever
   device you last touched — swap from keyboard to pad mid-game and the glyph follows on the next
   frame. `lastInputDevice` is maintained in 17-input.js. */
var interactEl = document.getElementById('interact');
// North face button: Y on an Xbox pad, Triangle on a PlayStation one
function padNorthLabel() {
  const g = typeof getPad === 'function' ? getPad() : null;
  const id = (g && g.id || '').toLowerCase();
  return /dualshock|dualsense|playstation|\bps[45]\b/.test(id) ? '△' : 'Y';
}
var _interactShown = '';
function updateInteractPrompt() {
  const t = typeof findBushPickup === 'function' ? findBushPickup() : null;
  if (!t) {
    if (_interactShown) { interactEl.style.opacity = '0'; _interactShown = ''; }
    return;
  }
  const keyLabel = lastInputDevice === 'pad' ? padNorthLabel() : 'E';
  const txt = `(<b>${keyLabel}</b>) to pickup ${t.name}`;
  if (txt !== _interactShown) { interactEl.innerHTML = txt; _interactShown = txt; }
  interactEl.style.opacity = '1';
}

// block name pops in above the hotbar on selection, then fades out
var blocknameTimer = 0;
function flashBlockName() {
  const id = slotId(HOTBAR[hotbarSel]);
  if (id == null) { blocknameEl.style.opacity = '0'; return; }
  blocknameEl.textContent = id >= 256 ? (ITEM_PROPS[id]?.name || '') : (PROPS[id]?.name || '');
  blocknameEl.style.opacity = '1';
  clearTimeout(blocknameTimer);
  blocknameTimer = setTimeout(() => { blocknameEl.style.opacity = '0'; }, 1100);
}
function buildHotbar() {                         // rebuilt on any slot change -> must not flash
  hotbarEl.innerHTML = '';
  HOTBAR.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'slot' + (i === hotbarSel ? ' sel' : '');
    div.innerHTML = `<span class="key">${i + 1}</span>` + slotInner(s);
    hotbarEl.appendChild(div);
  });
}
function updateHotbar() {
  [...hotbarEl.children].forEach((el, i) => el.classList.toggle('sel', i === hotbarSel));
  flashBlockName();
}

/* ---------------------------------- inventory (3x9) ----------------------------------
   Slot 0 is the BOTTOM-LEFT corner, filling rightward then upward (the grid container is
   column-reversed). Blocks fill in registry order; empty slots await future items, which
   will use flat 2D icons via `{ item, icon2d }` entries.                                  */
