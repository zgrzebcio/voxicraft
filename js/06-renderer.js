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
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.rotation.order = 'YXZ';

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function applyViewDist(persist = true) {
  const far = viewDist * 16;
  sharedUniforms.fogNear.value = far * 0.55;
  sharedUniforms.fogFar.value  = far * 0.98;
  camera.far = far + 96;
  camera.updateProjectionMatrix();
  if (persist) localStorage.setItem('vc_dist', viewDist);   // menu backdrop passes false
}

