'use strict';
/* voxiCraft — bed: 2-cell block (1 wide × 9/16 tall × 2 long), right-click to sleep the night away.

   Like the door, the chunk mesher emits NOTHING for bed cells — each bed is a single three.js
   group (mattress slab + four legs) built here. The voxel cells still exist for collision and
   raycast so you can stand on it and mine it.

   variant byte: bits 0-1 facing (0:+Z 1:-Z 2:+X 3:-X), bit 3 (8) = this cell is the HEAD.
   The FOOT cell owns the mesh; the head is registered from it via the facing offset. */

const BEDS = new Map();            // "x,y,z" of the FOOT cell -> {group, x, y, z, mats, lastB}
const BED_H = 0.5625;              // 9/16, the classic bed height (legs are drawn into the side art)

// facing -> unit vector from the FOOT cell toward the HEAD cell
const BED_DIR = [[0, 1], [0, -1], [1, 0], [-1, 0]];   // 0:+Z 1:-Z 2:+X 3:-X

/* ---------------------------------- textures ---------------------------------- */
const _bedTexCache = {};
function bedTexture(name) {
  if (_bedTexCache[name]) return _bedTexCache[name];
  const t = new THREE.Texture(IMAGES[name]);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  _bedTexCache[name] = t;
  return t;
}
function bedMat(name) {
  return new THREE.MeshBasicMaterial({ map: bedTexture(name), transparent: true, alphaTest: 0.5 });
}

/* The side textures are authored for a FULL 1-block-tall face with the bed drawn only in the
   bottom 36 of 64 rows — measured, not guessed. 36/64 = 0.5625 = exactly BED_H, so the whole
   bed (mattress AND its wooden legs) is one box that height; the legs are part of the artwork.
   Mapping the full 0..1 V range onto it was what left a transparent band above the frame. */
const BED_SIDE_V = 36 / 64;               // opaque slice of bed_long / bed_end, measured from the bottom

/* One box, 1 x BED_H x 2, lying along +Z with the FOOT at z=0 and the HEAD at z=2.
   Box face order is [+X, -X, +Y, -Y, +Z, -Z]:
     ±X  long sides   -> bed_long (128x64 profile, V cropped to the opaque slice)
     +Y  top          -> bed_top  (128x64, spans both halves, rotated 90 deg — see below)
     -Y  underside    -> oak planks, per the requested look
     ±Z  the two caps -> bed_end  (64x64, one cell wide, same V crop)                        */
function bedMattressMesh() {
  const geo = new THREE.BoxGeometry(1, BED_H, 2);
  geo.translate(0.5, BED_H / 2, 1);                  // origin at the foot cell's corner
  const uv = geo.attributes.uv;
  // side + cap faces: squeeze V into the opaque bottom slice of the sheet
  for (const base of [0, 4, 16, 20])
    for (let i = base; i < base + 4; i++) uv.setY(i, uv.getY(i) * BED_SIDE_V);
  // -X side and -Z cap read mirrored otherwise
  for (const base of [4, 20])
    for (let i = base; i < base + 4; i++) uv.setX(i, 1 - uv.getX(i));
  // TOP: the face is 1 wide (X) by 2 long (Z) and the sheet is 128x64, so the sheet's WIDTH
  // has to run along Z. Default box UVs put U on X, which laid the pillow across the bed
  // sideways — rotate the face UVs 90 degrees: (u,v) -> (v, 1-u).
  for (let i = 8; i < 12; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, v, 1 - u);
  }
  uv.needsUpdate = true;
  const long = bedMat('bed_long'), top = bedMat('bed_top');
  const end = bedMat('bed_end'), under = bedMat('oak_planks');
  const mats = [long, long, top, under, end, end];
  return { mesh: new THREE.Mesh(geo, mats), mats: [long, top, end, under] };
}

/* bed_down is a 128x64 sheet that is transparent except for the four leg footprints, i.e. the
   underside of the whole 1x2 bed. It is laid as a second quad a hair below the plank underside
   so the planks show between the legs and the leg bottoms show on top of them. */
function bedUndersideMesh() {
  const geo = new THREE.PlaneGeometry(1, 2);
  geo.rotateX(Math.PI / 2);                          // face downward
  geo.translate(0.5, -0.002, 1);
  const uv = geo.attributes.uv;
  for (let i = 0; i < 4; i++) {                      // same 90 deg turn as the top face
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, v, 1 - u);
  }
  uv.needsUpdate = true;
  const down = bedMat('bed_down');
  return { mesh: new THREE.Mesh(geo, down), mats: [down] };
}

/* Bed as a held/dropped item — same treatment as the chest: a flat bed_long sprite read as a
   painting. One shared prototype cloned per use; built lazily because IMAGES is empty at parse
   time. The model is 1 x BED_H x 2 anchored at the foot corner, so it is shifted to sit centred
   on the origin the way drop/hand geometry expects. */
let _bedItemProto = null;
function bedItemNode() {
  if (!_bedItemProto) {
    const inner = new THREE.Group();
    inner.add(bedMattressMesh().mesh, bedUndersideMesh().mesh);
    inner.position.set(-0.5, -BED_H / 2, -1);
    _bedItemProto = new THREE.Group();
    _bedItemProto.add(inner);
    _bedItemProto.scale.setScalar(0.62);     // 2 cells long — shrink so it reads in the hand
  }
  return _bedItemProto.clone();
}

/* ---------------------------------- lifecycle ---------------------------------- */
const bedKey = (x, y, z) => x + ',' + y + ',' + z;

// Register from the FOOT cell. facing points foot -> head.
function registerBed(x, y, z, facing) {
  const k = bedKey(x, y, z);
  if (BEDS.has(k)) return;
  const group = new THREE.Group();
  const m = bedMattressMesh();
  const legs = bedUndersideMesh();
  group.add(m.mesh);
  group.add(legs.mesh);
  // geometry is authored along +Z; rotate the whole group onto the actual facing
  group.position.set(x, y, z);
  group.rotation.y = [0, Math.PI, Math.PI / 2, -Math.PI / 2][facing & 3];
  // Rotating about the cell corner swings the body off its cells, so shift it back.
  // Ry maps local (x,z) -> (x·cosθ + z·sinθ, −x·sinθ + z·cosθ); solving each facing for
  // "box must cover the foot cell and the head cell" gives these offsets.
  const off = [[0, 0], [1, 1], [0, 1], [1, 0]][facing & 3];
  group.position.x += off[0];
  group.position.z += off[1];
  scene.add(group);
  BEDS.set(k, { group, x, y, z, facing, mats: [...m.mats, ...legs.mats], lastB: -1 });
}

function removeBedMesh(k) {
  const b = BEDS.get(k);
  if (!b) return;
  scene.remove(b.group);
  for (const c of b.group.children) c.geometry.dispose();
  for (const mt of b.mats) mt.dispose();
  BEDS.delete(k);
}
function clearBeds() { for (const k of [...BEDS.keys()]) removeBedMesh(k); }

// the FOOT cell of the bed that owns (x,y,z), or null
function bedFootOf(x, y, z) {
  const val = getBlock(x, y, z);
  if ((val & 255) !== B.BED) return null;
  const varb = (val >> 8) & 255;
  if (!(varb & 8)) return { x, y, z, facing: varb & 3 };     // already the foot
  const d = BED_DIR[varb & 3];
  const fx = x - d[0], fz = z - d[1];
  if ((getBlock(fx, y, fz) & 255) !== B.BED) return null;
  return { x: fx, y, z: fz, facing: varb & 3 };
}

// one half broken/replaced: drop the mesh and take the other half with it
function bedBroken(x, y, z, oldVal) {
  const varb = (oldVal >> 8) & 255;
  const d = BED_DIR[varb & 3];
  const isHead = (varb & 8) !== 0;
  const fx = isHead ? x - d[0] : x;
  const fz = isHead ? z - d[1] : z;
  removeBedMesh(bedKey(fx, y, fz));
  const ox = isHead ? x - d[0] : x + d[0];
  const oz = isHead ? z - d[1] : z + d[1];
  if ((getBlock(ox, y, oz) & 255) === B.BED) setBlock(ox, y, oz, B.AIR);
}

/* ---------------------------------- placement ---------------------------------- */
// Called from doPlace. Needs two free cells on solid ground; lays the foot under the player
// and the head one cell further along the facing.
function tryPlaceBed(px, py, pz) {
  // Facing points foot -> head, and the bed reads correctly when the head lands on the player's
  // side — same block-toward-player convention the door and chest use. Measuring player -> block
  // instead put the whole bed the other way round.
  const ddx = player.pos.x - (px + 0.5), ddz = player.pos.z - (pz + 0.5);
  const facing = Math.abs(ddx) > Math.abs(ddz) ? (ddx > 0 ? 2 : 3) : (ddz > 0 ? 0 : 1);
  const d = BED_DIR[facing];
  const hx = px + d[0], hz = pz + d[1];
  // grass counts as free for BOTH cells — checked before anything is written, so a bed never
  // mows one cell of grass and then bails because the other end was blocked
  const free = (x, z) => isPlaceableInto(getBlock(x, py, z) & 255) && isSolid(x, py - 1, z);
  if (!free(px, pz) || !free(hx, hz)) { toast('no room for the bed'); return false; }
  clearPlantAt(px, py, pz);
  clearPlantAt(hx, py, hz);
  setBlock(px, py, pz, B.BED | (facing << 8));
  setBlock(hx, py, hz, B.BED | ((facing | 8) << 8));
  registerBed(px, py, pz, facing);
  return true;
}

/* ---------------------------------- sleeping ---------------------------------- */
// night runs from dusk to dawn; worldTime is 0 = sunrise, .25 noon, .5 sunset, .75 midnight
const BED_NIGHT_FROM = 0.48;
const BED_WAKE_TIME = 0.005;       // just after sunrise
let _sleepFade = 0, _sleeping = false;

const _sleepEl = document.createElement('div');
_sleepEl.id = 'sleepOverlay';
Object.assign(_sleepEl.style, {
  position: 'fixed', inset: '0', background: '#000', opacity: '0',
  pointerEvents: 'none', zIndex: '20', transition: 'none', display: 'none',
});
document.body.appendChild(_sleepEl);

const isNightForSleep = () => worldTime >= BED_NIGHT_FROM;

// right-click a bed: fade out, skip to dawn, set the respawn point
function trySleep(x, y, z) {
  const foot = bedFootOf(x, y, z);
  if (!foot) return false;
  if (_sleeping) return true;
  if (!isNightForSleep()) { toast('you can only sleep at night'); return true; }
  const dx = player.pos.x - (x + 0.5), dz = player.pos.z - (z + 0.5);
  if (dx * dx + dz * dz > 25) { toast('bed is too far away'); return true; }
  _sleeping = true;
  _sleepFade = 0;
  _sleepEl.style.display = 'block';
  // sleeping here makes this your respawn point
  player.spawnPos = new THREE.Vector3(foot.x + 0.5, y, foot.z + 0.5);
  return true;
}

// fade to black, jump the clock, fade back in
function updateBed(dt) {
  for (const [k, b] of BEDS) {
    const c = getChunk(Math.floor(b.x / 16), Math.floor(b.z / 16));
    if (!c || !c.data) { b.group.visible = false; continue; }
    if ((getBlock(b.x, b.y, b.z) & 255) !== B.BED) { removeBedMesh(k); continue; }
    b.group.visible = true;
    // tint by world light at the bed cell (same approximation the doors use)
    const bl = getLightWorld(b.x, b.y, b.z) / 15;
    const sky = getSkyWorld(b.x, b.y, b.z) / 15;
    const skyF = 0.24 + 0.76 * sky * sky;   // must track the chunk shader in 04-materials.js
    const sun = sharedUniforms.uAmbient.value + sharedUniforms.uDirect.value;
    const br = Math.min(1, skyF * sun * 0.92 + (bl * 0.45 + bl * bl * 0.85));
    if (Math.abs(br - b.lastB) > 0.02) {
      b.lastB = br;
      for (const mt of b.mats) mt.color.setScalar(br).convertSRGBToLinear();
    }
  }

  if (!_sleeping) {
    if (_sleepFade > 0) {                       // fading back in after waking
      _sleepFade = Math.max(0, _sleepFade - dt * 1.6);
      _sleepEl.style.opacity = _sleepFade.toFixed(3);
      if (_sleepFade <= 0) _sleepEl.style.display = 'none';
    }
    return;
  }
  _sleepFade = Math.min(1, _sleepFade + dt * 2.2);
  _sleepEl.style.opacity = _sleepFade.toFixed(3);
  if (_sleepFade >= 1) {                        // fully black: advance to dawn and wake up
    worldDay++;
    worldTime = BED_WAKE_TIME;
    player.food = Math.max(player.food, 6);     // a night's rest staves off starving
    if (player.hp > 0) player.hp = Math.min(MAX_HP, player.hp + 4);
    _sleeping = false;
    toast('Good morning');
  }
}
