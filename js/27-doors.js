'use strict';
/* voxiCraft — oak door: 2-cell block (1 wide × 2 high × 1/8 thick), rot:'side' facing,
   right-click toggles open with a swinging animation, open door is passable.

   The mesher emits NOTHING for door cells — each door is one three.js mesh (a thin textured
   box) hinged at a corner, rotated smoothly between closed/open angles. Block cells still
   exist for collision + raycast; their boxes swap with the open bit so you can walk through.

   variant byte: bits 0-1 facing (0:+Z 1:-Z 2:+X 3:-X), bit 2 (4) open, bit 3 (8) upper half. */

const DOORS = new Map();   // "x,y,z" of the BOTTOM cell -> {group, x, y, z}
const DOOR_T = 0.125;
// per-facing hinge placement. The open pose gets its own x/z offset (not just a rotation): a
// corner-hinged panel pokes out of the cell by DOOR_T when swung, so the open offset nudges it
// back flush against the side wall INSIDE the cell. Position + rotation both lerp during the swing.
// [closedX, closedZ, closedRotY, openX, openZ, openRotY]
const DOOR_ORI = [
  [0,       0,          0,            DOOR_T, 0,          -Math.PI / 2],  // facing +Z
  [0,       1 - DOOR_T, 0,            0,      1,           Math.PI / 2],  // facing -Z
  [DOOR_T,  0,          -Math.PI / 2, 0,      0,           0          ],  // facing +X
  [1,       0,          -Math.PI / 2, 1,      DOOR_T,     -Math.PI    ],  // facing -X
];

let _doorTex = null;
function doorTexture() {
  if (_doorTex) return _doorTex;
  _doorTex = new THREE.Texture(IMAGES.oak_door);
  _doorTex.colorSpace = THREE.SRGBColorSpace;
  _doorTex.magFilter = THREE.NearestFilter;
  _doorTex.minFilter = THREE.NearestFilter;
  _doorTex.needsUpdate = true;
  return _doorTex;
}
const DOOR_EDGE_RGB = 0x8a6b41;
// hinged panel geometry with the -Z face's U flipped so the back isn't mirrored
function doorPanelGeom(hinged = true) {
  const geo = new THREE.BoxGeometry(1, 2, DOOR_T);
  if (hinged) geo.translate(0.5, 1, DOOR_T / 2);       // hinge corner at the local origin
  const uv = geo.attributes.uv;                        // face order +X,-X,+Y,-Y,+Z,-Z (4 verts each)
  for (let i = 20; i < 24; i++) uv.setX(i, 1 - uv.getX(i));
  uv.needsUpdate = true;
  return geo;
}
function doorMaterials() {                             // fresh per door — tinted by world light
  const face = new THREE.MeshBasicMaterial({ map: doorTexture(), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const edge = new THREE.MeshBasicMaterial({ color: new THREE.Color(DOOR_EDGE_RGB).convertSRGBToLinear() });
  return { mats: [edge, edge, edge, edge, face, face], face, edge };
}

function registerDoor(x, y, z, facing, open) {
  const k = x + ',' + y + ',' + z;
  if (DOORS.has(k)) return;
  const m = doorMaterials();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(doorPanelGeom(), m.mats));
  const o = DOOR_ORI[facing & 3];
  group.position.set(x + (open ? o[3] : o[0]), y, z + (open ? o[4] : o[1]));
  group.rotation.y = open ? o[5] : o[2];
  scene.add(group);
  DOORS.set(k, { group, x, y, z, face: m.face, edge: m.edge, lastB: -1 });
}
function removeDoorMesh(k) {
  const d = DOORS.get(k);
  if (d) {
    scene.remove(d.group);
    d.group.children[0].geometry.dispose();
    d.face.dispose(); d.edge.dispose();
    DOORS.delete(k);
  }
}
function clearDoors() { for (const k of [...DOORS.keys()]) removeDoorMesh(k); }

// one half was broken / replaced: remove the mesh and the other half (guarded, no recursion loop)
function doorBroken(x, y, z, oldVal) {
  const upper = ((oldVal >> 8) & 8) !== 0;
  removeDoorMesh(x + ',' + (upper ? y - 1 : y) + ',' + z);
  const oy = upper ? y - 1 : y + 1;
  if ((getBlock(x, oy, z) & 255) === B.DOOR) setBlock(x, oy, z, B.AIR);
}

/* Double door: the bottom cell of a same-facing door standing directly beside this one, across
   the facing. Unlike chests this needs no stored state — a door pair is symmetric, so both
   halves find each other by the same rule and there is nothing to disambiguate. */
function doorPartnerCell(x, by, z, facing) {
  const dirs = (facing === 0 || facing === 1) ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  for (const [dx, dz] of dirs) {
    const nv = getBlock(x + dx, by, z + dz);
    if ((nv & 255) !== B.DOOR) continue;
    const nva = (nv >> 8) & 255;
    if ((nva & 3) === facing && !(nva & 8)) return { x: x + dx, z: z + dz };   // bottom half only
  }
  return null;
}

// right-click either half: flip the open bit on both halves (facing bits preserved), and on the
// neighbouring door if this is a double. One sound for the whole action, however many panels move.
function toggleDoor(x, y, z) {
  const val = getBlock(x, y, z);
  if ((val & 255) !== B.DOOR) return;
  const by = ((val >> 8) & 8) ? y - 1 : y;
  const bval = getBlock(x, by, z);
  if ((bval & 255) !== B.DOOR) return;
  const bvar = (bval >> 8) & 255;
  const facing = bvar & 3;
  const opening = !(bvar & 4);
  const nv = facing | (opening ? 4 : 0);
  setBlock(x, by, z, B.DOOR | (nv << 8));
  setBlock(x, by + 1, z, B.DOOR | ((nv | 8) << 8));
  const p = doorPartnerCell(x, by, z, facing);
  if (p) {
    setBlock(p.x, by, p.z, B.DOOR | (nv << 8));
    setBlock(p.x, by + 1, p.z, B.DOOR | ((nv | 8) << 8));
  }
  playSound(opening ? 'doorOpen' : 'doorClose',
            { gain: 0.8, pos: { x: x + 0.5, y: by + 1, z: z + 0.5 } });
}

// per-frame: swing each door toward its block state's angle; hide while the chunk is unloaded
function updateDoors(dt) {
  for (const [k, d] of DOORS) {
    const c = getChunk(Math.floor(d.x / 16), Math.floor(d.z / 16));
    if (!c || !c.data) { d.group.visible = false; continue; }
    const val = getBlock(d.x, d.y, d.z);
    if ((val & 255) !== B.DOOR) { removeDoorMesh(k); continue; }
    d.group.visible = true;
    const varb = (val >> 8) & 255;
    const o = DOOR_ORI[varb & 3];
    const open = (varb & 4);
    const target = open ? o[5] : o[2];
    const diff = target - d.group.rotation.y;
    if (Math.abs(diff) > 0.002) {
      const step = Math.max(-9 * dt, Math.min(9 * dt, diff));
      d.group.rotation.y += step;
    } else d.group.rotation.y = target;
    // slide the small flush-correction offset in lockstep with the swing, so the panel ends up
    // flat against the wall inside its cell instead of poking out by the thickness
    const tpx = d.x + (open ? o[3] : o[0]), tpz = d.z + (open ? o[4] : o[1]);
    const lerp = Math.min(1, 12 * dt);
    d.group.position.x += (tpx - d.group.position.x) * lerp;
    d.group.position.z += (tpz - d.group.position.z) * lerp;
    // tint by world light at the door cell (same curves as the chunk shader, approximated)
    const bl = getLightWorld(d.x, d.y, d.z) / 15;
    const sky = getSkyWorld(d.x, d.y, d.z) / 15;
    const skyF = 0.12 + 0.88 * sky * sky;
    const sun = sharedUniforms.uAmbient.value + sharedUniforms.uDirect.value;
    const b = Math.min(1, skyF * sun * 0.92 + (bl * 0.45 + bl * bl * 0.85));
    if (Math.abs(b - d.lastB) > 0.02) {
      d.lastB = b;
      d.face.color.setScalar(b).convertSRGBToLinear();
      d.edge.color.set(DOOR_EDGE_RGB).multiplyScalar(b).convertSRGBToLinear();
    }
  }
}
