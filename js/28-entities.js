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
const _BURN_COL = new THREE.Color(0xff8a2a).convertSRGBToLinear();   // sunlight scorch on a zombie
/* Zombie skin (textures/Entity/zombie.png): the player sheet with every skin tone pushed to
   green and the eye pixels blacked out, so the rig, UVs and animation are shared unchanged. */
const _zombieTex = new THREE.TextureLoader().load('textures/Entity/zombie.png');
_zombieTex.colorSpace = THREE.SRGBColorSpace;
_zombieTex.magFilter = THREE.NearestFilter;
_zombieTex.minFilter = THREE.NearestFilter;
_zombieTex.generateMipmaps = false;
function _newZombieMat() {
  return new THREE.MeshBasicMaterial({ map: _zombieTex, transparent: true, alphaTest: 0.5 });
}
// light at a cell -> 0..1 brightness, matching the world shader's day/night response
function _lightAt(x, y, z) {
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  const sky = getSkyWorld(bx, by, bz) / 15;
  const blk = getLightWorld(bx, by, bz) / 15;
  const amb = sharedUniforms.uAmbient.value, dir = sharedUniforms.uDirect.value;
  const daylight = (amb + dir * sky) * sky;
  return Math.min(1, Math.max(0.24, Math.max(daylight, blk * 0.95)));   // floor tracks skyF
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
// `mat` lets a variant (the zombie) reuse the exact same rig with a different skin sheet.
/* The head, chest and arms hang off a TORSO group pivoted at the hips (0.726) rather than
   directly off the root, so leaning the upper body — sneaking — carries the head and both arms
   with it while the legs stay planted. Everything the animators address by name (m.head, m.armR,
   …) is unchanged; only the parenting and the local Y offsets moved. */
function buildHumanoid(mat = _newSkinMat()) {
  const root = new THREE.Group();
  const torso = new THREE.Group();
  torso.position.y = 12 * PX;                         // hip height: the lean pivot
  const head = _part(mat, 8, 8, 8, 0, 0);
  head.position.y = 16 * PX;                          // 12 body + 4 (half head), above the hips
  const body = _part(mat, 8, 12, 4, 16, 16);
  body.position.y = 6 * PX;
  const armR = _limb(mat, 4, 12, 4, 40, 16);          // character's right = -X
  armR.position.set(-6 * PX, 12 * PX, 0);
  const armL = _limb(mat, 4, 12, 4, 32, 48);
  armL.position.set(6 * PX, 12 * PX, 0);
  const legR = _limb(mat, 4, 12, 4, 0, 16);
  legR.position.set(-2 * PX, 12 * PX, 0);
  const legL = _limb(mat, 4, 12, 4, 16, 48);
  legL.position.set(2 * PX, 12 * PX, 0);
  torso.add(head, body, armR, armL);
  root.add(torso, legR, legL);
  return { root, torso, head, body, armR, armL, legR, legL, mat, mats: [mat] };
}

/* Walk cycle + head aim, shared by the local player model and every NPC.
   `atk` (0..1) overlays a downward chopping swing on the right arm.
   `opts` carries the poses only players strike (see poseSelfModel):
     lean  radians the torso tips forward — sneaking
     eat   0..1 raises the held hand to the mouth with a nibble
     hold  true when carrying something, so the arm presents it instead of hanging      */
function animateHumanoid(m, phase, swing, pitch, atk = 0, opts) {
  const s = Math.sin(phase) * swing;
  const c = Math.sin(phase + Math.PI) * swing;
  m.armR.rotation.x = s;  m.armL.rotation.x = c;
  m.legR.rotation.x = c;  m.legL.rotation.x = s;
  const lean = (opts && opts.lean) || 0;
  if (m.torso) m.torso.rotation.x = lean;
  // the head aims in WORLD terms, so a leaning torso has to be subtracted back out of it
  m.head.rotation.x = pitch - lean;
  m.armR.rotation.z = 0;
  m.armL.rotation.z = 0;
  if (atk > 0) {
    // arm winds up over the first third of the window, then chops through
    const t = 1 - atk;                                   // 0 at swing start -> 1 at the end
    m.armR.rotation.x = -2.5 + Math.sin(Math.min(1, t * 1.4) * Math.PI) * 2.2;
    m.armR.rotation.z = -0.25 * atk;
  }
  if (opts) {
    if (opts.eat > 0) {
      // both the raise and the nibble live on the right arm; the wobble sells the chewing
      const r = Math.min(1, opts.eat * 5);               // fully raised in the first fifth
      m.armR.rotation.x = -1.35 * r + Math.sin(opts.eat * 34) * 0.12 * r;
      m.armR.rotation.z = 0.45 * r;
      m.head.rotation.x = pitch - lean + 0.18 * r;       // chin dips toward the food
    } else if (opts.hold && atk <= 0) {
      // carrying something: the arm holds it out in front rather than swinging at the hip
      m.armR.rotation.x -= 1.05 + pitch * 0.45;
      m.armR.rotation.z = -0.18;
    }
    // sneaking tucks the arms in slightly, the way a crouch does
    if (lean > 0.01) { m.armR.rotation.z -= 0.10; m.armL.rotation.z += 0.10; }
  }
}
// Bake world lighting (and the hurt / burning flash) into this model's own material(s).
// `burn` is the daylight scorch: an orange wash that flickers so it reads as fire, not damage.
function shadeHumanoid(m, x, y, z, hurt, burn) {
  const b = _lightAt(x, y + 1.0, z);          // sample around chest height
  const f = burn ? 0.8 + Math.random() * 0.45 : 0;
  for (const mat of (m.mats || [m.mat])) {
    if (!mat) continue;
    if (hurt) mat.color.setRGB(_HURT_COL.r * b, _HURT_COL.g * b, _HURT_COL.b * b);
    else if (burn) mat.color.setRGB(_BURN_COL.r * f, _BURN_COL.g * f, _BURN_COL.b * f);
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
var camView = 0;
var _selfModel = buildHumanoid();
_selfModel.root.visible = false;
scene.add(_selfModel.root);
var _selfPhase = 0, _selfPrevX = 0, _selfPrevZ = 0;
var _selfCrouch = 0;                 // 0..1 eased sneak amount, drives the torso lean
var _selfLie = 0;                    // 0..1 eased "in bed" amount, tips the model onto its back

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

var _selfHeld = new THREE.Group();
_selfModel.armR.add(_selfHeld);
var _selfHeldId = undefined;
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

/* Called from the frame loop right after the first-person camera transform is set.

   The body is now POSED UNCONDITIONALLY (0.72), not only in third person. In split screen every
   other player has to see this one walking around, and that means the model must be animated and
   lit whether or not its owner is looking at it. Who actually sees it is decided per render pass:
   36-splitscreen.js hides a player's own body in their own viewport when they are in first
   person, and shows it in everyone else's. */
/* How far through an arm swing this player is, as the `atk` value animateHumanoid wants: 1 at the
   start of the stroke, falling to 0 as it lands.

   This reads the SAME state the first-person hand does (24-hands.js) rather than tracking its own,
   so the body and the arm you are holding always agree. `_swingT` is set to 0 by every action that
   should look like a swing — breaking, a landed placement, a bush pickup — and mining drives a
   continuous chop off the accumulated dig time instead. Both are per-player swapped globals, so
   each seat animates from its own actions. One frame behind the hand, which nobody can see. */
function selfSwingPhase() {
  if (!playing || menuScene) return 0;
  const HAND_SWING_PERIOD = 0.32;                       // must match updateHands
  if (!player.canFly && mining.active)
    return 1 - (mining.elapsed % HAND_SWING_PERIOD) / HAND_SWING_PERIOD;
  return _swingT >= 0 ? 1 - _swingT : 0;
}

function applyCameraView(dt) {
  const alive = !menuScene && player.spawned;
  _selfModel.root.visible = alive;
  player._bodyVisibleToSelf = alive && camView !== 0;
  if (alive) {
    const dx = player.pos.x - _selfPrevX, dz = player.pos.z - _selfPrevZ;
    const spd = Math.hypot(dx, dz) / Math.max(dt, 1e-4);
    _selfPhase += Math.min(spd, 9) * dt * 2.2;
    const swing = Math.min(spd / 5.5, 1) * 0.72;
    /* Sneaking: ease the lean in and out rather than snapping, and drop the whole body with it —
       the first-person eye already dips from 1.62 to 1.42, so the model has to follow or the two
       views disagree about how tall this player currently is. */
    _selfCrouch += ((player.sneaking ? 1 : 0) - _selfCrouch) * Math.min(1, dt * 12);
    /* Lying in a bed (0.7294): the whole model is tipped onto its back and dropped to mattress
       height, so from another player's viewport you can see who is actually asleep. Eased, so
       climbing in and getting up read as movements rather than a snap. */
    _selfLie += ((player.sleepingAt ? 1 : 0) - _selfLie) * Math.min(1, dt * 9);
    const lie = _selfLie;
    _selfModel.root.position.set(player.pos.x,
      player.pos.y - 0.14 * _selfCrouch * (1 - lie) - 0.72 * lie, player.pos.z);
    _selfModel.root.rotation.y = player.yaw + Math.PI;   // model faces +Z, yaw 0 looks -Z
    _selfModel.root.rotation.x = -Math.PI / 2 * lie;     // onto its back, feet toward the foot end
    _syncSelfHeld();
    animateHumanoid(_selfModel, _selfPhase, swing * (1 - lie), -player.pitch * 0.6 * (1 - lie),
                    selfSwingPhase() * (1 - lie), {
      lean: 0.5 * _selfCrouch * (1 - lie),
      eat: player._eatProg || 0,
      hold: _selfHeldId != null,
    });
    // arms tucked in at the sides while asleep, rather than hanging as if standing
    if (lie > 0.01) {
      _selfModel.armR.rotation.x *= (1 - lie); _selfModel.armL.rotation.x *= (1 - lie);
      _selfModel.armR.rotation.z = 0.12 * lie;  _selfModel.armL.rotation.z = -0.12 * lie;
      _selfModel.legR.rotation.x *= (1 - lie);  _selfModel.legL.rotation.x *= (1 - lie);
    }
    shadeHumanoid(_selfModel, player.pos.x, player.pos.y, player.pos.z, false);
    /* Name tag: normally drawn through the world so you can find each other, but crouching hides
       it behind blocks AND dims it — sneaking is how you stop advertising your position. The
       depth test is a hard switch on the input; the dimming follows the eased crouch so it fades
       with the pose rather than snapping. */
    const tag = _selfModel.nameTag;
    if (tag) {
      tag.material.depthTest = !!player.sneaking;
      tag.material.color.setScalar(1 - 0.5 * _selfCrouch);   // darker, not more transparent
    }
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
// no population cap since 0.71 — density comes from the per-chunk spawn roll instead
const ENT_R = 0.3, ENT_H = 1.8;
const ENT_HP = 20;
const ENT_SPEED = 2.2, ENT_CHASE_SPEED = 4.0;
const ENT_GRAVITY = 26, ENT_JUMP = 7.6;
const ENT_ATTACK_DMG = 3, ENT_ATTACK_CD = 1.0, ENT_ATTACK_RANGE = 2.2;
const ENT_AGGRO_TIME = 12, ENT_AGGRO_RANGE = 18;
// nothing despawns for distance any more — far mobs freeze instead (see updateEntities)
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
const ENT_STUCK_TIME = 12;               // seconds of "walking" without moving before a mob is written off
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
const SHEEP_HP = 8;
const SHEEP_SPEED = 2.0, SHEEP_FLEE_SPEED = 5.2;
const SHEEP_FLEE_TIME = 6;
const SHEEP_H = 1.3;                     // shorter than a humanoid
const SHEEP_REGROW = 10;                 // seconds for the fleece to grow back once it starts
const SHEEP_GRAZE_CD = 5;                // how often a shorn sheep looks for grass to eat
const SHEEP_GRAZE_CHANCE = 0.25;
const SHEEP_BIOMES = new Set(['Plains', 'Forest', 'Birch Forest']);

/* ---- zombies (0.715): the first genuinely HOSTILE mob ----
   They are not part of the permanent per-chunk population. A chunk rolls for zombies every time
   it finishes generating — a brand new chunk or an old one being loaded back in — but only while
   it is night, so they accumulate after dusk and are gone by mid-morning. Each one claws its way
   up out of the ground on arrival, hunts anything within four chunks, and catches fire the moment
   real daylight reaches it. Nothing about them is saved: dawn is the despawn. */
const ZOMBIE_HP = 18;
const ZOMBIE_SPEED = 1.5, ZOMBIE_CHASE_SPEED = 3.1;
const ZOMBIE_DMG = 4;
// 4 chunks. That is the lowest render distance anyone plays at, so a zombie can never notice the
// player from inside terrain the player cannot see.
const ZOMBIE_CHASE_RANGE = 64;
const ZOMBIE_RISE_TIME = 1.2;            // seconds spent climbing out of the ground
const ZOMBIE_CHUNK_CHANCE = 0.10;        // per chunk load, at night
const ZOMBIE_PACK_MIN = 1, ZOMBIE_PACK_MAX = 2;
const ZOMBIE_CAP = 24;                   // hard ceiling — chunk reloads must not stack up forever
const ZOMBIE_BURN_GRACE = 0.7;           // seconds in the open before it catches
const ZOMBIE_BURN_DPS = 1.8;
const ZOMBIE_SPAWN_MIN_DIST = 14;        // never sprouts in the player's face
const ZOMBIE_NIGHT_FROM = 0.47;          // worldTime: 0 sunrise, .5 sunset, .75 midnight
const ZOMBIE_DAY_UNTIL = 0.45;           // ...and this is when the sun is high enough to burn
const isNightForMobs = () => worldTime >= ZOMBIE_NIGHT_FROM;
const isBurningDaylight = () => worldTime < ZOMBIE_DAY_UNTIL;

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

/* A zombie starts fully underground and `riseT` lifts it into place — the model is offset, not
   the collision position, so it is already standing on solid ground the whole time. */
function spawnZombie(x, y, z) {
  const m = buildHumanoid(_newZombieMat());
  m.root.position.set(x, y - ENT_H, z);
  scene.add(m.root);
  const ent = {
    model: m, x, y, z, vy: 0, yaw: Math.random() * Math.PI * 2,
    hp: ZOMBIE_HP, onGround: false,
    state: 'wander', wanderT: 0, walk: 0, hurtT: 0,
    aggroT: 0, atkCd: 0, jumpCd: 0, thinkT: 0,
    kx: 0, kz: 0, hazCd: 0, airT: ENT_AIR_MAX, escapeT: 0, turnCd: 0,
    atkAnimT: 0, flailT: 0,
    riseT: ZOMBIE_RISE_TIME, burnT: 0, sunT: 0,
    hx: x, hz: z,
    name: 'Zombie', inventory: [], kind: 'zombie', dmg: ZOMBIE_DMG,
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

/* Lowest Y at or above the feet where the body actually FITS at (nx,nz), or null.
   The old climb test just probed `e.y + 1`, which fails at a shoreline: a mob floating at
   y≈99.4 probes 100.4, and floor(100.4) IS the solid shore block, so the step never looked
   possible and it bobbed against the bank forever. Probing candidate STANDING heights instead
   finds y=101 (on top of the shore) correctly. */
function _stepUpTarget(e, nx, nz, maxRise = 1.7) {
  const base = Math.floor(e.y);
  for (let k = 1; k <= 2; k++) {
    const ty = base + k;
    if (ty - e.y > maxRise) break;
    if (!_entBlocked(nx, ty, nz)) return ty;
  }
  return null;
}

// Cells a mob refuses to walk into. Lava and cactus hurt; deep-ish water is avoided so they
// don't wander out to sea and drown. Checked against the two cells the body occupies.
function _entHazard(x, y, z) {
  for (let dy = 0; dy <= 1; dy++) {
    const id = getBlock(Math.floor(x), Math.floor(y + dy), Math.floor(z)) & 255;
    if (id === B.LAVA || id === B.CACTUS) return true;
  }
  const fx = Math.floor(x), fz = Math.floor(z), fy = Math.floor(y);
  // a step that would drop the feet into water counts as a hazard too
  if ((getBlock(fx, fy, fz) & 255) === B.WATER) return true;
  /* ...and so does a ledge: probe downward for a floor and refuse the step if the drop would
     hurt. WATER FOUND ON THE WAY DOWN IS ALSO A HAZARD (0.711) — it used to count as a floor,
     on the reasoning that falling into a pond is survivable. That is exactly how mobs kept
     ending up in the sea: standing on a bank, the cell straight ahead is air (the water surface
     is a block lower), so the step looked clean and they walked straight off into it. Now the
     shoreline reads as a wall and they turn along it instead. */
  let d = 0;
  while (d <= ENT_FALL_SAFE && fy - 1 - d >= 0) {
    const bid = getBlock(fx, fy - 1 - d, fz) & 255;
    if (bid === B.WATER) return true;
    if (PROPS[bid]?.solid) break;
    d++;
  }
  return d > ENT_FALL_SAFE;
}
/* A spawn needs real ROOM, not just a body-sized gap: a 2x2x2 block of open cells. Without this
   a mob could be placed into a one-block-high cave mouth or a crevice and be sealed in the
   instant it settled — the body AABB is only 0.6 wide, so it fitted where nothing could move. */
function _entSpawnRoom(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  for (let dy = 0; dy <= 1; dy++)
    for (let dz = 0; dz <= 1; dz++)
      for (let dx = 0; dx <= 1; dx++) {
        const id = getBlock(fx + dx, fy + dy, fz + dz) & 255;
        if (PROPS[id]?.solid || id === B.WATER || id === B.LAVA) return false;
      }
  return true;
}

/* Fall damage, mirroring the player's rule. Tracks the highest point reached while airborne
   rather than integrating vy, so a mob knocked upward off a cliff is measured from the apex.
   Returns true if the entity died and was removed — the caller must return immediately, since
   ENTITIES has been spliced under it. */
const ENT_FALL_SAFE = 3;              // blocks of free fall a mob shrugs off
function _entFallDamage(e, i, wasGround, inWater) {
  if (inWater) { e.peakY = null; return false; }
  if (!e.onGround) {
    e.peakY = (e.peakY == null) ? e.y : Math.max(e.peakY, e.y);
    return false;
  }
  const peak = e.peakY;
  e.peakY = null;
  if (wasGround || peak == null) return false;
  const drop = peak - e.y;
  if (drop <= ENT_FALL_SAFE) return false;
  e.hurtT = 0.25;
  e.hp -= Math.round(drop - ENT_FALL_SAFE);
  if (e.hp > 0) return false;
  if (!player.canFly) _entDropLoot(e);
  _removeEntity(i);
  return true;
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
  if (ent.kind === 'zombie') {
    const n = _ri(0, 2);                       // 0 is a real outcome — some leave nothing
    if (n > 0) pop(ITEM.ROTTEN_FLESH, n);
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
      if (!player.canFly) { _entDropLoot(ent); addXP(XP_MOB); }
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
    if (!player.canFly) { _entDropLoot(ent); addXP(XP_MOB); }
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
const _blockDir = new THREE.Vector3();
function pickEntityHit(maxDist = 4.0) {
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
  return best ? { ent: best, t: bestT } : null;
}
function pickEntity(maxDist = 4.0) {
  const h = pickEntityHit(maxDist);
  return h ? h.ent : null;
}

/* Blocks you can reach a mob through: billboards (tall grass, flowers, saplings) and leaves.
   Standing in a bush must not make the bush eat your swing. Glass and other cutout blocks are
   deliberately excluded — they're solid to a fist. */
function _swingPassable(id) {
  const p = PROPS[id & 255];
  if (!p) return false;
  return p.model === 'cross' || (id & 255) === B.LEAVES || (id & 255) === B.BIRCH_LEAVES;
}

/* Does the aimed entity take priority over the aimed block?
   `hit.t` is measured from camera.position (which in third person sits metres behind the head)
   while entity picking starts at the eye, so the block distance is re-measured from the eye
   before the two are compared. */
function entityBeatsBlock(entHit, hit) {
  if (!entHit) return false;
  if (!hit || hit.t == null) return true;
  if (_swingPassable(hit.id)) return true;
  camera.getWorldDirection(_blockDir);        // NOT _atkDir — that one is flipped in front view
  const hx = camera.position.x + _blockDir.x * hit.t;
  const hy = camera.position.y + _blockDir.y * hit.t;
  const hz = camera.position.z + _blockDir.z * hit.t;
  const dx = hx - _atkOrigin.x, dy = hy - _atkOrigin.y, dz = hz - _atkOrigin.z;
  return entHit.t <= Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* Attack pacing. A bare hand needs HAND_ATTACK_TIME between swings; a weapon's attackSpeed is a
   multiplier that shortens that (attackSpeed 2 = twice as fast). Swapping what you're holding
   re-arms the full hand delay, so you can't scroll onto a fast sword and hit instantly. */
const HAND_ATTACK_TIME = 0.5;
const HAND_DAMAGE = 1;
var _atkCooldown = 0;
var _lastHeldForAtk;
function attackCooldownFor(id) {
  const p = id != null && id >= 256 ? ITEM_PROPS[id] : null;
  const spd = p && p.attackSpeed > 0 ? p.attackSpeed : 1;
  // worn gear scales the swing rate on top of the weapon's own speed
  const gear = typeof playerAtkSpeedMul === 'function' ? playerAtkSpeedMul() : 1;
  return HAND_ATTACK_TIME / (spd * gear);
}
function attackDamageFor(id) {
  const p = id != null && id >= 256 ? ITEM_PROPS[id] : null;
  const base = p && p.damage > 0 ? p.damage : HAND_DAMAGE;
  // strength from equipment is flat bonus damage (diamond sword 7 + iron gloves 0.75 = 7.75)
  return base + (typeof playerStrength === 'function' ? playerStrength() : 0);
}
/* ---- snowballs (0.6962) ----
   A thrown snowball is a shove, not an attack: it staggers whatever it lands on and pushes it
   along the flight direction, but deals no damage and deliberately touches NEITHER `aggroT`/
   `state` (hostiles stay neutral) NOR `fleeT` (sheep don't bolt). Pelting a cow is harmless fun. */
function projectileHitEntity(x, y, z) {
  for (const e of ENTITIES) {
    if (e.hp <= 0) continue;
    if (Math.abs(x - e.x) > ENT_R + 0.2 || Math.abs(z - e.z) > ENT_R + 0.2) continue;
    if (y < e.y - 0.1 || y > e.y + ENT_H) continue;
    return e;
  }
  return null;
}
function entitySnowballHit(ent, vx, vy, vz) {
  ent.hurtT = 0.25;                              // the white flash, so the hit reads
  ent.flailT = ENT_FLAIL_TIME;
  const m = Math.hypot(vx, vz) || 1;
  ent.kx = vx / m * ENT_KNOCK * 7;               // lighter than a melee hit
  ent.kz = vz / m * ENT_KNOCK * 7;
  if (_entBlocked(ent.x, ent.y - 0.02, ent.z)) ent.vy = ENT_KNOCK_HOP * 0.5;
  playSound('hit', { gain: 0.5, rate: 1.3 + Math.random() * 0.1, pos: { x: ent.x, y: ent.y + 1, z: ent.z } });
}
function tryAttackEntity(ent) {
  if (_atkCooldown > 0) return false;
  if (!ent) ent = pickEntity();
  if (!ent) return false;
  const held = slotId(HOTBAR[hotbarSel]);
  playSound('hit', { gain: 0.9, rate: 0.95 + Math.random() * 0.1, pos: { x: ent.x, y: ent.y + 1, z: ent.z } });
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
   EVERY entity is written (0.71), not just the ones in render distance. A chunk rolls its
   population once and only once, so an unsaved mob is a mob that never comes back — the whole
   point of the new scheme is that the flock you found is still there tomorrow. Frozen entities
   in unloaded chunks are saved exactly like active ones. */
function serializeEntities() {
  const out = [];
  for (const e of ENTITIES) {
    if (e.kind === 'zombie') continue;      // night spawns: dawn is their despawn, never persisted
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

/* ---- spawning (0.71) ----
   Mobs are part of the TERRAIN, not a running population meter. A chunk rolls for its inhabitants
   exactly once, the first time it is ever generated, and that roll is recorded in `_entChunks`
   and saved with the world — so walking back into a chunk never re-populates it. Nothing spawns
   near the player on a timer any more, and nothing despawns for being far away: the mobs you
   left in a field are the mobs you find when you come back.

   The cost of a permanent population is paid by FREEZING it. An entity whose chunk is not loaded
   is skipped entirely by the update loop and its model is hidden — it holds its position and its
   state, and costs nothing per frame beyond the array slot. See updateEntities. */
const _entChunks = new Set();            // "cx,cz" of every chunk that has already rolled
const ENT_CHUNK_CHANCE = 0.030;          // a wanderer in ~1 chunk in 33
const SHEEP_CHUNK_CHANCE = 0.028;        // a flock in ~1 chunk in 36 — sheep were far too common
const SHEEP_FLOCK_MIN = 1, SHEEP_FLOCK_MAX = 3;

// a legal surface spot inside this chunk, or null. Chunk-local — nothing to do with the player.
function _findChunkSpot(cx, cz, biomes) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = cx * 16 + Math.floor(Math.random() * 16) + 0.5;
    const z = cz * 16 + Math.floor(Math.random() * 16) + 0.5;
    if (biomes && !biomes.has(mainGen.biomeAt(Math.floor(x), Math.floor(z)))) continue;
    const gy = surfaceY(Math.floor(x), Math.floor(z));
    const top = getBlock(Math.floor(x), gy, Math.floor(z)) & 255;
    if (top === B.AIR || top === B.WATER || top === B.LAVA || top === B.CACTUS) continue;
    const y = gy + 1;
    if (_entBlocked(x, y, z) || _entHazard(x, y, z)) continue;
    if (!_entSpawnRoom(x, y, z)) continue;             // needs a 2x2x2 pocket, not just a body gap
    return { x, y, z, top };
  }
  return null;
}
/* Called once per chunk from 11-chunks.js, right after its terrain and structures land. */
function trySpawnEntitiesInChunk(cx, cz) {
  if (menuScene || !currentWorld) return;
  const k = cx + ',' + cz;
  if (_entChunks.has(k)) return;
  _entChunks.add(k);
  if (Math.random() < ENT_CHUNK_CHANCE) {
    const s = _findChunkSpot(cx, cz, ENT_BIOMES);
    if (s) spawnEntity(s.x, s.y, s.z);
  }
  if (Math.random() < SHEEP_CHUNK_CHANCE) {
    const s = _findChunkSpot(cx, cz, SHEEP_BIOMES);
    // grazers only appear on grass, and they arrive as a flock clustered on the same spot
    if (s && s.top === B.GRASS) {
      const n = SHEEP_FLOCK_MIN + Math.floor(Math.random() * (SHEEP_FLOCK_MAX - SHEEP_FLOCK_MIN + 1));
      for (let i = 0; i < n; i++) {
        const ox = (Math.random() * 4 - 2), oz = (Math.random() * 4 - 2);
        const sx = s.x + ox, sz = s.z + oz;
        // a scattered flock member that lands somewhere cramped falls back to the anchor spot,
        // which already passed the full room test
        if (_entBlocked(sx, s.y, sz) || _entHazard(sx, s.y, sz) || !_entSpawnRoom(sx, s.y, sz))
          { spawnSheep(s.x, s.y, s.z); continue; }
        spawnSheep(sx, s.y, sz);
      }
    }
  }
}
/* Night mobs, rolled on EVERY chunk-gen finish rather than once per chunk for ever: a chunk that
   was empty at noon is a candidate again after dusk. Called from finishChunkGen alongside the
   permanent population roll, so a freshly generated chunk and an old one being streamed back in
   are treated identically — which is exactly what "loading old ones" has to mean here, since a
   chunk you walk away from is regenerated from the seed when you return. */
function trySpawnNightMobsInChunk(cx, cz) {
  if (menuScene || !currentWorld || !anyPlayerSpawned()) return;
  if (!isNightForMobs()) return;
  if (Math.random() >= ZOMBIE_CHUNK_CHANCE) return;
  let live = 0;
  for (const e of ENTITIES) if (e.kind === 'zombie') live++;
  if (live >= ZOMBIE_CAP) return;
  const s = _findChunkSpot(cx, cz, null);              // any biome — night is night everywhere
  if (!s) return;
  // "in the player's face" means ANY player's face in split screen
  for (const p of PLAYERS) {
    const dx = s.x - p.pos.x, dz = s.z - p.pos.z;
    if (dx * dx + dz * dz < ZOMBIE_SPAWN_MIN_DIST * ZOMBIE_SPAWN_MIN_DIST) return;
  }
  const n = Math.min(ZOMBIE_CAP - live, _ri(ZOMBIE_PACK_MIN, ZOMBIE_PACK_MAX));
  for (let i = 0; i < n; i++) {
    const ox = Math.random() * 3 - 1.5, oz = Math.random() * 3 - 1.5;
    const zx = s.x + ox, zz = s.z + oz;
    if (_entBlocked(zx, s.y, zz) || _entHazard(zx, s.y, zz) || !_entSpawnRoom(zx, s.y, zz))
      { spawnZombie(s.x, s.y, s.z); continue; }        // fall back to the vetted anchor spot
    spawnZombie(zx, s.y, zz);
  }
}

function serializeEntChunks() { return [..._entChunks]; }
function restoreEntChunks(list) {
  _entChunks.clear();
  if (Array.isArray(list)) for (const k of list) if (typeof k === 'string') _entChunks.add(k);
}

/* Player shove: mob hits and body collisions feed a decaying velocity here rather than moving
   the player outright, so being struck slides you back instead of teleporting you. */
/* Shove state lives ON the player object (0.72) so each split-screen player is knocked about
   independently. `_plyKick` stays as the active player's alias for the code that reads it. */
var _plyKick = { x: 0, z: 0 };
function playerKick(p) { return p._kick || (p._kick = { x: 0, z: 0 }); }
function _movePlayerBy(p, dx, dz) {
  const q = p.pos;
  if (!_entBlocked(q.x + dx, q.y, q.z)) q.x += dx;
  if (!_entBlocked(q.x, q.y, q.z + dz)) q.z += dz;
}
function _updatePlayerKick(dt) {
  for (const p of PLAYERS) {
    const k = playerKick(p);
    if (!k.x && !k.z) continue;
    _movePlayerBy(p, k.x * dt, k.z * dt);
    const d = Math.max(0, 1 - PLY_KNOCK_DECAY * dt);
    k.x *= d; k.z *= d;
    if (Math.abs(k.x) < 0.05 && Math.abs(k.z) < 0.05) { k.x = 0; k.z = 0; }
  }
}

/* Bodies are solid to each other: overlapping mobs (and the player) get pushed apart so nothing
   ends up standing inside anyone. Vertical overlap is required, otherwise stacked mobs on
   different floors would shove each other. */
function _separateBodies(dt) {
  const minD = ENT_R * 2, minD2 = minD * minD;
  for (let a = 0; a < ENTITIES.length; a++) {
    const e = ENTITIES[a];
    if (e.active === false) continue;         // frozen in an unloaded chunk — nothing to push
    // vs other entities
    for (let b = a + 1; b < ENTITIES.length; b++) {
      const o = ENTITIES[b];
      if (o.active === false) continue;
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
    // vs every player — creative flying passes through, survival gets shoved
    for (const p of PLAYERS) {
      if (!p.spawned || (p.canFly && p.flying)) continue;
      if (Math.abs(p.pos.y - e.y) >= ENT_H) continue;
      let dx = p.pos.x - e.x, dz = p.pos.z - e.z;
      const d2 = dx * dx + dz * dz;
      const pMin = ENT_R + p.R;
      if (d2 >= pMin * pMin) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d = Math.hypot(dx, dz) || 1; }
      const push = (pMin - d) / pMin * ENT_PUSH * dt;
      const ux = dx / d * push, uz = dz / d * push;
      if (!_entBlocked(e.x - ux, e.y, e.z - uz)) { e.x -= ux; e.z -= uz; }
      _movePlayerBy(p, ux, uz);
    }
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
          playBlockSound(B.GRASS, 'break', gx, gy, gz);
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
  e.wantMove = moveSpeed > 0 && !stunned;        // read by the stuck watchdog next tick
  if (moveSpeed > 0 && !stunned) {
    moveSpeed *= boxDragMul(e.x, e.y, e.z, ENT_R, ENT_H);   // leaves/litter -40%, snow -70%
    const sx = Math.sin(e.yaw) * moveSpeed * dt, sz = Math.cos(e.yaw) * moveSpeed * dt;
    const bad = (nx, nz) => _entBlocked(nx, e.y, nz) || (!inWater && _entHazard(nx, e.y, nz));
    let blocked = false;
    if (!bad(e.x + sx, e.z)) { e.x += sx; moved += Math.abs(sx); } else blocked = true;
    if (!bad(e.x, e.z + sz)) { e.z += sz; moved += Math.abs(sz); } else blocked = true;
    const climbY = blocked ? _stepUpTarget(e, e.x + sx, e.z + sz) : null;
    if (blocked && inWater && climbY !== null) {
      // wading ashore: lift straight onto the ledge, swimming has no real jump arc
      e.y = climbY; e.x += sx; e.z += sz; e.vy = 1.5; e.onGround = false; e.jumpCd = 0.3;
    } else if (blocked && (e.onGround || inWater) && e.jumpCd <= 0 && climbY !== null) {
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
  const wasGround = e.onGround;
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
  if (_entFallDamage(e, i, wasGround, inWater)) return;
  // Buoyancy, but never CLAMP an active climb/jump: the old unconditional Math.min pulled a
  // fresh 7.6 hop straight back down to 4.2, which is the other half of the shoreline trap.
  if (inWater) {
    if (e.vy < 4.2) e.vy = Math.min(e.vy + 40 * dt, 4.2);
    e.onGround = false;
  }

  /* ---- visuals ---- */
  const spd = moved / Math.max(dt, 1e-4);
  entityStepSound(e, dt, spd);
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

/* Sunlight kills. The test is SKY light at head height, not the day/night shading — standing in
   a doorway, under leaves, in a cave or one block into an overhang all read as shade, which is
   what makes hiding spots meaningful. Water puts the fire out too. A short grace period stops a
   zombie flickering alight every time it crosses a one-block gap in a roof.
   Returns true if it burned to death (the caller must remove it immediately). */
function _zombieBurnTick(e, dt) {
  const hx = Math.floor(e.x), hz = Math.floor(e.z);
  const wet = (getBlock(hx, Math.floor(e.y + 0.4), hz) & 255) === B.WATER;
  const lit = isBurningDaylight() && !wet && getSkyWorld(hx, Math.floor(e.y + 1.5), hz) >= 15;
  if (!lit) {
    e.sunT = 0;
    if (e.burnT > 0) e.burnT = Math.max(0, e.burnT - dt * 2);
    return false;
  }
  e.sunT += dt;
  if (e.sunT < ZOMBIE_BURN_GRACE) return false;
  e.burnT = 0.5;
  e.hp -= ZOMBIE_BURN_DPS * dt;
  if (e.hp > 0) return false;
  if (!player.canFly) _entDropLoot(e);       // no XP: the sun did it, not the player
  return true;
}

/* Swing pacing is PER PLAYER, so it ticks inside each player's own context rather than once for
   the world — see the per-player pass in 22-main-loop.js. */
function updateAttackCooldown(dt) {
  if (_atkCooldown > 0) _atkCooldown -= dt;
  // swapping hotbar slot / item re-arms the full bare-hand delay
  const heldNow = slotId(HOTBAR[hotbarSel]);
  if (heldNow !== _lastHeldForAtk) {
    if (_lastHeldForAtk !== undefined) _atkCooldown = Math.max(_atkCooldown, HAND_ATTACK_TIME);
    _lastHeldForAtk = heldNow;
  }
}

function updateEntities(dt) {
  if (!playing || menuScene || !anyPlayerSpawned()) return;
  _updatePlayerKick(dt);

  for (let i = ENTITIES.length - 1; i >= 0; i--) {
    const e = ENTITIES[i];
    if (e.y < -30) { _removeEntity(i); continue; }     // fell out of the world: genuinely gone
    /* TWO RADII (0.712). Visibility follows the GENERATION radius — if the chunk is loaded, the
       mob is drawn, standing still, exactly where it was. Simulation follows the much smaller
       `simDist`: outside it the mob is skipped by every per-frame system (`active` is what
       _separateBodies reads) even though you can still see it in the distance.

       That split is the point of the change. A render distance of 32 draws ~4000 chunks, and
       stepping mobs through all of them was pure waste when the player can only reach the
       nearest handful. A parked mob resumes mid-stride the moment it comes back in range. */
    const ecx = Math.floor(e.x / 16), ecz = Math.floor(e.z / 16);
    const ec = getChunk(ecx, ecz);
    const loaded = !!(ec && ec.data);
    if (e.model.root.visible !== loaded) e.model.root.visible = loaded;
    const sim = loaded && inSimRangeChunk(ecx, ecz);
    /* WAKE-UP AUDIT. The moment a parked mob starts simulating again, check it is somewhere it
       can actually live. A mob embedded in solid blocks — walled in by a player build, buried by
       falling gravel, or in a pocket the world has since closed — is removed rather than left
       twitching inside a wall forever. Runs once per entity per wake-up, not per frame. */
    if (sim && e.active === false && _entBlocked(e.x, e.y, e.z)) { _removeEntity(i); continue; }
    /* Frozen zombies never reach _zombieBurnTick, so daybreak would leave a ring of them parked
       out at the render edge waiting to combust the moment the player walked over. Sweep them at
       dawn instead — the sun reached them too, it just had nobody to show. */
    if (!sim && e.kind === 'zombie' && isBurningDaylight()) { _removeEntity(i); continue; }
    if (!sim) { e.active = false; continue; }
    e.active = true;
    /* THE mob's target is whichever player is nearest right now (0.72). Everything below reads
       `tp` instead of the active-context `player`, because entities tick once for the world, not
       once per viewport — a mob must not chase whoever happens to be mid-render. */
    const tp = nearestPlayerTo(e.x, e.z);
    const pdx = tp.pos.x - e.x, pdz = tp.pos.z - e.z;
    const pdy = tp.pos.y - e.y;
    const distXZ = Math.hypot(pdx, pdz);

    /* STUCK WATCHDOG. `wantMove` is set by the movement blocks below: it means the mob asked to
       walk this tick. If it asks and asks and never actually moves, it is wedged — a one-block
       hole it fell into, a crevice, a pocket a build sealed around it — and no amount of further
       ticking will free it, so it is removed. Only ever out of sight (>16 blocks): nothing is
       allowed to blink out while you are looking at it. */
    if (e._px !== undefined && e.wantMove) {
      const dx2 = e.x - e._px, dz2 = e.z - e._pz;
      if (dx2 * dx2 + dz2 * dz2 < 1e-6) {
        e.stuckT = (e.stuckT || 0) + dt;
        if (e.stuckT > ENT_STUCK_TIME && distXZ > 16) { _removeEntity(i); continue; }
      } else e.stuckT = 0;
    } else e.stuckT = 0;
    e._px = e.x; e._pz = e.z;

    if (e.hurtT > 0) e.hurtT -= dt;
    if (e.atkCd > 0) e.atkCd -= dt;
    if (e.jumpCd > 0) e.jumpCd -= dt;
    if (e.kind === 'sheep') { _updateSheep(e, dt, pdx, pdz, distXZ, i); continue; }
    /* ---- zombie: claw out of the ground, hunt on sight, burn at dawn ---- */
    if (e.kind === 'zombie') {
      if (e.riseT > 0) {
        // Emerging. The body is already at its final position; only the MODEL is sunk, so the
        // terrain it is rising through hides the buried half for free.
        e.riseT -= dt;
        const sunk = ENT_H * Math.max(0, e.riseT / ZOMBIE_RISE_TIME);
        e.model.root.position.set(e.x, e.y - sunk, e.z);
        e.model.root.rotation.y = e.yaw;
        // arms up out of the soil first, legs still
        animateHumanoid(e.model, 0, 0, 0);
        e.model.armR.rotation.x = e.model.armL.rotation.x = -2.4;
        shadeHumanoid(e.model, e.x, e.y, e.z, false, false);
        continue;                                    // no AI, no gravity, no damage while rising
      }
      if (_zombieBurnTick(e, dt)) { _removeEntity(i); continue; }
      if (e.burnT > 0) e.burnT -= dt;
      // Always hostile inside the hunting radius; creative flight and death call it off.
      if (!tp.canFly && !tp.dead && distXZ <= ZOMBIE_CHASE_RANGE) e.state = 'chase';
      else if (e.state === 'chase') e.state = 'wander';
    }
    if (tp.canFly && (e.aggroT > 0 || e.state === 'chase')) {
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
    } else if (e.state === 'chase' && !tp.dead) {
      e.yaw = Math.atan2(pdx, pdz);
      moveSpeed = e.kind === 'zombie' ? ZOMBIE_CHASE_SPEED : ENT_CHASE_SPEED;
      if (distXZ < ENT_ATTACK_RANGE && Math.abs(pdy) < 2 && e.atkCd <= 0) {
        e.atkCd = ENT_ATTACK_CD;
        e.atkAnimT = ENT_ATK_ANIM;                 // arm chops through on the hit
        moveSpeed = 0;
        tp.hp -= (e.dmg || ENT_ATTACK_DMG);
        tp._dmgCause = `was slain by a ${e.name}`;
        // knock the player back with the same decaying-velocity model the mobs use
        const m = distXZ || 1;
        const kick = playerKick(tp);
        kick.x = pdx / m * PLY_KNOCK;
        kick.z = pdz / m * PLY_KNOCK;
        if (!tp.flying && Math.abs(tp.vy) < 0.5) tp.vy = PLY_KNOCK_HOP;
      }
    } else {
      e.wanderT -= dt;
      if (e.wanderT <= 0) {
        e.wanderT = 2 + Math.random() * 4;
        e.state = Math.random() < 0.35 ? 'idle' : 'wander';
        if (e.state === 'wander') e.yaw = Math.random() * Math.PI * 2;
      }
      const walkSpeed = e.kind === 'zombie' ? ZOMBIE_SPEED : ENT_SPEED;
      moveSpeed = e.state === 'wander' ? walkSpeed : 0;
      // leash: outside its home radius the next heading always points back, so a mob can drift
      // around its spawn region but never migrates across the world
      const hdx = e.hx - e.x, hdz = e.hz - e.z;
      if (Math.hypot(hdx, hdz) > ENT_HOME_RANGE) {
        e.yaw = Math.atan2(hdx, hdz);
        e.state = 'wander';
        moveSpeed = walkSpeed;
      }
    }

    /* ---- horizontal move with a hop over 1-block steps ---- */
    let moved = 0;
    // getting knocked back briefly overrides walking, so a chasing mob can't immediately
    // stride back through its own knockback and cancel it out
    const stunned = (e.kx !== 0 || e.kz !== 0);
    e.wantMove = moveSpeed > 0 && !stunned;      // read by the stuck watchdog next tick
    if (moveSpeed > 0 && !stunned) {
      moveSpeed *= boxDragMul(e.x, e.y, e.z, ENT_R, ENT_H);  // leaves/litter -40%, snow -70%
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
    const wasGround = e.onGround;
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
    if (_entFallDamage(e, i, wasGround, inWater)) continue;   // in updateEntities' own loop
    // Swimming: buoyancy holds the mob at the surface, but it must never CLAMP an active climb
    // — the old unconditional Math.min pulled a fresh hop straight back down to 4.2.
    if (inWater) {
      if (e.vy < 4.2) e.vy = Math.min(e.vy + 40 * dt, 4.2);
      e.onGround = false;
      // Right at the edge of land, climb straight onto the ledge. Probing a real standing
      // height (not just y+1) is what makes this work at a shoreline.
      const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
      const ax = e.x + fx * 0.6, az = e.z + fz * 0.6;
      if (e.jumpCd <= 0 && _entBlocked(ax, e.y, az)) {
        const ty = _stepUpTarget(e, ax, az);
        if (ty !== null) { e.y = ty; e.x = ax; e.z = az; e.vy = 1.5; e.jumpCd = 0.3; }
      }
    }

    /* ---- visuals ---- */
    if (e.atkAnimT > 0) e.atkAnimT -= dt;
    if (e.flailT > 0) e.flailT -= dt;
    const spd = moved / Math.max(dt, 1e-4);
    entityStepSound(e, dt, spd);
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
    // zombies hold both arms out in front; the attack chop still wins when it is swinging
    if (e.kind === 'zombie' && e.atkAnimT <= 0) {
      const sway = Math.sin(e.walk * 0.6) * 0.09;
      m.armR.rotation.x = -1.55 + sway;  m.armL.rotation.x = -1.55 - sway;
      m.armR.rotation.z = 0.06;          m.armL.rotation.z = -0.06;
    }
    shadeHumanoid(m, e.x, e.y, e.z, e.hurtT > 0, e.burnT > 0);
  }
  _separateBodies(dt);
}
