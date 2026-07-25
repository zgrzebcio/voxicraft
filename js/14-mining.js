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
   stage, hitting hardness breaks the block. Switching target resets progress. */
const crackCanvas = document.createElement('canvas');
crackCanvas.width = crackCanvas.height = 64;
const crackCtx = crackCanvas.getContext('2d');
const crackTex = new THREE.CanvasTexture(crackCanvas);
crackTex.magFilter = THREE.NearestFilter;
crackTex.minFilter = THREE.NearestFilter;
crackTex.generateMipmaps = false;
function drawCrack(progress) {
  const c = crackCtx, S = 64, cx = S / 2, cy = S / 2;
  c.clearRect(0, 0, S, S);
  if (progress <= 0) { crackTex.needsUpdate = true; return; }
  const maxLen = S * 0.72;                  // reach from centre to just past the block edge
  const len = maxLen * Math.min(1, progress);
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.lineWidth = 2;
  c.lineCap = 'round';
  const rays = 8;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + 0.37;
    const steps = 5;
    c.beginPath();
    c.moveTo(cx, cy);
    for (let s = 1; s <= steps; s++) {
      const r = (len / steps) * s;
      const ja = a + Math.sin(i * 3.1 + s * 1.7) * 0.32;
      c.lineTo(cx + Math.cos(ja) * r, cy + Math.sin(ja) * r);
    }
    c.stroke();
    if (progress > 0.55 && (i & 1) === 0) {
      const br = len * 0.7;
      const bx = cx + Math.cos(a + 0.1) * br, by = cy + Math.sin(a + 0.1) * br;
      const ba = a + 0.9;
      c.beginPath();
      c.moveTo(bx, by);
      c.lineTo(bx + Math.cos(ba) * len * 0.3, by + Math.sin(ba) * len * 0.3);
      c.stroke();
    }
  }
  if (progress > 0.8) {
    c.strokeStyle = 'rgba(0,0,0,0.95)';
    c.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      const a = i * 1.04 + 0.2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6);
      c.lineTo(cx + Math.cos(a + 0.06) * maxLen, cy + Math.sin(a + 0.06) * maxLen);
      c.stroke();
    }
  }
  crackTex.needsUpdate = true;
}
const crackMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.004, 1.004, 1.004),
  new THREE.MeshBasicMaterial({ map: crackTex, transparent: true, depthWrite: false,
                                polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
);
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

