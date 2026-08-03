'use strict';
/* voxiCraft — humanoid entities + third-person camera

   The player and the wandering NPCs share one model builder: a Minecraft-layout 64x64 skin
   (textures/Entity/player.png) mapped onto six boxes with per-face UVs. Limbs hang off pivot
   groups so a single walk phase drives the swing.

   NPCs are NEUTRAL: they wander until something hurts them, then they chase and hit back.
   Each carries a small randomly-rolled survival inventory that spills on death, on top of a
   guaranteed loot entry. */

/* ================================ skin + model ================================ */
const SKIN_PX = 64;                                  // skin is 64x64
const MODEL_PX = 32;                                 // model is 32px tall (head 8 + body 12 + legs 12)
const PX = 1.8 / MODEL_PX;                           // world units per skin pixel (player.H = 1.8)

const _skinTex = new THREE.TextureLoader().load('textures/Entity/player.png');
_skinTex.colorSpace = THREE.SRGBColorSpace;
_skinTex.magFilter = THREE.NearestFilter;
_skinTex.minFilter = THREE.NearestFilter;
_skinTex.generateMipmaps = false;
// Every humanoid owns its material so it can be lit (and hurt-flashed) independently. The skin
// is a MeshBasicMaterial — it never sees the world shader's lighting — so brightness is baked
// into the material colour each frame from the sky/block light at the entity's own cell.
function _newSkinMat() {
  return new THREE.MeshBasicMaterial({ map: _skinTex, transparent: true, alphaTest: 0.5 });
}
const _HURT_COL = new THREE.Color(0xff6a6a).convertSRGBToLinear();
// light at a cell -> 0..1 brightness, matching the world shader's day/night response
function _lightAt(x, y, z) {
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  const sky = getSkyWorld(bx, by, bz) / 15;
  const blk = getLightWorld(bx, by, bz) / 15;
  const amb = sharedUniforms.uAmbient.value, dir = sharedUniforms.uDirect.value;
  const daylight = (amb + dir * sky) * sky;
  return Math.min(1, Math.max(0.12, Math.max(daylight, blk * 0.95)));
}

/* Write the six MC skin regions into a BoxGeometry's uv attribute.
   Box faces come in the order [+X, -X, +Y, -Y, +Z, -Z]. The model faces +Z, so +Z is the
   character's front and its right hand sits on -X — that is why -X takes the skin's "right"
   region and +X takes "left". Region layout for a w x h x d part based at (u,v):
     right (u, v+d)  top (u+d, v)  left (u+d+w, v+d)  bottom (u+d+w, v)
     front (u+d, v+d)  back (u+2d+w, v+d)                                        */
function _skinUV(geo, w, h, d, u, v) {
  const uv = geo.attributes.uv;
  const put = (face, px, py, pw, ph) => {
    const u0 = px / SKIN_PX, u1 = (px + pw) / SKIN_PX;
    const v0 = 1 - (py + ph) / SKIN_PX, v1 = 1 - py / SKIN_PX;
    const o = face * 4;
    uv.setXY(o + 0, u0, v1); uv.setXY(o + 1, u1, v1);
    uv.setXY(o + 2, u0, v0); uv.setXY(o + 3, u1, v0);
  };
  put(0, u + d + w, v + d, d, h);          // +X = character's left side
  put(1, u,         v + d, d, h);          // -X = character's right side
  put(2, u + d,     v,     w, d);          // +Y top
  put(3, u + d + w, v,     w, d);          // -Y bottom
  put(4, u + d,     v + d, w, h);          // +Z front
  put(5, u + 2 * d + w, v + d, w, h);      // -Z back
  uv.needsUpdate = true;
}
function _part(mat, w, h, d, u, v) {
  const geo = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  _skinUV(geo, w, h, d, u, v);
  return new THREE.Mesh(geo, mat);
}
// A limb pivots at its TOP, so the mesh is pushed half its length below the pivot group.
function _limb(mat, w, h, d, u, v) {
  const g = new THREE.Group();
  const m = _part(mat, w, h, d, u, v);
  m.position.y = -h * PX / 2;
  g.add(m);
  return g;
}

// Full humanoid. Returns the root group plus the pieces the animator needs.
function buildHumanoid() {
  const root = new THREE.Group();
  const mat = _newSkinMat();
  const head = _part(mat, 8, 8, 8, 0, 0);
  head.position.y = 28 * PX;                          // 12 legs + 12 body + 4 (half head)
  const body = _part(mat, 8, 12, 4, 16, 16);
  body.position.y = 18 * PX;                          // 12 legs + 6
  const armR = _limb(mat, 4, 12, 4, 40, 16);          // character's right = -X
  armR.position.set(-6 * PX, 24 * PX, 0);
  const armL = _limb(mat, 4, 12, 4, 32, 48);
  armL.position.set(6 * PX, 24 * PX, 0);
  const legR = _limb(mat, 4, 12, 4, 0, 16);
  legR.position.set(-2 * PX, 12 * PX, 0);
  const legL = _limb(mat, 4, 12, 4, 16, 48);
  legL.position.set(2 * PX, 12 * PX, 0);
  root.add(head, body, armR, armL, legR, legL);
  return { root, head, body, armR, armL, legR, legL, mat, mats: [mat] };
}

// walk cycle + head aim, shared by the local player model and every NPC.
// `atk` (0..1) overlays a downward chopping swing on the right arm.
function animateHumanoid(m, phase, swing, pitch, atk = 0) {
  const s = Math.sin(phase) * swing;
  const c = Math.sin(phase + Math.PI) * swing;
  m.armR.rotation.x = s;  m.armL.rotation.x = c;
  m.legR.rotation.x = c;  m.legL.rotation.x = s;
  m.head.rotation.x = pitch;
  if (atk > 0) {
    // arm winds up over the first third of the window, then chops through
    const t = 1 - atk;                                   // 0 at swing start -> 1 at the end
    m.armR.rotation.x = -2.5 + Math.sin(Math.min(1, t * 1.4) * Math.PI) * 2.2;
    m.armR.rotation.z = -0.25 * atk;
  } else {
    m.armR.rotation.z = 0;
  }
}
// Bake world lighting (and the hurt flash) into this model's own material(s).
function shadeHumanoid(m, x, y, z, hurt) {
  const b = _lightAt(x, y + 1.0, z);          // sample around chest height
  for (const mat of (m.mats || [m.mat])) {
    if (!mat) continue;
    if (hurt) mat.color.setRGB(_HURT_COL.r * b, _HURT_COL.g * b, _HURT_COL.b * b);
    else mat.color.setScalar(b);
  }
}

/* ================================ sheep ================================
   Separate skin (textures/Entity/sheep.png) painted BARE — the fleece is not part of it.
   Wool is drawn as two oversized boxes wrapped around the body and head, textured from the
   wool block tile, so shearing/regrowing is just a visibility + scale change on those boxes. */
const _sheepTex = new THREE.TextureLoader().load('textures/Entity/sheep.png');
_sheepTex.colorSpace = THREE.SRGBColorSpace;
_sheepTex.magFilter = THREE.NearestFilter;
_sheepTex.minFilter = THREE.NearestFilter;
_sheepTex.generateMipmaps = false;
function _newSheepMat() {
  return new THREE.MeshBasicMaterial({ map: _sheepTex, transparent: true, alphaTest: 0.5 });
}
// wool material reuses the block atlas source image; built lazily because IMAGES is only
// populated once buildAtlas() has resolved
let _woolTex = null;
function _newWoolMat() {
  if (!_woolTex && IMAGES && IMAGES.wool) {
    _woolTex = new THREE.Texture(IMAGES.wool);
    _woolTex.colorSpace = THREE.SRGBColorSpace;
    _woolTex.magFilter = THREE.NearestFilter;
    _woolTex.minFilter = THREE.NearestFilter;
    _woolTex.generateMipmaps = false;
    _woolTex.needsUpdate = true;
  }
  return new THREE.MeshBasicMaterial({ map: _woolTex || null, color: _woolTex ? 0xffffff : 0xf2f2f2 });
}

function _sheepPart(mat, w, h, d, u, v) {
  const geo = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  _skinUV(geo, w, h, d, u, v);
  return new THREE.Mesh(geo, mat);
}
function _sheepLeg(mat, u, v) {
  const g = new THREE.Group();
  const m = _sheepPart(mat, 4, 12, 4, u, v);
  m.position.y = -6 * PX;                       // pivots at the hip
  g.add(m);
  return g;
}
/* Body is 8w x 6h x 16d and faces +Z like the humanoids. Texture regions (see mksheep):
   body base (0,0), head base (0,24), leg base (26,24) — one leg atlas shared by all four. */
function buildSheep() {
  const root = new THREE.Group();
  const mat = _newSheepMat();
  const wmat = _newWoolMat();
  const body = _sheepPart(mat, 8, 6, 16, 0, 0);
  body.position.set(0, 15 * PX, 0);
  const head = _sheepPart(mat, 6, 6, 6, 0, 24);
  head.position.set(0, 16 * PX, 11 * PX);
  const legFL = _sheepLeg(mat, 26, 24); legFL.position.set(-3 * PX, 12 * PX,  5 * PX);
  const legFR = _sheepLeg(mat, 26, 24); legFR.position.set( 3 * PX, 12 * PX,  5 * PX);
  const legBL = _sheepLeg(mat, 26, 24); legBL.position.set(-3 * PX, 12 * PX, -5 * PX);
  const legBR = _sheepLeg(mat, 26, 24); legBR.position.set( 3 * PX, 12 * PX, -5 * PX);
  // fleece: plain boxes a little larger than the parts they cover
  const woolBody = new THREE.Mesh(new THREE.BoxGeometry(10 * PX, 8 * PX, 17 * PX), wmat);
  woolBody.position.copy(body.position);
  const woolHead = new THREE.Mesh(new THREE.BoxGeometry(7 * PX, 5 * PX, 5 * PX), wmat);
  woolHead.position.set(0, 18 * PX, 9 * PX);
  root.add(body, head, legFL, legFR, legBL, legBR, woolBody, woolHead);
  return { root, head, body, legs: [legFL, legFR, legBL, legBR],
           wool: [woolBody, woolHead], mat, wmat, mats: [mat, wmat] };
}
function animateSheep(m, phase, swing, headPitch) {
  const s = Math.sin(phase) * swing, c = Math.sin(phase + Math.PI) * swing;
  m.legs[0].rotation.x = s;  m.legs[1].rotation.x = c;   // front pair alternates
  m.legs[2].rotation.x = c;  m.legs[3].rotation.x = s;   // back pair mirrors it
  m.head.rotation.x = headPitch;
}

/* ================================ third-person view ================================ */
// 0 = first person, 1 = over the shoulder, 2 = looking back at the face
let camView = 0;
const _selfModel = buildHumanoid();
_selfModel.root.visible = false;
scene.add(_selfModel.root);
let _selfPhase = 0, _selfPrevX = 0, _selfPrevZ = 0;

/* Held item in the third-person right hand. Reuses the drop geometry (same meshes the
   first-person hand uses) parented to the arm pivot so it swings with the walk cycle. */
/* Held blocks use the world voxel shader, which reads the live day/night uniforms — in a hand
   that made the item almost black at night. These clones freeze their own uniform set at
   full-bright with shadows and fog off, so a carried block stays readable like the
   first-person one does. Cloned lazily so the atlas texture is already assigned. */
const _brightMats = [];
function _brightMat(p) {
  if (_brightMats[p]) return _brightMats[p];
  const m = MATERIALS[p].clone();                 // ShaderMaterial.clone deep-copies uniforms
  m.uniforms.uAmbient.value = 1.0;
  m.uniforms.uDirect.value = 0.0;
  m.uniforms.uShadowOn.value = 0.0;
  m.uniforms.uLightColor.value.set(1, 1, 1);
  if (m.uniforms.fogNear) m.uniforms.fogNear.value = 1e6;
  if (m.uniforms.fogFar) m.uniforms.fogFar.value = 1e7;
  _brightMats[p] = m;
  return m;
}

const _selfHeld = new THREE.Group();
_selfModel.armR.add(_selfHeld);
let _selfHeldId = undefined;
function _syncSelfHeld() {
  const id = slotId(HOTBAR[hotbarSel]);
  if (id === _selfHeldId) return;
  _selfHeldId = id;
  while (_selfHeld.children.length) _selfHeld.remove(_selfHeld.children[0]);
  if (id == null) return;
  const isItem = id >= 256;
  const isTool = isItem && !!ITEM_PROPS[id]?.tool;
  // Sit the object at the fist and tip it FORWARD (out of the chest) so the pose reads as
  // actually gripping it. Tools get the same handle-first treatment as the first-person view:
  // the sprite's lower-left corner is slid onto the pivot and the shaft runs out of the fist.
  _selfHeld.position.set(0, -11.5 * PX, isItem ? 1.5 * PX : 3.0 * PX);
  _selfHeld.scale.setScalar(isTool ? 0.42 : isItem ? 0.42 * 0.70 : 0.42 * 0.50);
  if (isTool) _selfHeld.rotation.set(-0.30, Math.PI, Math.PI / 4);
  else _selfHeld.rotation.set(isItem ? -0.55 : -0.35, isItem ? Math.PI : 0.4, isItem ? 0.35 : 0);
  const passes = buildDropGeom(id);
  const isCross = !isItem && PROPS[id]?.model === 'cross';
  let target = _selfHeld;
  if (isTool) {
    const g = new THREE.Group();
    g.position.set(0.42, 0.42, 0);
    _selfHeld.add(g);
    target = g;
  } else if (isCross) {
    const g = new THREE.Group();
    g.position.y = 0.35;
    _selfHeld.add(g);
    target = g;
  }
  for (const { p, geo, mat: mo } of passes)
    target.add(new THREE.Mesh(geo, mo || _brightMat(p)));
}

function cycleCameraView() {
  camView = (camView + 1) % 3;
  toast(camView === 0 ? 'First person' : camView === 1 ? 'Third person' : 'Third person (front)');
}

// March out from the eye until a solid block is hit, so the camera never ends up inside terrain.
function _camPullback(ox, oy, oz, dx, dy, dz, want) {
  for (let t = 0.25; t <= want; t += 0.15) {
    if (isSolid(Math.floor(ox + dx * t), Math.floor(oy + dy * t), Math.floor(oz + dz * t)))
      return Math.max(0, t - 0.3);
  }
  return want;
}

// Called from the frame loop right after the first-person camera transform is set.
function applyCameraView(dt) {
  const show = camView !== 0 && !menuScene && player.spawned;
  _selfModel.root.visible = show;
  if (show) {
    const dx = player.pos.x - _selfPrevX, dz = player.pos.z - _selfPrevZ;
    const spd = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
    _selfPhase += Math.min(spd, 9) * dt * 2.2;
    const swing = Math.min(spd / 5.5, 1) * 0.72;
    _selfModel.root.position.set(player.pos.x, player.pos.y, player.pos.z);
    _selfModel.root.rotation.y = player.yaw + Math.PI;   // model faces +Z, yaw 0 looks -Z
    animateHumanoid(_selfModel, _selfPhase, swing, -player.pitch * 0.6);
    _syncSelfHeld();
    // holding something raises the arm out in front and tracks pitch, so the third-person pose
    // matches what the first-person view shows instead of leaving the item hanging at the hip
    if (_selfHeldId != null) {
      _selfModel.armR.rotation.x -= 1.05 + player.pitch * 0.45;
      _selfModel.armR.rotation.z = -0.18;
    } else {
      _selfModel.armR.rotation.z = 0;
    }
    shadeHumanoid(_selfModel, player.pos.x, player.pos.y, player.pos.z, false);
  }
  _selfPrevX = player.pos.x; _selfPrevZ = player.pos.z;
  if (camView === 0) return;

  const eye = camera.position;
  // camera-space backward vector, then pulled to whichever side this view wants
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const sign = camView === 1 ? 1 : -1;
  const d = _camPullback(eye.x, eye.y, eye.z, back.x * sign, back.y * sign, back.z * sign, 3.6);
  eye.set(eye.x + back.x * sign * d, eye.y + back.y * sign * d, eye.z + back.z * sign * d);
  if (camView === 2) camera.rotation.set(-player.pitch, player.yaw + Math.PI, 0);
}

/* ================================ NPC entities ================================ */
const ENTITIES = [];
const ENT_MAX = 3;                       // population cap around the player
const ENT_R = 0.3, ENT_H = 1.8;
const ENT_HP = 20;
const ENT_SPEED = 2.2, ENT_CHASE_SPEED = 4.0;
const ENT_GRAVITY = 26, ENT_JUMP = 7.6;
const ENT_ATTACK_DMG = 3, ENT_ATTACK_CD = 1.0, ENT_ATTACK_RANGE = 2.2;
const ENT_AGGRO_TIME = 12, ENT_AGGRO_RANGE = 18;
const ENT_DESPAWN_DIST = 256;
const ENT_NAMES = ['Wanderer', 'Drifter', 'Stray', 'Nomad', 'Traveller'];
const ENT_THINK_TIME = 0.3;              // beat between being provoked and starting to fight back
const ENT_KNOCK = 0.5, ENT_KNOCK_HOP = 6.2;
const ENT_KNOCK_DECAY = 7.0;             // how fast the knockback velocity bleeds off
const ENT_ATK_ANIM = 0.35;               // arm-swing window when a mob lands a hit
const ENT_FLAIL_TIME = 0.6;              // arms/legs thrash for this long after taking damage
const ENT_PUSH = 3.2;                    // separation force between overlapping bodies
const PLY_KNOCK = 6.5, PLY_KNOCK_HOP = 4.2, PLY_KNOCK_DECAY = 6.0;
const ENT_HAZARD_CD = 0.5;               // seconds between lava / cactus ticks
const ENT_LAVA_DMG = 4, ENT_CACTUS_DMG = 1, ENT_DROWN_DMG = 2;
const ENT_AIR_MAX = 12;                  // seconds underwater before drowning starts
const ENT_HOME_RANGE = 200;              // never wanders further than this from its spawn point
// Only these biomes support a spawn; the leash keeps them roughly in that region afterwards.
const ENT_BIOMES = new Set(['Plains', 'Forest', 'Birch Forest']);

// Guaranteed loot — every NPC always leaves this behind, independent of its inventory.
const ENT_LOOT = [{ id: () => ITEM.FEATHER, min: 1, max: 3 },{ id: () => ITEM.BREAD, min: 1, max: 3 }];
// Pool the random carried inventory is rolled from: only things obtainable in survival.
const ENT_CARRY_POOL = [
  { id: () => B.COBBLE,           min: 2, max: 7  },
  { id: () => B.PLANKS,           min: 1, max: 5  },
  { id: () => B.DIRT,             min: 2, max: 9  },
  { id: () => B.TORCH,            min: 1, max: 4  },
  { id: () => B.SAND,             min: 1, max: 5  },
  { id: () => ITEM.COAL,          min: 1, max: 3  },
  { id: () => ITEM.COAL_CHUNK,    min: 1, max: 5  },
  { id: () => ITEM.IRON_INGOT,    min: 1, max: 2  },
  { id: () => ITEM.APPLE,         min: 1, max: 2  },
  { id: () => ITEM.GLOW_DUST,     min: 1, max: 2  },
  { id: () => ITEM.STICK,         min: 1, max: 4  },
  { id: () => ITEM.WOODEN_PICKAXE, min: 1, max: 1 },
  { id: () => ITEM.STONE_PICKAXE,  min: 1, max: 1 },
  { id: () => ITEM.STONE_SHOVEL,   min: 1, max: 1 },
  { id: () => ITEM.WOODEN_HATCHET,  min: 1, max: 1 },
  { id: () => ITEM.IRON_PICKAXE,   min: 1, max: 1 },
];
const _ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/* ---- sheep: passive grazers. They never attack; being hit makes them bolt. ---- */
const SHEEP_MAX = 4;
const SHEEP_HP = 8;
const SHEEP_SPEED = 2.0, SHEEP_FLEE_SPEED = 5.2;
const SHEEP_FLEE_TIME = 6;
const SHEEP_H = 1.3;                     // shorter than a humanoid
const SHEEP_REGROW = 10;                 // seconds for the fleece to grow back once it starts
const SHEEP_GRAZE_CD = 5;                // how often a shorn sheep looks for grass to eat
const SHEEP_GRAZE_CHANCE = 0.25;
const SHEEP_BIOMES = new Set(['Plains', 'Forest', 'Birch Forest']);

function _rollInventory() {
  const inv = [];
  const n = _ri(1, 4);
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const e = ENT_CARRY_POOL[Math.floor(Math.random() * ENT_CARRY_POOL.length)];
    const id = e.id();
    if (id == null || used.has(id)) continue;      // no duplicate stacks in one pack
    used.add(id);
    inv.push({ id, count: _ri(e.min, e.max) });
  }
  return inv;
}

function spawnEntity(x, y, z, opts = {}) {
  const m = buildHumanoid();
  m.root.position.set(x, y, z);
  scene.add(m.root);
  const ent = {
    model: m, x, y, z, vy: 0, yaw: Math.random() * Math.PI * 2,
    hp: opts.hp != null ? opts.hp : ENT_HP, onGround: false,
    state: 'wander', wanderT: 0, walk: 0, hurtT: 0,
    aggroT: 0, atkCd: 0, jumpCd: 0, thinkT: 0,
    kx: 0, kz: 0, hazCd: 0, airT: ENT_AIR_MAX, escapeT: 0, turnCd: 0,
    atkAnimT: 0, flailT: 0,
    hx: opts.hx != null ? opts.hx : x,        // home anchor — the leash centre, persisted
    hz: opts.hz != null ? opts.hz : z,
    name: opts.name || ENT_NAMES[Math.floor(Math.random() * ENT_NAMES.length)],
    inventory: opts.inventory || _rollInventory(),
    kind: 'npc',
  };
  ENTITIES.push(ent);
  return ent;
}

function spawnSheep(x, y, z, opts = {}) {
  const m = buildSheep();
  m.root.position.set(x, y, z);
  scene.add(m.root);
  const woolly = opts.woolly !== undefined ? opts.woolly : true;
  const ent = {
    model: m, x, y, z, vy: 0, yaw: Math.random() * Math.PI * 2,
    hp: opts.hp != null ? opts.hp : SHEEP_HP, onGround: false,
    state: 'wander', wanderT: 0, walk: 0, hurtT: 0,
    fleeT: 0, jumpCd: 0, kx: 0, kz: 0, hazCd: 0, airT: ENT_AIR_MAX,
    escapeT: 0, turnCd: 0, flailT: 0,
    woolly,                                   // fleece present -> shearable, drops wool
    woolGrow: woolly ? 1 : 0,                 // 0..1 regrow animation
    regrowing: false,
    grazeCd: SHEEP_GRAZE_CD,
    hx: opts.hx != null ? opts.hx : x,
    hz: opts.hz != null ? opts.hz : z,
    inventory: [],
    kind: 'sheep',
    name: 'Sheep',
  };
  ENTITIES.push(ent);
  return ent;
}

function _removeEntity(i) {
  scene.remove(ENTITIES[i].model.root);
  ENTITIES.splice(i, 1);
}
function clearEntities() { while (ENTITIES.length) _removeEntity(ENTITIES.length - 1); }

// AABB test against solid voxels for a candidate position
function _entBlocked(x, y, z) {
  const x0 = Math.floor(x - ENT_R), x1 = Math.floor(x + ENT_R);
  const z0 = Math.floor(z - ENT_R), z1 = Math.floor(z + ENT_R);
  // NO epsilon on the bottom edge. A +0.02 lift meant a mob resting exactly on a block top
  // tested the AIR cell it stands in rather than the floor, so gravity pulled it ~0.02 down
  // every frame until the check finally caught and snapped it back — a permanent shake, and
  // onGround stayed false, which also killed the knockback hop.
  const y0 = Math.floor(y), y1 = Math.floor(y + ENT_H - 0.02);
  for (let yy = y0; yy <= y1; yy++)
    for (let zz = z0; zz <= z1; zz++)
      for (let xx = x0; xx <= x1; xx++)
        if (isSolid(xx, yy, zz)) return true;
  return false;
}

// Cells a mob refuses to walk into. Lava and cactus hurt; deep-ish water is avoided so they
// don't wander out to sea and drown. Checked against the two cells the body occupies.
function _entHazard(x, y, z) {
  for (let dy = 0; dy <= 1; dy++) {
    const id = getBlock(Math.floor(x), Math.floor(y + dy), Math.floor(z)) & 255;
    if (id === B.LAVA || id === B.CACTUS) return true;
  }
  // a step that would drop the feet into water counts as a hazard too
  if ((getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) & 255) === B.WATER) return true;
  return false;
}

function _entDropLoot(ent) {
  const bx = Math.floor(ent.x), by = Math.floor(ent.y + 0.5), bz = Math.floor(ent.z);
  const pop = (id, n) => {
    for (let i = 0; i < n; i++)
      spawnDrop(id, bx, by, bz, {
        x: (Math.random() - 0.5) * 3.5, y: 2.4 + Math.random() * 1.6, z: (Math.random() - 0.5) * 3.5,
      }, 0.6);
  };
  if (ent.kind === 'sheep') {
    pop(ITEM.MUTTON, _ri(1, 3));
    if (ent.woolly) { pop(B.WOOL, 1); pop(ITEM.STRING, _ri(1, 3)); }
    return;
  }
  for (const l of ENT_LOOT) { const id = l.id(); if (id != null) pop(id, _ri(l.min, l.max)); }
  for (const s of ent.inventory) pop(s.id, s.count);
}

/* Right-clicking a woolly sheep with shears takes the fleece: drops 1-3 wool, leaves the sheep
   shorn so it starts looking for grass to eat. Called from doPlace before block placement. */
function tryShearSheep() {
  const held = slotId(HOTBAR[hotbarSel]);
  if (held == null || held < 256 || ITEM_PROPS[held]?.tool !== 'shears') return false;
  const ent = pickEntity();
  if (!ent || ent.kind !== 'sheep' || !ent.woolly) return false;
  ent.woolly = false;
  ent.woolGrow = 0;
  ent.regrowing = false;
  ent.grazeCd = SHEEP_GRAZE_CD;
  const bx = Math.floor(ent.x), by = Math.floor(ent.y + 0.5), bz = Math.floor(ent.z);
  const n = _ri(1, 3);
  for (let i = 0; i < n; i++)
    spawnDrop(B.WOOL, bx, by, bz, {
      x: (Math.random() - 0.5) * 2.5, y: 2.2 + Math.random(), z: (Math.random() - 0.5) * 2.5,
    }, 0.5);
  const slot = HOTBAR[hotbarSel];
  if (!player.canFly && slot && slot.dur != null) {
    slot.dur--;
    if (slot.dur <= 0) { HOTBAR[hotbarSel] = null; toast(`${ITEM_PROPS[slot.id].name} broke`); }
    saveHotbar(); buildHotbar(); updateHotbar();
  }
  return true;
}

function damageEntity(ent, dmg) {
  ent.hp -= dmg;
  ent.hurtT = 0.25;
  ent.flailT = ENT_FLAIL_TIME;                   // limbs thrash on impact even while standing
  // Sheep are passive: they bolt rather than retaliate.
  if (ent.kind === 'sheep') {
    if (!player.canFly) ent.fleeT = SHEEP_FLEE_TIME;
    if (ent.hp <= 0) {
      if (!player.canFly) _entDropLoot(ent);
      const i = ENTITIES.indexOf(ent);
      if (i >= 0) _removeEntity(i);
      return true;
    }
    return false;
  }
  // Creative is a build mode: mobs never turn hostile and never leave loot behind.
  if (!player.canFly) {
    ent.aggroT = ENT_AGGRO_TIME;               // neutral until provoked — this is the provocation
    if (ent.state !== 'chase') ent.thinkT = ENT_THINK_TIME;   // beat of confusion before it reacts
    ent.state = 'chase';
  }
  if (ent.hp <= 0) {
    if (!player.canFly) _entDropLoot(ent);
    const i = ENTITIES.indexOf(ent);
    if (i >= 0) _removeEntity(i);
    return true;
  }
  return false;
}

/* Ray from the camera against every entity's AABB — used by the attack hook so hitting a mob
   takes priority over mining the block behind it. Returns the nearest entity within reach. */
const _atkDir = new THREE.Vector3();
const _atkOrigin = new THREE.Vector3();
function pickEntity(maxDist = 4.0) {
  camera.getWorldDirection(_atkDir);
  if (camView === 2) _atkDir.negate();     // front view: the camera looks back at the player
  // Always swing from the EYE, never from camera.position — in third person the camera has been
  // pulled several blocks backwards, which put most of the reach behind the player and made
  // hits (and therefore knockback) silently miss.
  _atkOrigin.set(player.pos.x, player.pos.y + player.EYE, player.pos.z);
  const o = _atkOrigin;
  let best = null, bestT = Infinity;
  for (const e of ENTITIES) {
    // slab test against the entity box
    const bx0 = e.x - ENT_R, bx1 = e.x + ENT_R;
    const by0 = e.y,         by1 = e.y + ENT_H;
    const bz0 = e.z - ENT_R, bz1 = e.z + ENT_R;
    let t0 = 0, t1 = maxDist, ok = true;
    for (const [ro, rd, b0, b1] of [[o.x, _atkDir.x, bx0, bx1],
                                    [o.y, _atkDir.y, by0, by1],
                                    [o.z, _atkDir.z, bz0, bz1]]) {
      if (Math.abs(rd) < 1e-6) { if (ro < b0 || ro > b1) { ok = false; break; } continue; }
      let ta = (b0 - ro) / rd, tb = (b1 - ro) / rd;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) { ok = false; break; }
    }
    if (ok && t0 < bestT) { bestT = t0; best = e; }
  }
  return best;
}

/* Attack pacing. A bare hand needs HAND_ATTACK_TIME between swings; a weapon's attackSpeed is a
   multiplier that shortens that (attackSpeed 2 = twice as fast). Swapping what you're holding
   re-arms the full hand delay, so you can't scroll onto a fast sword and hit instantly. */
const HAND_ATTACK_TIME = 0.5;
const HAND_DAMAGE = 1;
let _atkCooldown = 0;
let _lastHeldForAtk;
function attackCooldownFor(id) {
  const p = id != null && id >= 256 ? ITEM_PROPS[id] : null;
  const spd = p && p.attackSpeed > 0 ? p.attackSpeed : 1;
  return HAND_ATTACK_TIME / spd;
}
function attackDamageFor(id) {
  const p = id != null && id >= 256 ? ITEM_PROPS[id] : null;
  return p && p.damage > 0 ? p.damage : HAND_DAMAGE;
}
function tryAttackEntity() {
  if (_atkCooldown > 0) return false;
  const ent = pickEntity();
  if (!ent) return false;
  const held = slotId(HOTBAR[hotbarSel]);
  _atkCooldown = attackCooldownFor(held);
  const died = damageEntity(ent, attackDamageFor(held));
  // Knockback: push along player -> entity. When the two overlap that vector is ~zero and
  // normalising it produced a random direction (the occasional "pulled toward me" hit), so fall
  // back to the aim direction, which is always outward.
  if (!died) {
    let dx = ent.x - player.pos.x, dz = ent.z - player.pos.z;
    let m = Math.hypot(dx, dz);
    if (m < 0.2) { dx = _atkDir.x; dz = _atkDir.z; m = Math.hypot(dx, dz) || 1; }
    // stored as a velocity that decays over the next few frames — moving the position directly
    // read as a teleport
    ent.kx = dx / m * ENT_KNOCK * 12;
    ent.kz = dz / m * ENT_KNOCK * 12;
    // test the floor directly rather than trusting the onGround flag from the previous tick
    if (_entBlocked(ent.x, ent.y - 0.02, ent.z)) ent.vy = ENT_KNOCK_HOP;
  }
  // tools wear from swinging at mobs, same as breaking a block
  const slot = HOTBAR[hotbarSel];
  if (!player.canFly && slot && slot.dur != null) {
    slot.dur--;
    if (slot.dur <= 0) { HOTBAR[hotbarSel] = null; toast(`${ITEM_PROPS[slot.id].name} broke`); }
    saveHotbar(); buildHotbar(); updateHotbar();
  }
  return true;
}

/* ---- persistence ----
   Only entities inside the render distance are written: anything further out was never
   simulated this session, and keeping it would slowly bloat the save with stale mobs. */
function serializeEntities() {
  const out = [];
  for (const e of ENTITIES) {
    const cdx = Math.abs(Math.floor(e.x / 16) - playerCX);
    const cdz = Math.abs(Math.floor(e.z / 16) - playerCZ);
    if (cdx > viewDist || cdz > viewDist) continue;
    out.push([
      +e.x.toFixed(2), +e.y.toFixed(2), +e.z.toFixed(2),
      +e.yaw.toFixed(3), Math.max(0, +e.hp.toFixed(1)),
      e.name, e.inventory.map(s => [s.id, s.count]),
      +e.hx.toFixed(1), +e.hz.toFixed(1),
      e.kind, e.kind === 'sheep' ? (e.woolly ? 1 : 0) : 0,
    ]);
  }
  return out;
}
function restoreEntities(list) {
  if (!Array.isArray(list)) return;
  for (const r of list) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const [x, y, z, yaw, hp, name, inv, hx, hz, kind, woolly] = r;
    if (![x, y, z].every(v => typeof v === 'number' && isFinite(v))) continue;
    if (kind === 'sheep') {                    // saves written before sheep existed have no kind
      const s = spawnSheep(x, y, z, {
        hp: typeof hp === 'number' && hp > 0 ? hp : SHEEP_HP,
        woolly: !!woolly,
        hx: typeof hx === 'number' ? hx : x,
        hz: typeof hz === 'number' ? hz : z,
      });
      if (typeof yaw === 'number') s.yaw = yaw;
      continue;
    }
    const inventory = Array.isArray(inv)
      ? inv.filter(s => Array.isArray(s) && s.length === 2 && (PROPS[s[0]] || ITEM_PROPS[s[0]]))
           .map(s => ({ id: s[0], count: Math.max(1, s[1] | 0) }))
      : [];
    const ent = spawnEntity(x, y, z, {
      hp: typeof hp === 'number' && hp > 0 ? hp : ENT_HP,
      name: typeof name === 'string' ? name : undefined,
      inventory,
      hx: typeof hx === 'number' ? hx : x,
      hz: typeof hz === 'number' ? hz : z,
    });
    if (typeof yaw === 'number') ent.yaw = yaw;
  }
}

/* ---- spawning: keep a small population in the loaded ring around the player ---- */
let _spawnTimer = 0;
// find a legal, out-of-view surface spot near the player; returns {x,y,z} or null
function _findSpawnSpot(biomes) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = 14 + Math.random() * 18;
    const x = Math.floor(player.pos.x + Math.cos(a) * r) + 0.5;
    const z = Math.floor(player.pos.z + Math.sin(a) * r) + 0.5;
    const c = getChunk(Math.floor(x / 16), Math.floor(z / 16));
    if (!c || !c.data) continue;                       // never spawn into an unloaded chunk
    // never pop into view: the spot has to be behind or well to the side of the camera
    camera.getWorldDirection(_atkDir);
    const vx = x - player.pos.x, vz = z - player.pos.z;
    const vm = Math.hypot(vx, vz) || 1;
    if ((vx / vm) * _atkDir.x + (vz / vm) * _atkDir.z > 0.15) continue;
    if (!biomes.has(mainGen.biomeAt(Math.floor(x), Math.floor(z)))) continue;
    const gy = surfaceY(Math.floor(x), Math.floor(z));
    const top = getBlock(Math.floor(x), gy, Math.floor(z)) & 255;
    if (top === B.AIR || top === B.WATER || top === B.LAVA || top === B.CACTUS) continue;
    const y = gy + 1;
    if (_entBlocked(x, y, z) || _entHazard(x, y, z)) continue;
    return { x, y, z, top };
  }
  return null;
}
function _trySpawnEntity() {
  const npcs = ENTITIES.reduce((n, e) => n + (e.kind === 'npc' ? 1 : 0), 0);
  if (npcs >= ENT_MAX) return;
  const s = _findSpawnSpot(ENT_BIOMES);
  if (s) spawnEntity(s.x, s.y, s.z);
}
function _trySpawnSheep() {
  const sheep = ENTITIES.reduce((n, e) => n + (e.kind === 'sheep' ? 1 : 0), 0);
  if (sheep >= SHEEP_MAX) return;
  const s = _findSpawnSpot(SHEEP_BIOMES);
  if (!s || s.top !== B.GRASS) return;                 // grazers only appear on grass
  spawnSheep(s.x, s.y, s.z);
}

/* Player shove: mob hits and body collisions feed a decaying velocity here rather than moving
   the player outright, so being struck slides you back instead of teleporting you. */
const _plyKick = { x: 0, z: 0 };
function _movePlayerBy(dx, dz) {
  const p = player.pos;
  if (!_entBlocked(p.x + dx, p.y, p.z)) p.x += dx;
  if (!_entBlocked(p.x, p.y, p.z + dz)) p.z += dz;
}
function _updatePlayerKick(dt) {
  if (!_plyKick.x && !_plyKick.z) return;
  _movePlayerBy(_plyKick.x * dt, _plyKick.z * dt);
  const k = Math.max(0, 1 - PLY_KNOCK_DECAY * dt);
  _plyKick.x *= k; _plyKick.z *= k;
  if (Math.abs(_plyKick.x) < 0.05 && Math.abs(_plyKick.z) < 0.05) { _plyKick.x = 0; _plyKick.z = 0; }
}

/* Bodies are solid to each other: overlapping mobs (and the player) get pushed apart so nothing
   ends up standing inside anyone. Vertical overlap is required, otherwise stacked mobs on
   different floors would shove each other. */
function _separateBodies(dt) {
  const minD = ENT_R * 2, minD2 = minD * minD;
  for (let a = 0; a < ENTITIES.length; a++) {
    const e = ENTITIES[a];
    // vs other entities
    for (let b = a + 1; b < ENTITIES.length; b++) {
      const o = ENTITIES[b];
      if (Math.abs(o.y - e.y) >= ENT_H) continue;
      let dx = o.x - e.x, dz = o.z - e.z;
      let d2 = dx * dx + dz * dz;
      if (d2 >= minD2) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d = Math.hypot(dx, dz) || 1; }
      const push = (minD - d) / minD * ENT_PUSH * dt;
      const ux = dx / d * push, uz = dz / d * push;
      if (!_entBlocked(e.x - ux, e.y, e.z - uz)) { e.x -= ux; e.z -= uz; }
      if (!_entBlocked(o.x + ux, o.y, o.z + uz)) { o.x += ux; o.z += uz; }
    }
    // vs the player — creative flying passes through, survival gets shoved
    if (player.canFly && player.flying) continue;
    if (Math.abs(player.pos.y - e.y) >= ENT_H) continue;
    let dx = player.pos.x - e.x, dz = player.pos.z - e.z;
    let d2 = dx * dx + dz * dz;
    const pMin = ENT_R + player.R, pMin2 = pMin * pMin;
    if (d2 >= pMin2) continue;
    let d = Math.sqrt(d2);
    if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d = Math.hypot(dx, dz) || 1; }
    const push = (pMin - d) / pMin * ENT_PUSH * dt;
    const ux = dx / d * push, uz = dz / d * push;
    if (!_entBlocked(e.x - ux, e.y, e.z - uz)) { e.x -= ux; e.z -= uz; }
    _movePlayerBy(ux, uz);
  }
}

/* Sheep tick. Passive: wander, graze, and sprint directly away from the player after being hit.
   A shorn sheep periodically tries to eat the grass block under it — that converts the grass to
   dirt and starts the fleece growing back, which is animated by scaling the wool boxes. */
function _updateSheep(e, dt, pdx, pdz, distXZ, i) {
  if (e.flailT > 0) e.flailT -= dt;
  if (e.turnCd > 0) e.turnCd -= dt;
  if (e.fleeT > 0) e.fleeT -= dt;

  const inWater = (getBlock(Math.floor(e.x), Math.floor(e.y + 0.4), Math.floor(e.z)) & 255) === B.WATER;

  /* ---- fleece: graze to regrow, then animate it filling out ---- */
  if (!e.woolly) {
    if (e.regrowing) {
      e.woolGrow = Math.min(1, e.woolGrow + dt / SHEEP_REGROW);
      if (e.woolGrow >= 1) { e.woolly = true; e.regrowing = false; }
    } else {
      e.grazeCd -= dt;
      if (e.grazeCd <= 0) {
        e.grazeCd = SHEEP_GRAZE_CD;
        const gx = Math.floor(e.x), gy = Math.floor(e.y - 0.02), gz = Math.floor(e.z);
        if (e.onGround && (getBlock(gx, gy, gz) & 255) === B.GRASS && Math.random() < SHEEP_GRAZE_CHANCE) {
          setBlock(gx, gy, gz, B.DIRT);        // eats the turf down to bare dirt
          e.regrowing = true;
          e.woolGrow = 0;
          e.state = 'idle';
          e.wanderT = 1.2;                     // pause to chew
        }
      }
    }
  }

  /* ---- heading ---- */
  let moveSpeed = 0;
  if (inWater) {
    e.escapeT -= dt;
    if (e.escapeT <= 0) { e.escapeT = 0.8; e.yaw += 1.2; }
    moveSpeed = SHEEP_SPEED;
  } else if (e.fleeT > 0) {
    e.yaw = Math.atan2(-pdx, -pdz);            // straight away from whoever hit it
    moveSpeed = SHEEP_FLEE_SPEED;
  } else {
    e.wanderT -= dt;
    if (e.wanderT <= 0) {
      e.wanderT = 2 + Math.random() * 5;
      e.state = Math.random() < 0.45 ? 'idle' : 'wander';
      if (e.state === 'wander') e.yaw = Math.random() * Math.PI * 2;
    }
    moveSpeed = e.state === 'wander' ? SHEEP_SPEED : 0;
    const hdx = e.hx - e.x, hdz = e.hz - e.z;
    if (Math.hypot(hdx, hdz) > ENT_HOME_RANGE) {
      e.yaw = Math.atan2(hdx, hdz); e.state = 'wander'; moveSpeed = SHEEP_SPEED;
    }
  }

  /* ---- move ---- */
  let moved = 0;
  const stunned = (e.kx !== 0 || e.kz !== 0);
  if (moveSpeed > 0 && !stunned) {
    const sx = Math.sin(e.yaw) * moveSpeed * dt, sz = Math.cos(e.yaw) * moveSpeed * dt;
    const bad = (nx, nz) => _entBlocked(nx, e.y, nz) || (!inWater && _entHazard(nx, e.y, nz));
    let blocked = false;
    if (!bad(e.x + sx, e.z)) { e.x += sx; moved += Math.abs(sx); } else blocked = true;
    if (!bad(e.x, e.z + sz)) { e.z += sz; moved += Math.abs(sz); } else blocked = true;
    if (blocked && (e.onGround || inWater) && e.jumpCd <= 0 && !_entBlocked(e.x + sx, e.y + 1, e.z + sz)) {
      e.vy = ENT_JUMP; e.jumpCd = 0.6; e.onGround = false;
    } else if (blocked && e.turnCd <= 0 && !inWater) {
      e.yaw = Math.random() * Math.PI * 2; e.turnCd = 0.5;
    }
  }
  if (e.kx || e.kz) {
    const kdx = e.kx * dt, kdz = e.kz * dt;
    if (!_entBlocked(e.x + kdx, e.y, e.z)) e.x += kdx;
    if (!_entBlocked(e.x, e.y, e.z + kdz)) e.z += kdz;
    const k = Math.max(0, 1 - ENT_KNOCK_DECAY * dt);
    e.kx *= k; e.kz *= k;
    if (Math.abs(e.kx) < 0.05 && Math.abs(e.kz) < 0.05) { e.kx = 0; e.kz = 0; }
  }
  if (inWater && waterFlowVec(Math.floor(e.x), Math.floor(e.y + 0.4), Math.floor(e.z), _flowV)) {
    const fdx = _flowV.x * 1.9 * dt, fdz = _flowV.z * 1.9 * dt;
    if (!_entBlocked(e.x + fdx, e.y, e.z)) e.x += fdx;
    if (!_entBlocked(e.x, e.y, e.z + fdz)) e.z += fdz;
  }

  /* ---- hazards ---- */
  if (e.hazCd > 0) e.hazCd -= dt;
  const feetId = getBlock(Math.floor(e.x), Math.floor(e.y + 0.1), Math.floor(e.z)) & 255;
  const headId = getBlock(Math.floor(e.x), Math.floor(e.y + 1.0), Math.floor(e.z)) & 255;
  if (e.hazCd <= 0) {
    let dmg = 0;
    if (feetId === B.LAVA || headId === B.LAVA) dmg = ENT_LAVA_DMG;
    else if (feetId === B.CACTUS) dmg = ENT_CACTUS_DMG;
    if (dmg > 0) {
      e.hazCd = ENT_HAZARD_CD; e.hurtT = 0.25; e.hp -= dmg;
      if (e.hp <= 0) { if (!player.canFly) _entDropLoot(e); _removeEntity(i); return; }
    }
  }
  if (headId === B.WATER) {
    e.airT -= dt;
    if (e.airT <= 0) {
      e.airT = 1; e.hurtT = 0.25; e.hp -= ENT_DROWN_DMG;
      if (e.hp <= 0) { if (!player.canFly) _entDropLoot(e); _removeEntity(i); return; }
    }
  } else e.airT = ENT_AIR_MAX;

  /* ---- gravity ---- */
  const standing = !inWater && e.vy <= 0 && _entBlocked(e.x, e.y - 0.02, e.z);
  if (standing) {
    e.y = Math.floor(e.y - 0.02) + 1; e.vy = 0; e.onGround = true;
  } else {
    e.vy -= ENT_GRAVITY * dt;
    if (e.vy < -34) e.vy = -34;
    const ny = e.y + e.vy * dt;
    if (_entBlocked(e.x, ny, e.z)) {
      if (e.vy < 0) { e.y = Math.floor(ny) + 1; e.onGround = true; }
      e.vy = 0;
    } else { e.y = ny; e.onGround = false; }
  }
  if (inWater) { e.vy = Math.min(e.vy + 40 * dt, 4.2); e.onGround = false; }

  /* ---- visuals ---- */
  const spd = moved / Math.max(dt, 1e-4);
  let swing = Math.min(spd / 3.5, 1) * 0.7;
  if (e.flailT > 0) { e.walk += 11 * dt; swing = Math.max(swing, 0.8); }
  else e.walk += Math.min(spd, 9) * dt * 2.6;
  const m = e.model;
  m.root.position.set(e.x, e.y, e.z);
  m.root.rotation.y = e.yaw;
  // grazing dips the head toward the ground
  const graze = (!e.woolly && e.regrowing && e.woolGrow < 0.08) ? 0.9 : 0;
  animateSheep(m, e.walk, swing, graze);
  // fleece visibility/scale IS the regrow animation
  const g = e.woolly ? 1 : (e.regrowing ? Math.max(0.06, e.woolGrow) : 0);
  for (const w of m.wool) {
    w.visible = g > 0.02;
    w.scale.setScalar(g);
  }
  shadeHumanoid(m, e.x, e.y, e.z, e.hurtT > 0);
}

function updateEntities(dt) {
  if (!playing || menuScene || !player.spawned) return;
  if (_atkCooldown > 0) _atkCooldown -= dt;
  // swapping hotbar slot / item re-arms the full bare-hand delay
  const heldNow = slotId(HOTBAR[hotbarSel]);
  if (heldNow !== _lastHeldForAtk) {
    if (_lastHeldForAtk !== undefined) _atkCooldown = Math.max(_atkCooldown, HAND_ATTACK_TIME);
    _lastHeldForAtk = heldNow;
  }
  _updatePlayerKick(dt);

  _spawnTimer -= dt;
  if (_spawnTimer <= 0) {
    _spawnTimer = 4 + Math.random() * 4;
    if (Math.random() < 0.5) _trySpawnEntity(); else _trySpawnSheep();
  }

  for (let i = ENTITIES.length - 1; i >= 0; i--) {
    const e = ENTITIES[i];
    const pdx = player.pos.x - e.x, pdz = player.pos.z - e.z;
    const pdy = player.pos.y - e.y;
    const distXZ = Math.hypot(pdx, pdz);
    if (distXZ > ENT_DESPAWN_DIST || e.y < -30) { _removeEntity(i); continue; }

    if (e.hurtT > 0) e.hurtT -= dt;
    if (e.atkCd > 0) e.atkCd -= dt;
    if (e.jumpCd > 0) e.jumpCd -= dt;
    if (e.kind === 'sheep') { _updateSheep(e, dt, pdx, pdz, distXZ, i); continue; }
    if (player.canFly && (e.aggroT > 0 || e.state === 'chase')) {
      e.aggroT = 0; e.thinkT = 0; e.state = 'wander';   // switching to creative calls off the fight
    }
    if (e.aggroT > 0) {
      e.aggroT -= dt;
      if (e.aggroT <= 0 || distXZ > ENT_AGGRO_RANGE) { e.aggroT = 0; e.state = 'wander'; }
    }

    /* ---- water state: drives escape steering, swimming and current drift ---- */
    const inWater = (getBlock(Math.floor(e.x), Math.floor(e.y + 0.4), Math.floor(e.z)) & 255) === B.WATER;

    /* ---- decide a heading ---- */
    let moveSpeed = 0;
    if (inWater) {
      // Swim straight for the nearest dry land. The heading is latched for a moment so a mob
      // can't re-pick a direction every frame (that was the spin-in-place bug), and water is no
      // longer treated as an obstacle here — otherwise every step was "blocked" and it froze.
      e.escapeT -= dt;
      if (e.escapeT <= 0) {
        e.escapeT = 0.8;
        let best = null, bestD = Infinity;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          for (let r = 2; r <= 8; r++) {
            const tx = Math.floor(e.x + Math.sin(ang) * r), tz = Math.floor(e.z + Math.cos(ang) * r);
            const sy = surfaceY(tx, tz);
            const st = getBlock(tx, sy, tz) & 255;
            if (st === B.WATER || st === B.AIR || st === B.LAVA) continue;
            if (sy + 1 > e.y + 3) continue;                 // can't climb out onto a cliff
            if (r < bestD) { bestD = r; best = ang; }
            break;
          }
        }
        if (best !== null) e.yaw = best;
        else if (e.escapeT >= 0.8) e.yaw += 1.2;            // no shore found: sweep slowly, no spin
      }
      moveSpeed = ENT_SPEED;
      e.state = 'wander';
    } else if (e.thinkT > 0) {
      // just got hit: stand still and process it for a beat before turning and swinging back
      e.thinkT -= dt;
      moveSpeed = 0;
    } else if (e.state === 'chase' && !player.dead) {
      e.yaw = Math.atan2(pdx, pdz);
      moveSpeed = ENT_CHASE_SPEED;
      if (distXZ < ENT_ATTACK_RANGE && Math.abs(pdy) < 2 && e.atkCd <= 0) {
        e.atkCd = ENT_ATTACK_CD;
        e.atkAnimT = ENT_ATK_ANIM;                 // arm chops through on the hit
        moveSpeed = 0;
        player.hp -= ENT_ATTACK_DMG;
        player._dmgCause = `was slain by a ${e.name}`;
        // knock the player back with the same decaying-velocity model the mobs use
        const m = distXZ || 1;
        _plyKick.x = pdx / m * PLY_KNOCK;
        _plyKick.z = pdz / m * PLY_KNOCK;
        if (!player.flying && Math.abs(player.vy) < 0.5) player.vy = PLY_KNOCK_HOP;
      }
    } else {
      e.wanderT -= dt;
      if (e.wanderT <= 0) {
        e.wanderT = 2 + Math.random() * 4;
        e.state = Math.random() < 0.35 ? 'idle' : 'wander';
        if (e.state === 'wander') e.yaw = Math.random() * Math.PI * 2;
      }
      moveSpeed = e.state === 'wander' ? ENT_SPEED : 0;
      // leash: outside its home radius the next heading always points back, so a mob can drift
      // around its spawn region but never migrates across the world
      const hdx = e.hx - e.x, hdz = e.hz - e.z;
      if (Math.hypot(hdx, hdz) > ENT_HOME_RANGE) {
        e.yaw = Math.atan2(hdx, hdz);
        e.state = 'wander';
        moveSpeed = ENT_SPEED;
      }
    }

    /* ---- horizontal move with a hop over 1-block steps ---- */
    let moved = 0;
    // getting knocked back briefly overrides walking, so a chasing mob can't immediately
    // stride back through its own knockback and cancel it out
    const stunned = (e.kx !== 0 || e.kz !== 0);
    if (moveSpeed > 0 && !stunned) {
      const sx = Math.sin(e.yaw) * moveSpeed * dt;
      const sz = Math.cos(e.yaw) * moveSpeed * dt;
      // while swimming, water is the medium rather than an obstacle
      const bad = (nx, nz) => _entBlocked(nx, e.y, nz) || (!inWater && _entHazard(nx, e.y, nz));
      let blocked = false;
      if (!bad(e.x + sx, e.z)) { e.x += sx; moved += Math.abs(sx); } else blocked = true;
      if (!bad(e.x, e.z + sz)) { e.z += sz; moved += Math.abs(sz); } else blocked = true;
      // a wall it could clear by stepping up one block: jump instead of grinding into it
      if (blocked && (e.onGround || inWater) && e.jumpCd <= 0 && !_entBlocked(e.x + sx, e.y + 1, e.z + sz)) {
        e.vy = ENT_JUMP; e.jumpCd = 0.6; e.onGround = false;
      } else if (blocked && e.state !== 'chase' && !inWater) {
        // re-roll on the wander timer, never every frame — that produced a fast spin in place
        if (e.turnCd <= 0) { e.yaw = Math.random() * Math.PI * 2; e.turnCd = 0.5; }
      }
    }
    if (e.turnCd > 0) e.turnCd -= dt;

    /* ---- current drift: flowing water carries a mob along, same as the player and drops ---- */
    if (inWater && waterFlowVec(Math.floor(e.x), Math.floor(e.y + 0.4), Math.floor(e.z), _flowV)) {
      const fdx = _flowV.x * 1.9 * dt, fdz = _flowV.z * 1.9 * dt;
      if (!_entBlocked(e.x + fdx, e.y, e.z)) e.x += fdx;
      if (!_entBlocked(e.x, e.y, e.z + fdz)) e.z += fdz;
    }

    /* ---- knockback slide: decays away instead of snapping the position ---- */
    if (e.kx || e.kz) {
      const kdx = e.kx * dt, kdz = e.kz * dt;
      if (!_entBlocked(e.x + kdx, e.y, e.z)) e.x += kdx;
      if (!_entBlocked(e.x, e.y, e.z + kdz)) e.z += kdz;
      const k = Math.max(0, 1 - ENT_KNOCK_DECAY * dt);
      e.kx *= k; e.kz *= k;
      if (Math.abs(e.kx) < 0.05 && Math.abs(e.kz) < 0.05) { e.kx = 0; e.kz = 0; }
    }

    /* ---- environmental damage: lava burns, cactus pricks, deep water drowns ---- */
    if (e.hazCd > 0) e.hazCd -= dt;
    const feetId = getBlock(Math.floor(e.x), Math.floor(e.y + 0.1), Math.floor(e.z)) & 255;
    const headId = getBlock(Math.floor(e.x), Math.floor(e.y + 1.5), Math.floor(e.z)) & 255;
    let touchCactus = false;
    for (const [cx2, cz2] of [[1,0],[-1,0],[0,1],[0,-1]])
      if ((getBlock(Math.floor(e.x) + cx2, Math.floor(e.y + 0.9), Math.floor(e.z) + cz2) & 255) === B.CACTUS)
        { touchCactus = true; break; }
    if (e.hazCd <= 0) {
      let dmg = 0;
      if (feetId === B.LAVA || headId === B.LAVA) dmg = ENT_LAVA_DMG;
      else if (feetId === B.CACTUS || touchCactus) dmg = ENT_CACTUS_DMG;
      if (dmg > 0) {
        e.hazCd = ENT_HAZARD_CD;
        e.hurtT = 0.25;
        e.hp -= dmg;
        if (e.hp <= 0) { if (!player.canFly) _entDropLoot(e); _removeEntity(i); continue; }
      }
    }
    if (headId === B.WATER) {
      e.airT -= dt;
      if (e.airT <= 0) {
        e.airT = 1;                                   // one drown tick per second once out of air
        e.hurtT = 0.25;
        e.hp -= ENT_DROWN_DMG;
        if (e.hp <= 0) { if (!player.canFly) _entDropLoot(e); _removeEntity(i); continue; }
      }
    } else e.airT = ENT_AIR_MAX;

    /* ---- gravity + ground ---- */
    // Resting on a floor is a hard stop: don't integrate gravity at all, or the mob spends every
    // frame falling a hair and being snapped back up (the shake).
    const standing = !inWater && e.vy <= 0 && _entBlocked(e.x, e.y - 0.02, e.z);
    if (standing) {
      e.y = Math.floor(e.y - 0.02) + 1;                  // seat exactly on the block top
      e.vy = 0;
      e.onGround = true;
    } else {
      e.vy -= ENT_GRAVITY * dt;
      if (e.vy < -34) e.vy = -34;
      const ny = e.y + e.vy * dt;
      if (_entBlocked(e.x, ny, e.z)) {
        if (e.vy < 0) {
          e.y = Math.floor(ny) + 1;                      // land on the block top
          e.onGround = true;
        }
        e.vy = 0;
      } else {
        e.y = ny;
        e.onGround = false;
      }
    }
    // Swimming: buoyancy holds the mob at the surface. The rise is strong enough to actually
    // clear a shoreline block, otherwise it bobbed against the bank forever without getting out.
    if (inWater) {
      e.vy = Math.min(e.vy + 40 * dt, 4.2);
      e.onGround = false;
      // right at the edge of land, hop up onto it
      const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
      if (e.jumpCd <= 0 && _entBlocked(e.x + fx * 0.6, e.y, e.z + fz * 0.6)
          && !_entBlocked(e.x + fx * 0.6, e.y + 1, e.z + fz * 0.6)) {
        e.vy = ENT_JUMP; e.jumpCd = 0.5;
      }
    }

    /* ---- visuals ---- */
    if (e.atkAnimT > 0) e.atkAnimT -= dt;
    if (e.flailT > 0) e.flailT -= dt;
    const spd = moved / Math.max(dt, 1e-4);
    let swing = Math.min(spd / 4.5, 1) * 0.75;
    // taking a hit thrashes the limbs through the walk cycle even when standing still
    if (e.flailT > 0) {
      e.walk += 11 * dt;
      swing = Math.max(swing, 0.85);
    } else {
      e.walk += Math.min(spd, 9) * dt * 2.2;
    }
    const m = e.model;
    m.root.position.set(e.x, e.y, e.z);
    m.root.rotation.y = e.yaw;                           // model faces +Z; yaw is measured the same way
    // aggroed mobs stare at the player
    const lookPitch = e.state === 'chase'
      ? Math.max(-0.7, Math.min(0.7, -Math.atan2(pdy + 1.2, Math.max(distXZ, 0.1)) * 0.8)) : 0;
    animateHumanoid(m, e.walk, swing, lookPitch, Math.max(0, e.atkAnimT) / ENT_ATK_ANIM);
    shadeHumanoid(m, e.x, e.y, e.z, e.hurtT > 0);
  }
  _separateBodies(dt);
}
