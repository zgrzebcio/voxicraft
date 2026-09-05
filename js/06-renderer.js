'use strict';
/* voxiCraft — renderer / scene / camera / view distance */

/* ================================================================================================
   RENDERER / SCENE
   ================================================================================================ */
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(SKY);

const scene = new THREE.Scene();
/* `camera` is the ACTIVE camera, not the only one. Split screen gives every player its own
   PerspectiveCamera and swaps this binding around each player's tick and render pass, so all the
   code written against a single camera keeps working untouched. `var` (not const/let) on purpose:
   the swapper in 36-splitscreen.js addresses these globals by name through globalThis, which only
   sees var/function bindings — lexical top-level declarations are invisible there. */
var camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.rotation.order = 'YXZ';
// every camera ever handed out, so resize/view-distance changes reach all of them
const CAMERAS = [camera];
function newPlayerCamera() {
  const c = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, camera.near, camera.far);
  c.rotation.order = 'YXZ';
  /* Copy the VISIBILITY MASK from player one (0.725). Chunk geometry is split across render
     layers so the shadow pass can treat it differently — 0 solid, 2 cutout (leaves, glass and
     every billboard), 3 water and lava — and the sky dome, selection box and crack overlay sit on
     layer 1. 07-sky.js enables those three on `camera` once at load, which only ever reached the
     camera that existed at the time. A camera made later starts on three.js's default mask of
     layer 0 alone, so players two and up saw opaque blocks in an empty void: no leaves, no grass,
     no water, no sky. Inheriting the mask keeps one source of truth for what a player can see. */
  c.layers.mask = CAMERAS[0].layers.mask;
  CAMERAS.push(c);
  return c;
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  // aspect is per-viewport in split screen; the layout pass owns it
  if (typeof relayoutSplitScreen === 'function') relayoutSplitScreen();
  else for (const c of CAMERAS) { c.aspect = window.innerWidth / window.innerHeight; c.updateProjectionMatrix(); }
});

function applyViewDist(persist = true) {
  const far = viewDist * 16;
  sharedUniforms.fogNear.value = far * 0.55;
  sharedUniforms.fogFar.value  = far * 0.98;
  for (const c of CAMERAS) { c.far = far + 96; c.updateProjectionMatrix(); }
  if (persist) localStorage.setItem('vc_dist', viewDist);   // menu backdrop passes false
}

