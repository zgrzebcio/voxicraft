'use strict';
/* voxiCraft — selection highlight + survival mining crack overlay */

/* ---------------------------------- selection highlight ---------------------------------- */
const selBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
selBox.visible = false;
selBox.renderOrder = 3;
selBox.layers.set(1);                       // never casts a shadow
scene.add(selBox);

/* ---------------------------------- mining crack overlay ----------------------------------
   Survival-only progressive mining: while LMB / RT is held on a breakable block, the crack
   texture grows from the block's centre out to its edges. Elapsed vs. hardness drives the
   stage, hitting hardness breaks the block. Switching target resets progress.

   Ten authored stage textures (textures/Cracks/destroy_stage_0..9.png) drive the overlay —
   progress picks one, and the material's map is swapped to it. Loaded once up front so the
   first block mined doesn't flash an untextured box. */
const CRACK_STAGES = 10;
const crackTextures = [];
{
  const loader = new THREE.TextureLoader();
  for (let i = 0; i < CRACK_STAGES; i++) {
    const t = loader.load(`textures/Cracks/destroy_stage_${i}.png`);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
    crackTextures.push(t);
  }
}
const crackMat = new THREE.MeshBasicMaterial({
  map: crackTextures[0], transparent: true, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});
function drawCrack(progress) {
  const i = Math.max(0, Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES)));
  if (crackMat.map !== crackTextures[i]) { crackMat.map = crackTextures[i]; crackMat.needsUpdate = true; }
}
const crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), crackMat);
crackMesh.visible = false;
crackMesh.renderOrder = 2;
crackMesh.layers.set(1);
scene.add(crackMesh);
const mining = { active:false, x:0, y:0, z:0, elapsed:0, needed:0, stage:-1 };
function resetMining() {
  mining.active = false;
  mining.stage = -1;
  crackMesh.visible = false;
}

