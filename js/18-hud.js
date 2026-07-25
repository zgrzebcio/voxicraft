'use strict';
/* voxiCraft — hud, toast, hotbar DOM */

/* ================================================================================================
   HUD — fps, coords, selected block, hotbar, radial picker.
   ================================================================================================ */
const hudEl = document.getElementById('hud');
const blocknameEl = document.getElementById('blockname');
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
const hotbarEl = document.getElementById('hotbar');
const radialEl = document.getElementById('radial');
const radialCtx = radialEl.getContext('2d');

// block name pops in above the hotbar on selection, then fades out
let blocknameTimer = 0;
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
