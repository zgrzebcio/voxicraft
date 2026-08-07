'use strict';
/* voxiCraft — dropped-block pickups (spawn, physics, pickup) */

/* ---------------------------------- dropped-block pickups ---------------------------------
   Survival mining spawns a mini rotating block at the broken cell; it pops up, falls with
   gravity, rests on any solid below, spins forever, and vanishes when the player walks over
   it (auto-added to the first empty inventory slot; duplicates dissolve silently).
   Geometry is baked once per (id, variant) — every drop shares the same BufferGeometry.
   Drops are cleared on world reset and when leaving survival mode. */
const DROP_GEOM = {};

/* Minecraft-style extruded sprite: two textured quads (front/back) plus per-pixel side walls
   around the sprite's silhouette, each wall vertex-colored from the sprite pixel it belongs to
   (slightly darkened). Item lies flat and spins. Needs IMAGES[icon] preloaded by buildAtlas. */
const ITEM_DROP_THICK = 1 / 16;
function buildItemDropGeom(id, iconName) {
  const key = 'item:' + id;
  if (DROP_GEOM[key]) return DROP_GEOM[key];
  const props = ITEM_PROPS[id];
  const img = IMAGES[iconName || (props && props.icon)];
  if (!img) return [];
  // non-square sprites (door) get centred in a square canvas so the extruder stays simple
  const S = Math.max(img.width, img.height);
  const cvs = document.createElement('canvas'); cvs.width = cvs.height = S;
  const c2d = cvs.getContext('2d');
  c2d.drawImage(img, (S - img.width) / 2, (S - img.height) / 2);
  const px = c2d.getImageData(0, 0, S, S).data;
  const solid = (i, j) => i >= 0 && j >= 0 && i < S && j < S && px[(j * S + i) * 4 + 3] > 127;
  const hz = ITEM_DROP_THICK / 2;

  // front (+Z) and back (-Z) textured quads; alphaTest cuts the transparent surround
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;  // ColorManagement off + sRGB output: without this the sprite renders washed-out
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const matFace = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, hz,   0.5, -0.5, hz,   0.5, 0.5, hz,   -0.5, 0.5, hz,
    -0.5, -0.5, -hz,  0.5, -0.5, -hz,  0.5, 0.5, -hz,  -0.5, 0.5, -hz,
  ], 3));
  faceGeo.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1,  0, 0, 1, 0, 1, 1, 0, 1,
  ], 2));
  faceGeo.setIndex([0, 1, 2, 0, 2, 3, 6, 5, 4, 7, 6, 4]);

  // silhouette side walls: one thin quad per exposed pixel edge, vertex-colored from that pixel
  const pos = [], col = [], idx = [];
  const tmp = new THREE.Color();
  const SIDE_DARKEN = 0.78;               // sides slightly darker than the face = depth cue
  const quad = (x0, y0, x1, y1, r, g, b) => {
    // output colors are sRGB-encoded by the renderer (ColorManagement off), so feed linear
    tmp.setRGB(r / 255 * SIDE_DARKEN, g / 255 * SIDE_DARKEN, b / 255 * SIDE_DARKEN).convertSRGBToLinear();
    const base = pos.length / 3;
    pos.push(x0, y0, hz, x1, y1, hz, x1, y1, -hz, x0, y0, -hz);
    for (let k = 0; k < 4; k++) col.push(tmp.r, tmp.g, tmp.b);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    if (!solid(i, j)) continue;
    const o = (j * S + i) * 4, r = px[o], g = px[o + 1], b = px[o + 2];
    const x0 = i / S - 0.5, x1 = (i + 1) / S - 0.5;
    const y0 = 0.5 - (j + 1) / S, y1 = 0.5 - j / S;   // image y-down -> world y-up
    if (!solid(i, j - 1)) quad(x0, y1, x1, y1, r, g, b);  // top edge
    if (!solid(i, j + 1)) quad(x0, y0, x1, y0, r, g, b);  // bottom edge
    if (!solid(i - 1, j)) quad(x0, y0, x0, y1, r, g, b);  // left edge
    if (!solid(i + 1, j)) quad(x1, y0, x1, y1, r, g, b);  // right edge
  }
  const sideGeo = new THREE.BufferGeometry();
  sideGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sideGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  sideGeo.setIndex(idx);
  const matSide = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

  // upright with slight backward lean (like the old drops); group rotation.y spins it
  const lean = new THREE.Matrix4().makeRotationX(-Math.PI * 0.12);
  faceGeo.applyMatrix4(lean);
  sideGeo.applyMatrix4(lean);
  const passes = [{ p: 0, geo: sideGeo, mat: matSide }, { p: 0, geo: faceGeo, mat: matFace }];
  DROP_GEOM[key] = passes;
  return passes;
}

function buildDropGeom(id, variant = 0) {
  if (id >= 256) return buildItemDropGeom(id);
  if (id === B.DOOR) return buildItemDropGeom(id, 'oak_door');   // no chunk-mesh model — sprite drop
  if (id === B.BED)  return [{ node: bedItemNode() }];           // real mesh, not a flat sprite
  // Chest has no chunk-mesh model, but unlike the door and bed it IS a full 3D shape — a flat
  // chest_front sprite in the hand looked like a painting. Hand it the real lid-and-body mesh
  // (the same one 05-icons.js renders) as a node the caller adds directly.
  if (id === B.CHEST) return [{ node: chestItemNode() }];
  // as an item a log is a full 64-unit block, not whatever width it happened to grow at
  if (!variant && PROPS[id]?.model === 'log') variant = CORE.LOG_W_BLOCK << 2;
  const key = id + ':' + variant;
  if (DROP_GEOM[key]) return DROP_GEOM[key];
  const data = new Uint16Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
  data[CORE.idx(8, 64, 8)] = id | (variant << 8);
  const empty = () => new Uint16Array(16 * 200).buffer;
  const lite = () => new Uint8Array(16 * 200).fill(0xF0).buffer;
  // drops render fully sky-lit (high nibble 15) like icons, or they'd bake as cave-dark
  const lightArr = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z).fill(0xF0);
  if (PROPS[id]?.light) {
    for (const d of [[9,64,8],[7,64,8],[8,65,8],[8,63,8],[8,64,9],[8,64,7]])
      lightArr[CORE.idx(d[0], d[1], d[2])] = 0xFF;
  }
  const r = CORE.meshChunk(data.buffer, empty(), empty(), empty(), empty(),
                           lightArr.buffer, lite(), lite(), lite(), lite());
  const passes = [];
  for (let p = 0; p < 4; p++) {
    const g = r.passes[p];
    if (!g) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',   new THREE.BufferAttribute(g.pos, 3));
    geo.setAttribute('uv',         new THREE.BufferAttribute(g.uv, 2));
    geo.setAttribute('tile',       new THREE.BufferAttribute(g.tile, 1, false));
    geo.setAttribute('shade',      new THREE.BufferAttribute(g.shade, 1, true));
    geo.setAttribute('blockLight', new THREE.BufferAttribute(g.lite, 1, false));
    geo.setIndex(new THREE.BufferAttribute(g.index, 1));
    geo.translate(-8.5, -64.5, -8.5);           // centre on origin so rotation looks nice
    passes.push({ p, geo });
  }
  DROP_GEOM[key] = passes;
  return passes;
}
const DROPS = [];
const DROP_SCALE = 0.28, DROP_HALF = DROP_SCALE / 2;
const DROP_GRAVITY = 20, DROP_PICKUP_R = 1.6, DROP_LIFETIME = 300;
const DROP_REST_LIFT = 0.22;               // extra height above the block top when grounded
const DROP_HOP_AMP  = 0.025;               // very subtle bob — user asked for slow, not jumpy
const DROP_HOP_HZ   = 1.1;                 // ~5.7s per full up-down cycle
const DEFAULT_PICKUP_DELAY = 0.35;
const PLAYER_DROP_PICKUP_DELAY = 1.5;      // player-tossed items refuse re-pickup for this long
function spawnDrop(id, x, y, z, vel, pickupDelay = DEFAULT_PICKUP_DELAY, dur = null) {
  const passes = buildDropGeom(id);
  if (!passes.length) return null;
  const group = new THREE.Group();
  for (const { p, geo, mat: matOverride, node } of passes) {
    if (node) { group.add(node); continue; }     // prebuilt sub-tree (chest); no pass material
    const m = new THREE.Mesh(geo, matOverride || MATERIALS[p]);
    m.renderOrder = p;
    group.add(m);
  }
  group.scale.setScalar(DROP_SCALE);
  // Spawn CENTRE the drop above the cell's midpoint so it can't start already inside a block.
  group.position.set(x + 0.5, y + 0.5, z + 0.5);
  scene.add(group);
  const rec = {
    group, id, age: 0,
    vx: vel ? vel.x : (Math.random() - 0.5) * 1.4,
    vy: vel ? vel.y : 3.5,
    vz: vel ? vel.z : (Math.random() - 0.5) * 1.4,
    grounded: false, base: y + 0.5,
    pickupDelay,
    dur,                                   // tool wear carried through the drop (null for non-tools)
  };
  DROPS.push(rec);
  return rec;
}
// Player Y/Shift+Y drop: pop the item out in front of the eye, moving forward. Stronger toss
// than a mining pop, and a longer pickup delay so you can't grab it back the same tick.
function throwFromPlayer(id, count, dur = null) {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const spawnX = player.pos.x + forward.x * 0.4;
  const spawnY = player.pos.y + player.EYE - 0.35;
  const spawnZ = player.pos.z + forward.z * 0.4;
  for (let i = 0; i < count; i++) {
    const jitter = 0.6;
    spawnDrop(id, Math.floor(spawnX), Math.floor(spawnY), Math.floor(spawnZ), {
      x: forward.x * 5.5 + (Math.random() - 0.5) * jitter,
      y: 3.6 + (Math.random() - 0.5) * 0.3,
      z: forward.z * 5.5 + (Math.random() - 0.5) * jitter,
    }, PLAYER_DROP_PICKUP_DELAY, dur);
    // spawnDrop centres on the cell midpoint; nudge back to the true throw origin
    const rec = DROPS[DROPS.length - 1];
    if (rec) rec.group.position.set(spawnX, spawnY, spawnZ);
  }
}
function dropFromHotbar(mode) {
  if (player.canFly) return;                   // creative: no drops
  const s = HOTBAR[hotbarSel];
  if (!s) return;
  const id = s.id;
  const n = mode === 'stack' ? s.count : 1;
  throwFromPlayer(id, n, s.dur ?? null);
  s.count -= n;
  if (s.count <= 0) HOTBAR[hotbarSel] = null;
  saveHotbar(); buildHotbar();
}
function tryPickup(id, dur = null) {
  const cap = stackSize(id);
  // worn tool: lands in an empty slot with its wear intact (stack top-up can't apply at cap 1)
  const landSlot = () => { const t = mkSlot(id); if (dur != null) t.dur = dur; return t; };
  // 1) top up an existing partial stack (hotbar first so the player sees it)
  for (let i = 0; i < HOTBAR.length; i++) {
    const s = HOTBAR[i]; if (s && s.id === id && s.count < cap) {
      s.count++; saveHotbar(); buildHotbar(); return true;
    }
  }
  for (let i = 0; i < invSlots.length; i++) {
    const s = invSlots[i]; if (s && s.id === id && s.count < cap) {
      s.count++; saveInv(); if (invOpen) buildInventory(); return true;
    }
  }
  // 2) otherwise take an empty slot
  for (let i = 0; i < HOTBAR.length; i++) if (HOTBAR[i] == null) {
    HOTBAR[i] = landSlot(); saveHotbar(); buildHotbar(); return true;
  }
  for (let i = 0; i < invSlots.length; i++) if (invSlots[i] == null) {
    invSlots[i] = landSlot(); saveInv(); if (invOpen) buildInventory(); return true;
  }
  return false;
}
function removeDrop(i) {
  const d = DROPS[i];
  scene.remove(d.group);
  DROPS.splice(i, 1);
}
function clearDrops() {
  while (DROPS.length) removeDrop(DROPS.length - 1);
  for (const pr of PROJECTILES) scene.remove(pr.group);
  PROJECTILES.length = 0;
}
/* ---- projectiles: throwable items (snowball etc) — fly forward, vanish on block hit ---- */
const PROJECTILES = [];
const PROJ_GRAVITY = 14;
function spawnProjectile(id, x, y, z, vx, vy, vz) {
  const passes = buildDropGeom(id);
  if (!passes.length) return;
  const group = new THREE.Group();
  for (const { p, geo, mat: matOverride, node } of passes) {
    if (node) { group.add(node); continue; }     // prebuilt sub-tree (chest); no pass material
    const m = new THREE.Mesh(geo, matOverride || MATERIALS[p]);
    m.renderOrder = p;
    group.add(m);
  }
  group.scale.setScalar(DROP_SCALE * 0.75);
  group.position.set(x, y, z);
  scene.add(group);
  PROJECTILES.push({ group, vx, vy, vz, age: 0 });
}
function updateProjectiles(dt) {
  for (let i = PROJECTILES.length - 1; i >= 0; i--) {
    const pr = PROJECTILES[i];
    pr.age += dt;
    pr.group.rotation.y += 10 * dt;
    pr.vy -= PROJ_GRAVITY * dt;
    const pos = pr.group.position;
    const nx = pos.x + pr.vx * dt;
    const ny = pos.y + pr.vy * dt;
    const nz = pos.z + pr.vz * dt;
    if (isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz)) || pr.age > 10 || ny < -30) {
      scene.remove(pr.group);
      PROJECTILES.splice(i, 1);
      continue;
    }
    pos.set(nx, ny, nz);
  }
}

function updateDrops(dt) {
  const py = player.pos.y + player.H * 0.5;
  for (let i = DROPS.length - 1; i >= 0; i--) {
    const d = DROPS[i];
    d.age += dt;
    d.group.rotation.y += 1.7 * dt;
    const p = d.group.position;
    // ---- water: buoyancy floats the drop up to the surface; current carries it along ----
    const wbx = Math.floor(p.x), wby = Math.floor(p.y), wbz = Math.floor(p.z);
    const inWater = (getBlock(wbx, wby, wbz) & 255) === B.WATER;
    if (inWater) {
      d.grounded = false;
      // top of this water column + its level height = float target
      let ty = wby;
      while ((getBlock(wbx, ty + 1, wbz) & 255) === B.WATER) ty++;
      const lvl = (getBlock(wbx, ty, wbz) >> 8) & 7;
      const surf = ty + (8 - lvl) / 9;
      const target = surf + DROP_HALF * 0.5;
      // spring toward the surface, heavily damped = gentle bobbing float
      d.vy += (target - p.y) * 6 * dt;
      d.vy *= Math.max(0, 1 - 4 * dt);
      if (d.vy > 0.8) d.vy = 0.8;            // slow rise — no popping out of the water
      // current push (drop drifts downstream, capped speed)
      if (waterFlowVec(wbx, wby, wbz, _flowV)) {
        d.vx += _flowV.x * 6 * dt;
        d.vz += _flowV.z * 6 * dt;
        const sp = Math.hypot(d.vx, d.vz);
        if (sp > 1.4) { d.vx *= 1.4 / sp; d.vz *= 1.4 / sp; }
      } else { d.vx *= Math.max(0, 1 - 2 * dt); d.vz *= Math.max(0, 1 - 2 * dt); }
      let nx = p.x + d.vx * dt, nz = p.z + d.vz * dt;
      if (isSolid(Math.floor(nx), wby, wbz)) { d.vx = 0; nx = p.x; }
      if (isSolid(wbx, wby, Math.floor(nz))) { d.vz = 0; nz = p.z; }
      p.x = nx; p.z = nz;
      p.y += d.vy * dt;
    }
    // Grounded drops STOP physics entirely (no gravity, no ground-check re-fires) — otherwise
    // each frame gravity pulled p.y below base and the next tick's snap yanked it back, which
    // read as a constant bounce. Only re-enter physics if the block underneath disappeared.
    if (!inWater && d.grounded) {
      const supY = Math.floor(d.base - DROP_HALF - DROP_REST_LIFT - 0.1);
      if (isSolid(Math.floor(p.x), supY, Math.floor(p.z))) {
        p.y = d.base + Math.sin(d.age * DROP_HOP_HZ) * DROP_HOP_AMP;
      } else {
        d.grounded = false; d.vy = 0;                // ground was mined out from under it
      }
    }
    if (!inWater && !d.grounded) {
      // physics — treat drop as a point; simple axis-independent block collisions
      d.vy -= DROP_GRAVITY * dt;
      let nx = p.x + d.vx * dt, nz = p.z + d.vz * dt;
      if (isSolid(Math.floor(nx), Math.floor(p.y), Math.floor(p.z))) { d.vx = 0; nx = p.x; }
      if (isSolid(Math.floor(p.x), Math.floor(p.y), Math.floor(nz))) { d.vz = 0; nz = p.z; }
      p.x = nx; p.z = nz;
      let ny = p.y + d.vy * dt;
      // Ground snap seats centre at blockTop + DROP_HALF + REST_LIFT so the drop bottom rests
      // clearly above the block surface. Check well below the drop centre so the ground block
      // is always found (a shorter offset landed on the (mined) air cell above the surface).
      const gc = Math.floor(ny - DROP_HALF - DROP_REST_LIFT - 0.02);
      if (d.vy < 0 && isSolid(Math.floor(p.x), gc, Math.floor(p.z))) {
        ny = gc + 1 + DROP_HALF + DROP_REST_LIFT;
        d.vy = 0; d.vx *= 0.5; d.vz *= 0.5;
        d.grounded = true; d.base = ny;
      } else if (d.vy > 0 && isSolid(Math.floor(p.x), Math.floor(ny + DROP_HALF + 0.01), Math.floor(p.z))) {
        ny = p.y; d.vy = 0;
      }
      p.y = ny;
    }
    if (p.y < -30) { removeDrop(i); continue; }
    // pickup — grace so a fresh drop isn't grabbed before the pop is visible; player-tossed
    // items get a much longer grace so throwing them doesn't loop back into your hotbar.
    if (d.age > d.pickupDelay && !player.dead) {    // a corpse doesn't vacuum its own death drops
      const dx = p.x - player.pos.x, dyv = p.y - py, dz = p.z - player.pos.z;
      if (dx*dx + dyv*dyv + dz*dz < DROP_PICKUP_R * DROP_PICKUP_R) {
        if (tryPickup(d.id, d.dur ?? null)) { removeDrop(i); continue; }
      }
    }
    if (d.age > DROP_LIFETIME) removeDrop(i);
  }
}

