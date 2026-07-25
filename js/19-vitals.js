'use strict';
/* voxiCraft — hearts/drumsticks canvas + survival vitals tick */

/* ---------------------------------- survival vitals HUD ---------------------------------- */
// 10 hearts on the left (each = 2HP), 10 drumsticks on the right (each = 2 food). Food
// depletes over time; saturation (gold outline) drains 3× faster first. Icons are drawn
// pixel-by-pixel into the canvas with a 16x16 stamp for the icon shape (Minecraft-style silhouette).
const vitalsEl = document.getElementById('vitals');
const vctx = vitalsEl.getContext('2d');
vctx.imageSmoothingEnabled = false;

// pre-render the 4 icon variants (full/half/empty × heart/drumstick) into offscreen buffers
const ICON_SZ = 16, ICON_SCALE = 1;         // stamps are 16px drawn 1:1 (fits above the hotbar)
const GUI_SZ = 36;                           // sprite display size: native 36px, no downscaling
function makeIconCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = ICON_SZ; return c;
}
// mask: 16×16 heart silhouette (# = filled cell). Padded to 16 rows AND 16 cols.
const _padMask = (rows) => {
  const out = rows.map(r => r.padEnd(16, ' '));
  while (out.length < 16) out.push(' '.repeat(16));
  return out;
};
const HEART_MASK = _padMask([
  '                ',
  '                ',
  '  ###    ###    ',
  ' ##### ######   ',
  ' ############   ',
  ' ############   ',
  '  ##########    ',
  '   ########     ',
  '    ######      ',
  '     ####       ',
  '      ##        ',
]);
// mask: 16×16 air bubble (round, drawn above the drumsticks while diving)
const BUBBLE_MASK = _padMask([
  '                ',
  '     ######     ',
  '    ########    ',
  '   ##########   ',
  '   ##########   ',
  '  ############  ',
  '  ############  ',
  '  ############  ',
  '  ############  ',
  '   ##########   ',
  '   ##########   ',
  '    ########    ',
  '     ######     ',
]);
// mask: 16×16 drumstick silhouette (meaty bulb top-left, thin bone bottom-right)
const DRUM_MASK = _padMask([
  '                ',
  '  ####          ',
  ' ######         ',
  ' #######        ',
  ' ########       ',
  '  ########      ',
  '   ########     ',
  '     ######     ',
  '       #####    ',
  '         ####   ',
  '          ####  ',
  '           #### ',
  '            ####',
  '            ####',
  '             ###',
  '             ###',
]);

// draw one masked icon at (dx,dy) in the vitals canvas, filling only cells where
// `fillFn(mx,my)` returns true (used for half-drumstick progress top-left → bottom-right)
// colorFn(x,y,edge) overrides per-pixel color when provided (used for food+saturation blended drumstick)
function drawStamp(mask, dx, dy, colorFill, colorOutline, fillFn, colorFn) {
  for (let y = 0; y < ICON_SZ; y++) for (let x = 0; x < ICON_SZ; x++) {
    if (mask[y][x] !== '#') continue;
    let edge = false;
    for (const [ox, oy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || nx >= ICON_SZ || ny < 0 || ny >= ICON_SZ || mask[ny][nx] !== '#') { edge = true; break; }
    }
    if (colorFn) {
      vctx.fillStyle = colorFn(x, y, edge);
    } else {
      const filled = !fillFn || fillFn(x, y);
      vctx.fillStyle = edge ? colorOutline : (filled ? colorFill : '#4a1f1f');
      if (!filled && !edge) vctx.fillStyle = '#3a1414';
    }
    vctx.fillRect(dx + x * ICON_SCALE, dy + y * ICON_SCALE, ICON_SCALE, ICON_SCALE);
  }
}

function paintVitals() {
  const w = vitalsEl.width, h = vitalsEl.height;
  vctx.clearRect(0, 0, w, h);
  // shadow slots (empty background) first, then filled state on top — HP left, food right
  // 10 hearts + 10 drumsticks each take 10 icons; canvas width = 20*step covers both rows
  const iconStep = GUI_SZ + 2;                     // 38px per slot (36 native + 2 gap)
  const EDGE_INSET = 0;                            // flush with canvas edges — CSS width matches hotbar
  const hpX = EDGE_INSET, hunX = w - iconStep * 10 + 2 - EDGE_INSET;
  const ROW_Y = GUI_SZ + 2;                       // bubble row + gap
  const spriteW = GUI_SZ;                         // 36px native, drawn 1:1

  // oxygen bubbles — show instantly when underwater; each slot = 1 air bubble
  if (player._eyeUnder || player.air < MAX_AIR - 0.01) {
    for (let i = 0; i < 10; i++) {
      const bx = hunX + i * iconStep, by = 0;
      const slot = 9 - i;                         // slot 9 leftmost, slot 0 rightmost
      if (player.air >= slot + 1) {
        // full bubble
        if (GUI_IMG.airFull) vctx.drawImage(GUI_IMG.airFull, bx, by, spriteW, spriteW);
        else drawStamp(BUBBLE_MASK, bx, by, '#54b8ff', '#1d5c94');
      } else if (player.air > slot) {
        // partially drained — use bursting sprite
        if (GUI_IMG.airBursting) vctx.drawImage(GUI_IMG.airBursting, bx, by, spriteW, spriteW);
        else drawStamp(BUBBLE_MASK, bx, by, '#a8d8ff', '#1d5c94');
      } else {
        // empty
        if (GUI_IMG.airEmpty) vctx.drawImage(GUI_IMG.airEmpty, bx, by, spriteW, spriteW);
        // empty slots: draw nothing if no texture (invisible)
      }
    }
  }

  for (let i = 0; i < 10; i++) {
    const hpFrac = Math.ceil(Math.max(0, Math.min(2, player.hp - i * 2)));   // ceil so tiny drain doesn't flip icon
    const hunFrac = Math.ceil(Math.max(0, Math.min(2, player.food - i * 2)));
    // heart: sprite-based — container bg, then full/half overlay
    const hx = hpX + i * iconStep;
    if (GUI_IMG.heartContainer) {
      vctx.drawImage(GUI_IMG.heartContainer, hx, ROW_Y, spriteW, spriteW);
      if (hpFrac >= 2 && GUI_IMG.heartFull)      vctx.drawImage(GUI_IMG.heartFull,      hx, ROW_Y, spriteW, spriteW);
      else if (hpFrac >= 1 && GUI_IMG.heartHalf) vctx.drawImage(GUI_IMG.heartHalf,      hx, ROW_Y, spriteW, spriteW);
    } else {
      // fallback procedural while textures load
      drawStamp(HEART_MASK, hx, ROW_Y, '#e14343', '#4a1414',
                hpFrac === 0 ? (() => false) : hpFrac >= 2 ? null : (x) => x < ICON_SZ / 2);
    }
    // food: sprite-based. Rightmost icon (i=9) drains first → invI=9-i maps i=9→invI=0
    const invI = 9 - i;
    const invFrac    = Math.ceil(Math.max(0, Math.min(2, player.food       - invI * 2)));
    const invSatFrac = Math.ceil(Math.max(0, Math.min(2, player.saturation - invI * 2)));
    const fx = hunX + i * iconStep;
    if (GUI_IMG.foodEmpty) {
      vctx.drawImage(GUI_IMG.foodEmpty, fx, ROW_Y, spriteW, spriteW);
      // food state drawn first so saturation overlays on top of it
      if (invFrac >= 2 && GUI_IMG.foodFull)
        vctx.drawImage(GUI_IMG.foodFull, fx, ROW_Y, spriteW, spriteW);
      else if (invFrac >= 1 && GUI_IMG.foodHalf)
        vctx.drawImage(GUI_IMG.foodHalf, fx, ROW_Y, spriteW, spriteW);
      // saturation overlay (PNG alpha lets drumstick show through)
      if (invSatFrac >= 2 && GUI_IMG.foodSaturation)
        vctx.drawImage(GUI_IMG.foodSaturation, fx, ROW_Y, spriteW, spriteW);
      else if (invSatFrac >= 1 && GUI_IMG.foodSaturationHalf)
        vctx.drawImage(GUI_IMG.foodSaturationHalf, fx, ROW_Y, spriteW, spriteW);
    } else {
      // fallback procedural while textures load
      const invFracN = invFrac / 2;
      const invSatFracN = invSatFrac / 2;
      if (!paintVitals._drumSort) {
        const list = [];
        for (let yy = 0; yy < ICON_SZ; yy++) for (let xx = 0; xx < ICON_SZ; xx++)
          if (DRUM_MASK[yy][xx] === '#') list.push([xx, yy, xx + yy]);
        list.sort((a, b) => b[2] - a[2]);
        paintVitals._drumSort = list; paintVitals._drumTotal = list.length;
      }
      const cutoff = Math.round(paintVitals._drumTotal * invFracN);
      const lit = new Set();
      for (let k = 0; k < cutoff; k++) { const p = paintVitals._drumSort[k]; lit.add(p[0] + p[1] * ICON_SZ); }
      drawStamp(DRUM_MASK, fx, ROW_Y, '#c9873c', invSatFracN > 0 ? '#ffd700' : '#5a3410',
                invFracN === 1 ? null : (x, y) => lit.has(x + y * ICON_SZ));
    }
  }
}
let vitalsDirty = true, vitalsShown = false;

// GUI sprite textures — loaded async; vitalsDirty set on each load to trigger a repaint
const GUI_IMG = {};
{
  const _p = {
    heartContainer:      'textures/gui/vitals/Heart/container.png',
    heartFull:           'textures/gui/vitals/Heart/full.png',
    heartHalf:           'textures/gui/vitals/Heart/half.png',
    airFull:             'textures/gui/vitals/Oxygen/air.png',
    airBursting:         'textures/gui/vitals/Oxygen/air_bursting.png',
    airEmpty:            'textures/gui/vitals/Oxygen/air_empty.png',
    foodEmpty:           'textures/gui/vitals/food/food_empty.png',
    foodFull:            'textures/gui/vitals/food/food_full.png',
    foodHalf:            'textures/gui/vitals/food/food_half.png',
    foodSaturation:      'textures/gui/vitals/food/food_Saturation.png',
    foodSaturationHalf:  'textures/gui/vitals/food/food_Saturation_half.png',
  };
  for (const [k, src] of Object.entries(_p)) {
    const img = new Image();
    img.onload = () => { GUI_IMG[k] = img; vitalsDirty = true; };
    img.src = src;
  }
}
// per-frame: survival only. Depletes food by activity, regenerates HP when well-fed (which
// costs food fast), starves at empty food, kills+respawns at 0 HP. Fall damage kept from
// the previous pass. Sprint/jump ARE the main food consumers — idle is very slow (per user).
function updateVitals(dt) {
  const survival = !player.canFly && player.spawned;
  if (survival !== vitalsShown) {
    vitalsShown = survival;
    vitalsEl.style.display = survival ? 'block' : 'none';
    vitalsDirty = true;
  }
  // hurt vignette fade-out (runs in any mode so it never sticks)
  if (_hurtA > 0) {
    _hurtA = Math.max(0, _hurtA - dt * 1.6);
    hurtEl.style.opacity = _hurtA.toFixed(3);
  }
  if (!survival) return;
  if (!player.dead) player.aliveT = (player.aliveT || 0) + dt;   // survival stopwatch for the death screen
  const prevFood = player.food, prevHp = player.hp, prevSat = player.saturation;

  // food drain: idle baseline, sprint multiplier, and a discrete tick per jump edge.
  // sprinting only counts when actually moving on the ground (not fly-fast, not falling)
  const grounded = onGround();
  const moving = (player._movingH || 0) > 0.001;
  const isSprinting = player.fast && moving && grounded && !player.flying;
  const drainMul = isSprinting ? FOOD_SPRINT_MULT : 1;
  let totalDrain = FOOD_IDLE_PER_S * drainMul * dt;

  // jump edge: discrete food cost
  if (player.prevOnGround && !grounded && player.vy > 0.1 && !player.flying)
    totalDrain += FOOD_JUMP_COST * (isSprinting ? 0.4 : 1);
  player.prevOnGround = grounded;

  // regen: kicks in above 12 food, doubles above 18
  if (player.hp < MAX_HP && player.food > REGEN_FOOD_MIN) {
    const rate = REGEN_HP_PER_S * (player.food > REGEN_FAST_FOOD ? 2 : 1);
    player.hp = Math.min(MAX_HP, player.hp + rate * dt);
    totalDrain += FOOD_REGEN_COST_PER_S * dt;
  }

  // saturation acts as a buffer: drains 3× faster than food, protects food while > 0
  if (player.saturation > 0) {
    const satCost = totalDrain * 3;
    if (player.saturation >= satCost) {
      player.saturation -= satCost;
      totalDrain = 0;
    } else {
      totalDrain -= player.saturation / 3;
      player.saturation = 0;
    }
  }
  player.food = Math.max(0, player.food - totalDrain);

  // starve: HP drains when food is empty
  if (player.food <= 0) { player.hp = Math.max(0, player.hp - STARVE_HP_PER_S * dt); player._dmgCause = 'starved to death'; }

  // fall damage: track apex → landing (walking mode only); water cancels any fall
  if (!player.flying) {
    if (player._inWater) player.fallStart = null;
    if (player.vy < -0.1 && player.fallStart == null) player.fallStart = player.pos.y;
    else if (player.vy >= 0 && player.fallStart != null) {
      const fell = player.fallStart - player.pos.y;
      // hay bale fully absorbs fall damage when you land on it
      const landOn = getBlock(Math.floor(player.pos.x), Math.floor(player.pos.y - 0.1), Math.floor(player.pos.z)) & 255;
      if (fell > 3.5 && landOn !== B.HAY) { player.hp = Math.max(0, player.hp - (fell - 3)); player._dmgCause = 'fell from a high place'; }   // 1 HP per block past 3
      player.fallStart = null;
    }
  } else player.fallStart = null;

  // cactus: any contact hurts (1 HP / 0.8s) and knocks you away — small hop plus a horizontal
  // shove away from the cactus centre, applied through collision over a short burst
  if (!player.flying) {
    const p = player.pos, CR = player.R + 0.08;                // slightly expanded AABB = touch range
    let cactX = null, cactZ = null;
    const yLo = Math.floor(p.y - 0.1), yHi = Math.floor(p.y + player.H);
    outer:
    for (let yy = yLo; yy <= yHi; yy++)
      for (let xx = Math.floor(p.x - CR); xx <= Math.floor(p.x + CR); xx++)
        for (let zz = Math.floor(p.z - CR); zz <= Math.floor(p.z + CR); zz++)
          if ((getBlock(xx, yy, zz) & 255) === B.CACTUS) { cactX = xx; cactZ = zz; break outer; }
    if (cactX !== null) {
      updateVitals._cactusT = (updateVitals._cactusT || 0) - dt;
      if (updateVitals._cactusT <= 0) {
        updateVitals._cactusT = 0.8;
        player.hp = Math.max(0, player.hp - 1);
        player._dmgCause = 'was pricked by a cactus';
        player.vy = Math.max(player.vy, 5.5);
        let kx = p.x - (cactX + 0.5), kz = p.z - (cactZ + 0.5);
        const len = Math.hypot(kx, kz);
        if (len < 0.05) { const a = Math.random() * Math.PI * 2; kx = Math.cos(a); kz = Math.sin(a); }
        else { kx /= len; kz /= len; }
        player._kbx = kx * 10; player._kbz = kz * 10; player._kbT = 0.35;   // strong enough to beat walk speed
      }
    } else updateVitals._cactusT = 0;
  }
  // lava: 2 HP per 0.5s while feet or body are inside lava
  if (!player.flying) {
    const p = player.pos;
    const feetId  = getBlock(Math.floor(p.x), Math.floor(p.y - 0.1), Math.floor(p.z)) & 255;
    const bodyId  = getBlock(Math.floor(p.x), Math.floor(p.y + 0.4), Math.floor(p.z)) & 255;
    if (feetId === B.LAVA || bodyId === B.LAVA) {
      updateVitals._lavaT = (updateVitals._lavaT || 0) - dt;
      if (updateVitals._lavaT <= 0) {
        updateVitals._lavaT = 0.5;
        player.hp = Math.max(0, player.hp - 2);
        player._dmgCause = 'burned to death';
      }
    } else updateVitals._lavaT = 0;
  }
  if (player._kbT > 0) {
    player._kbT -= dt;
    collideAxis(0, player._kbx * dt);
    collideAxis(2, player._kbz * dt);
  }

  // oxygen: eyes underwater drain air over ~15s; at 0 drowning ticks 1 heart/s; refills fast in air
  const prevAir = player.air;
  const eyeUnder = (getBlock(Math.floor(player.pos.x), Math.floor(player.pos.y + player.EYE),
                             Math.floor(player.pos.z)) & 255) === B.WATER;
  if (eyeUnder !== player._eyeUnder) vitalsDirty = true;
  player._eyeUnder = eyeUnder;
  if (eyeUnder && !player.flying) {
    player.air = Math.max(0, player.air - dt * (MAX_AIR / 15));
    if (player.air <= 0) {
      updateVitals._drownT = (updateVitals._drownT || 0) + dt;
      if (updateVitals._drownT >= 1) { updateVitals._drownT -= 1; player.hp = Math.max(0, player.hp - 2); player._dmgCause = 'drowned'; }
    }
  } else {
    player.air = Math.min(MAX_AIR, player.air + dt * 5);
    updateVitals._drownT = 0;
  }
  if (Math.ceil(player.air) !== Math.ceil(prevAir) ||
      (prevAir < MAX_AIR && player.air >= MAX_AIR)) vitalsDirty = true;

  // void death
  if (player.pos.y < -30) { player.hp = 0; player._dmgCause = 'fell into the void'; }
  // death: drop everything around the body, freeze input, show the death screen —
  // respawn happens when the player clicks Respawn (respawnPlayer below)
  if (player.hp <= 0 && !player.dead) {
    player.dead = true;
    const dx0 = Math.floor(player.pos.x), dy0 = Math.floor(player.pos.y + 0.5), dz0 = Math.floor(player.pos.z);
    for (const arr of [HOTBAR, invSlots])
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (!s) continue;
        for (let n = 0; n < s.count; n++)
          spawnDrop(s.id, dx0, dy0, dz0,
            { x: (Math.random() - 0.5) * 5, y: 2 + Math.random() * 3, z: (Math.random() - 0.5) * 5 }, 2);
        arr[i] = null;
      }
    saveAll(); buildHotbar();
    if (invOpen) toggleInventory(false);
    showDeathScreen(player._dmgCause || 'died');
  }
  if (player.dead) for (const k in keys) keys[k] = false;   // no wandering while dead
  // discrete hit this frame (fall / cactus / drown — slow starve drain stays below threshold):
  // red flash + camera kick, both scaled by how hard the hit was
  const lostHp = prevHp - player.hp;
  if (lostHp >= 0.5 && !player.dead) hurtFlash(lostHp);
  if (Math.floor(player.hp * 2) !== Math.floor(prevHp * 2)
      || Math.floor(player.food * 2) !== Math.floor(prevFood * 2)
      || Math.floor(player.saturation * 2) !== Math.floor(prevSat * 2)) vitalsDirty = true;
  if (vitalsDirty) { paintVitals(); vitalsDirty = false; }
}

/* ---- hurt feedback: red vignette (strength scales with damage) + camera kick ---- */
const camShake = { t: 0, dur: 0.25, amp: 0 };
const hurtEl = document.createElement('div');
hurtEl.id = 'hurtOverlay';
document.body.appendChild(hurtEl);
let _hurtA = 0;
function hurtFlash(lost) {
  _hurtA = Math.min(0.9, 0.3 + lost * 0.09);
  camShake.t = camShake.dur;
  camShake.amp = Math.min(0.06, 0.015 + lost * 0.007);
  hurtEl.style.opacity = _hurtA.toFixed(3);
}

/* ---- death screen ---- */
function showDeathScreen(cause) {
  const el = document.getElementById('deathScreen');
  document.getElementById('deathCause').textContent = 'You ' + cause;
  const t = Math.floor(player.aliveT || 0);
  const tStr = t >= 60 ? `${Math.floor(t / 60)}m ${t % 60}s` : `${t}s`;
  document.getElementById('deathStats').textContent = `Survived ${tStr} · Day ${worldDay + 1}`;
  el.style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
}
function respawnPlayer() {
  player.hp = MAX_HP; player.food = MAX_FOOD; player.saturation = 0; player.air = MAX_AIR;
  player.vy = 0; player.fallStart = null; player._kbT = 0; player._dmgCause = null; player.aliveT = 0;
  const s = findValidSpawn();
  if (s) {
    player.pos.set(s.x, s.y, s.z);
    if (!player.spawnPos) player.spawnPos = player.pos.clone();
  } else if (player.spawnPos) {
    player.pos.copy(player.spawnPos);
  } else {
    const sy = surfaceY(Math.floor(player.pos.x), Math.floor(player.pos.z));
    player.pos.y = Math.max(sy + 2, WATER_Y + 3);
  }
  player.dead = false;
  document.getElementById('deathScreen').style.display = 'none';
  paintVitals();
  if (playing) { lockTries = 0; tryPointerLock(); }
}
document.getElementById('respawnBtn').addEventListener('click', respawnPlayer);

