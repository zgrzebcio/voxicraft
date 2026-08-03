'use strict';
/* voxiCraft — first-person right-hand renderer */

/* Separate scene so the hand always renders on top of world geometry without
   z-fighting or fog. After the main pass: clearDepth, then render this. */

const handScene = new THREE.Scene();
const handCam   = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.02, 8);
window.addEventListener('resize', () => {
  handCam.aspect = window.innerWidth / window.innerHeight;
  handCam.updateProjectionMatrix();
});

/* ─── arm materials ───
   convertSRGBToLinear: ColorManagement disabled but renderer sRGB-encodes output,
   so raw hex colors render ~53% brighter without the correction. */
const _skinBase  = new THREE.Color(0xf0c080).convertSRGBToLinear();
const _skinGlow  = new THREE.Color(0xfde8b8).convertSRGBToLinear();  // warm brightened for held-light tint
const _matSkin   = new THREE.MeshBasicMaterial({ color: _skinBase.clone() });
const _matSleeve = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x4a6ecc).convertSRGBToLinear() });

const _armFore  = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.96), _matSkin);
_armFore.position.z = 0.06;

/* sleeve is long and pushed far back so its end goes off-screen, never clips into view */
const _armUpper = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.27, 0.72), _matSleeve);
_armUpper.position.z = 0.84;

/* ─── held-item container ─── */
/* Pose is re-applied per item in _rebuildHeld: blocks/generic items keep the old loose grip,
   while tools and weapons get a dedicated "held by the handle" pose (see HELD_POSE). */
const heldGroup = new THREE.Group();
heldGroup.position.set(0.02, 0.12, -0.44);  // connected to hand tip
heldGroup.scale.setScalar(0.60);             // larger item in hand
heldGroup.rotation.set(-0.15, -0.52, 0.30); // -0.52 rad ≈ 30° left rotation

/* Tool/weapon grip.
   Item sprites are built as an upright quad in the XY plane with the icon's handle in the
   LOWER-LEFT corner and the head in the upper-right, so the shaft runs along the (1,1,0)
   diagonal. Euler order is XYZ, i.e. Z is applied first:
     Rz(+45°)  swings that diagonal onto +Y, so the tool now stands straight up
     Ry(-0.55) yaws it to the right (negative Y swings the tip toward +X)
     Rx(-70°)  tips the top away from the camera, pointing it forward into the scene
   The inner group then slides the sprite so its lower-left (the handle) sits on the pivot,
   which is what makes the fist grab the handle instead of the middle of the blade. */
const HELD_POSE = {
  tool:  { pos: [0.10, -0.01, -0.30], scale: 0.95, rot: [-70 * Math.PI / 180, -0.55, Math.PI / 4], grip: 0.42 },
  block: { pos: [0.02, 0.12, -0.44],  scale: 0.60, rot: [-0.15, -0.52, 0.30],        grip: 0 },
};

/* ─── arm pivot — swing / bob animations rotate this ─── */
const armPivot = new THREE.Group();
armPivot.add(_armFore, _armUpper, heldGroup);

/* ─── screen-space root — start at rest position to avoid near-clip pop on frame 1 ─── */
const handRoot = new THREE.Group();
handRoot.add(armPivot);
handScene.add(handRoot);
// initialized after constants are defined (below)

/* rest position: lower-right of screen, arm angled inward
   Large H_RX tips the arm up so its LENGTH is visible on screen (not just the end-face).
   H_RY angles it toward screen center. At rest the sleeve goes off bottom-right. */
const H_X  =  0.82, H_Y  = -1.04, H_Z  = -2.10;
const H_RX =  0.92, H_RY =  0.48;

handRoot.position.set(H_X, H_Y, H_Z);
armPivot.rotation.set(H_RX, H_RY, 0);

/* ─── state ─── */
let _armGlow   = 0;   // animated 0-1 glow factor for arm skin tint
let _bobT      = 0;
let _swimT     = 0;
let _eatBobT   = 0;
let _inactive  = 0;   // seconds without any input
let _swingT    = -1;  // -1 = idle; 0..1 = swing progress
let _prevMining = false;
let _prevBreak  = false;
let _prevPlace  = false;
let _prevYaw   = 0, _prevPitch = 0;
let _heldId    = undefined;  // undefined forces first build

function _rebuildHeld(id) {
  _heldId = id;
  while (heldGroup.children.length) heldGroup.remove(heldGroup.children[0]);
  if (id === null) return;
  const passes = buildDropGeom(id);
  const isCross = id < 256 && PROPS[id]?.model === 'cross';
  // anything with a tool type (pick/shovel/hatchet/hoe/sword) is gripped by its handle
  const isTool = id >= 256 && !!ITEM_PROPS[id]?.tool;
  const pose = isTool ? HELD_POSE.tool : HELD_POSE.block;
  heldGroup.position.set(...pose.pos);
  heldGroup.scale.setScalar(pose.scale);
  heldGroup.rotation.set(...pose.rot);
  let target = heldGroup;
  if (pose.grip) {
    // shift the sprite diagonally so its lower-left handle corner lands on the pivot
    const g = new THREE.Group();
    g.position.set(pose.grip, pose.grip, 0);
    heldGroup.add(g);
    target = g;
  } else if (isCross) {
    const g = new THREE.Group();
    g.position.y = 0.35;
    heldGroup.add(g);
    target = g;
  }
  for (const { p, geo, mat: mo } of passes)
    target.add(new THREE.Mesh(geo, mo || MATERIALS[p]));
}

function updateHands(dt, wantBreak, wantPlace, eatProg) {
  if (!playing || menuScene || invOpen) {
    handRoot.visible = true;
    const k = 1 - Math.exp(-dt * 24);
    handRoot.position.y += (-2.4 - handRoot.position.y) * k;
    return;
  }

  /* sync held item */
  const slot  = HOTBAR[hotbarSel];
  const curId = slot ? slot.id : null;
  if (curId !== _heldId) _rebuildHeld(curId);
  const hasItem = curId !== null;
  const heldIsFood = curId !== null && ITEM_PROPS[curId]?.food > 0;

  /* inactivity — right hand always shown when holding something */
  const moving = !!player._movingH;
  const looked = Math.abs(player.yaw - _prevYaw) + Math.abs(player.pitch - _prevPitch) > 0.0005;
  const acting = wantBreak || (mousePlace && pointerLocked) || act.padBreak || act.padPlace;
  _prevYaw = player.yaw; _prevPitch = player.pitch;
  if (moving || looked || acting) _inactive = 0; else _inactive += dt;
  const inactive = !hasItem && _inactive > 0.8;
  handRoot.visible = true;

  /* swing triggers */
  const miningNow = !player.canFly && mining.active;
  if (miningNow && !_prevMining)                                  _swingT = 0;  // new block targeted
  if (player.canFly && wantBreak && _swingT < 0)                 _swingT = 0;  // creative break
  if (!player.canFly && wantBreak && !_prevBreak && _swingT < 0) _swingT = 0;  // survival: swing even in air
  if (handPlaceSwing && _swingT < 0 && !heldIsFood)              _swingT = 0;  // successful place only
  handPlaceSwing = false;
  _prevMining = miningNow;
  _prevBreak  = wantBreak;
  _prevPlace  = wantPlace;
  if (_swingT >= 0 && !miningNow) {                   // free-timer swing (creative / place / air)
    _swingT += dt / 0.28;
    if (_swingT >= 1) _swingT = -1;
  }

  /* target transform */
  let tx = H_X, ty = H_Y, tz = H_Z;
  let trx = H_RX, try_ = H_RY;

  if (inactive) ty = -2.4;                            // slide below screen

  if (player._inWater && !player.flying && moving) {  // swim stroke: circular paddle motion
    _swimT += dt;
    const f = player.fast ? 7.0 : 4.5;
    const a = player.fast ? 1.3 : 1.0;
    tx  += Math.cos(_swimT * f) * 0.09 * a;
    ty  += Math.sin(_swimT * f) * 0.11 * a;
    trx += Math.sin(_swimT * f) * 0.45 * a - 0.30;    // arm sweeps forward-down like a stroke
    _bobT = 0;
  } else if (moving && !player.flying) {              // walk / sprint bob
    const freq = player.fast ? 11.0 : 7.5;
    const amp  = player.fast ? 0.055 : 0.030;
    _bobT += dt;
    ty  += Math.sin(_bobT * freq) * amp;
    tx  += Math.sin(_bobT * freq * 0.5) * amp * 0.5;
    trx += Math.sin(_bobT * freq) * 0.05;
    _swimT = 0;
  } else { _bobT = 0; _swimT = 0; }

  if (!player.flying && player.vy > 1.5)             // jump: hand lifts
    ty += 0.06 * Math.min(1, (player.vy - 1.5) / 7);

  /* swing: forward-back arc — fixed visual period regardless of block hardness */
  const SWING_PERIOD = 0.32;
  const swingProg = miningNow
    ? (mining.elapsed % SWING_PERIOD) / SWING_PERIOD
    : Math.max(0, _swingT);
  if (miningNow || _swingT >= 0) {
    const s = Math.sin(swingProg * Math.PI);
    trx += s * -0.82;
    ty  += s *  0.06;
    tx  += s * -0.04;
  }

  /* eat animation: arm lifts toward face while holding food + place */
  if (eatProg > 0) {
    const ramp = Math.min(1, eatProg * 5);    // reaches full raise in first 20% of eat time
    _eatBobT += dt;
    trx += ramp * 1.0 + Math.sin(_eatBobT * 14) * 0.05 * ramp;  // lift + nibble bob
    ty  += ramp * 0.30;
    tx  += ramp * -0.15;
  } else {
    _eatBobT = 0;
  }

  /* arm skin brightens when holding a light block — instant visual feedback, no chunk lag */
  const targetGlow = (typeof _hlRaw !== 'undefined' && _hlRaw > 0) ? _hlRaw / 14 : 0;
  _armGlow += (targetGlow - _armGlow) * (1 - Math.exp(-dt * 10));
  if (_armGlow > 0.005) _matSkin.color.lerpColors(_skinBase, _skinGlow, _armGlow);
  else _matSkin.color.copy(_skinBase);

  /* lerp toward target */
  const k = 1 - Math.exp(-dt * 18);
  handRoot.position.x += (tx   - handRoot.position.x) * k;
  handRoot.position.y += (ty   - handRoot.position.y) * k;
  handRoot.position.z += (tz   - handRoot.position.z) * k;
  armPivot.rotation.x += (trx  - armPivot.rotation.x) * k;
  armPivot.rotation.y += (try_ - armPivot.rotation.y) * k;
}
