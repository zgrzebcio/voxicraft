'use strict';
/* voxiCraft — day/night sky, sun & moon, shadow mapping */

/* ================================================================================================
   DAY/NIGHT SKY — sun & moon are flat cut-corner squares orbiting the player on a slightly
   south-tilted celestial wheel (rise east, set west); stars ride the same wheel at night.
   They render with depth-test on but no fog, so terrain silhouettes occlude them naturally.

   SHADOWS — hand-rolled shadow mapping (our chunk shader is custom, so three.js lights
   don't apply): every frame the world is depth-rendered from the sun/moon into two small
   maps — solid blocks (full-strength shadows) and leaves/glass (low-intensity shadows) —
   selected via object layers: 0 = solid chunks, 2 = cutout chunks, 3 = water, 1 = no-shadow
   extras (sky, selection box). ~6 texels per block keeps them chunky-but-soft: voxel-friendly.
   ================================================================================================ */
const DAY_LEN = 1200;                       // seconds per full day/night cycle (20 min)
let worldTime = 1 / 24;                     // 0 = sunrise, .25 = noon, .5 = sunset, .75 = midnight; 1/24 = 07:00
let worldDay = 0;                           // increments each full day cycle
let shadowR = parseInt(localStorage.getItem('vc_shadow'));
if (isNaN(shadowR)) shadowR = 110;          // shadow render distance in blocks (0 = off)

camera.layers.enable(1); camera.layers.enable(2); camera.layers.enable(3);

function skyShapeTexture(fill, moon) {      // square with cut corners; craters for the moon
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const k = 10;
  x.fillStyle = fill;
  x.beginPath();
  x.moveTo(k, 0); x.lineTo(64 - k, 0); x.lineTo(64, k); x.lineTo(64, 64 - k);
  x.lineTo(64 - k, 64); x.lineTo(k, 64); x.lineTo(0, 64 - k); x.lineTo(0, k);
  x.closePath(); x.fill();
  if (moon) {
    x.fillStyle = 'rgba(150,160,190,0.6)';
    x.fillRect(14, 18, 10, 10); x.fillRect(34, 34, 12, 12);
    x.fillRect(40, 12, 8, 8);   x.fillRect(16, 40, 8, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
const sunMat  = new THREE.MeshBasicMaterial({ map: skyShapeTexture('#fff3bd', false), transparent: true, depthWrite: false, fog: false });
const moonMat = new THREE.MeshBasicMaterial({ map: skyShapeTexture('#e6ecf8', true),  transparent: true, depthWrite: false, fog: false });
const sunMesh  = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), sunMat);
const moonMesh = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), moonMat);
sunMesh.position.set(100, 0, 0);            // the sky group's rotation carries them around
moonMesh.position.set(-100, 0, 0);

const starGeo = new THREE.BufferGeometry();
{
  const pts = new Float32Array(420 * 3);
  for (let i = 0; i < 420; i++) {
    const z = Math.random() * 2 - 1, ph = Math.random() * Math.PI * 2, rr = Math.sqrt(1 - z * z);
    pts[i * 3] = rr * Math.cos(ph) * 100; pts[i * 3 + 1] = rr * Math.sin(ph) * 100; pts[i * 3 + 2] = z * 100;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
}
const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.7, sizeAttenuation: false,
                                           transparent: true, opacity: 0, depthWrite: false, fog: false });
const stars = new THREE.Points(starGeo, starMat);
const sky = new THREE.Group();
sky.add(sunMesh, moonMesh, stars);
sunMesh.renderOrder = moonMesh.renderOrder = -2;
stars.renderOrder = -3;
sky.traverse(o => o.layers.set(1));         // sky never casts shadows
scene.add(sky);

/* ---------- shadow rig ---------- */
const SHADOW_SIZE = 1024;
function makeShadowRT() {
  const dt = new THREE.DepthTexture(SHADOW_SIZE, SHADOW_SIZE);
  dt.compareFunction = THREE.LessCompare;   // sampler2DShadow + linear filter = hardware PCF
  dt.minFilter = dt.magFilter = THREE.LinearFilter;
  return new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { depthTexture: dt });
}
const rtShadowS = makeShadowRT(), rtShadowL = makeShadowRT();
sharedUniforms.tShadS.value = rtShadowS.depthTexture;
sharedUniforms.tShadL.value = rtShadowL.depthTexture;
renderer.setRenderTarget(rtShadowS); renderer.clear();  // prime: everything lit until first pass
renderer.setRenderTarget(rtShadowL); renderer.clear();
renderer.setRenderTarget(null);

const shadowCam = new THREE.OrthographicCamera(-110, 110, 110, -110, 1, 560);
function applyShadowDist() {
  shadowCam.left = -Math.max(shadowR, 1); shadowCam.right = Math.max(shadowR, 1);
  shadowCam.top = Math.max(shadowR, 1);   shadowCam.bottom = -Math.max(shadowR, 1);
  shadowCam.updateProjectionMatrix();
  shadowDirty = true;
  localStorage.setItem('vc_shadow', shadowR);
}
// slope-scaled offset while drawing the maps kills the "crawling stripes" acne on faces
// that are near-parallel to low morning/evening sun
const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: 2.5, polygonOffsetUnits: 6 });
let shadowDirty = true;                     // world changed since the maps were rendered
let shadowKey = 1e9, shadowTX = 1e9, shadowTY = 1e9;
const BIAS_MAT = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const _sv = new THREE.Vector3(), _sr = new THREE.Vector3(), _su = new THREE.Vector3();
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
const DAY_SKY = new THREE.Color(0x8fc8ee), NIGHT_SKY = new THREE.Color(0x0a0e1e), DUSK_SKY = new THREE.Color(0xf0955c);
const DAY_LIGHT = new THREE.Color(1, 1, 1), NIGHT_LIGHT = new THREE.Color(0.55, 0.65, 0.95), DUSK_LIGHT = new THREE.Color(1, 0.74, 0.52);
const smoothstepJS = (a, b, t) => { t = Math.min(1, Math.max(0, (t - a) / (b - a))); return t * t * (3 - 2 * t); };

const _sf = new THREE.Vector3(), _sd = new THREE.Vector3();
function renderShadowMaps(dir, key) {
  _sd.copy(dir);                            // defensive copy: callers pass shared temps
  // establish the light's basis independent of the player (rotation only depends on dir)
  shadowCam.up.set(0, 0, 1);                // never parallel to the tilted sun path
  shadowCam.position.copy(_sd).multiplyScalar(250);
  shadowCam.lookAt(0, 0, 0);
  shadowCam.updateMatrixWorld(true);
  _sr.setFromMatrixColumn(shadowCam.matrixWorld, 0);   // light-space right
  _su.setFromMatrixColumn(shadowCam.matrixWorld, 1);   // light-space up
  _sf.setFromMatrixColumn(shadowCam.matrixWorld, 2);   // light-space forward

  // snap the window centre to whole texels IN THE LIGHT'S FIXED BASIS — the world-to-map
  // alignment then never shifts sub-texel as the player moves, so edges don't shimmer
  const p = player.pos;
  const texel = (Math.max(shadowR, 1) * 2) / SHADOW_SIZE;
  const tx = Math.round(p.dot(_sr) / texel) * texel;
  const ty = Math.round(p.dot(_su) / texel) * texel;
  if (!shadowDirty && key === shadowKey && tx === shadowTX && ty === shadowTY) return;
  shadowDirty = false; shadowKey = key; shadowTX = tx; shadowTY = ty;

  _sv.copy(_sr).multiplyScalar(tx).addScaledVector(_su, ty).addScaledVector(_sf, p.dot(_sf));
  shadowCam.position.copy(_sv).addScaledVector(_sd, 250);
  shadowCam.lookAt(_sv.x, _sv.y, _sv.z);
  shadowCam.updateMatrixWorld(true);
  sharedUniforms.uShadowMat.value.copy(BIAS_MAT)
    .multiply(shadowCam.projectionMatrix)
    .multiply(shadowCam.matrixWorldInverse);

  scene.overrideMaterial = depthMat;
  shadowCam.layers.set(0);                  // solid chunks -> full shadows
  renderer.setRenderTarget(rtShadowS);
  renderer.clear();
  renderer.render(scene, shadowCam);
  shadowCam.layers.set(2);                  // leaves/glass -> low-intensity shadows
  renderer.setRenderTarget(rtShadowL);
  renderer.clear();
  renderer.render(scene, shadowCam);
  scene.overrideMaterial = null;
  renderer.setRenderTarget(null);
}

const _sunW = new THREE.Vector3();
function updateDayNight(dt) {
  const _prevTime = worldTime;
  worldTime = (worldTime + dt / DAY_LEN) % 1;
  if (worldTime < _prevTime) worldDay++;
  sky.position.copy(camera.position);
  sky.rotation.set(0.12, 0, worldTime * Math.PI * 2);   // tilt south + spin east->west
  sky.scale.setScalar(camera.far * 0.008);              // children sit at radius 100
  sunMesh.getWorldPosition(_sunW);
  const sunDir = _sunW.sub(camera.position).normalize();
  const sunElev = sunDir.y, moonElev = -sunElev;
  sunMesh.lookAt(camera.position);
  moonMesh.lookAt(camera.position);

  const dayF  = smoothstepJS(-0.06, 0.16, sunElev);
  const duskF = Math.exp(-Math.pow(sunElev / 0.12, 2));
  _c1.copy(NIGHT_SKY).lerp(DAY_SKY, dayF).lerp(DUSK_SKY, duskF * 0.55);
  sharedUniforms.fogColor.value.copy(_c1);
  renderer.setClearColor(_c1);
  _c2.copy(NIGHT_LIGHT).lerp(DAY_LIGHT, dayF).lerp(DUSK_LIGHT, duskF * 0.45);
  sharedUniforms.uLightColor.value.copy(_c2);

  const sunI  = 0.74 * smoothstepJS(0.0, 0.22, sunElev);   // day peak ~0.98 total: no overexposure
  const moonI = 0.12 * smoothstepJS(0.0, 0.22, moonElev);
  sharedUniforms.uAmbient.value = 0.17 + 0.15 * dayF;      // ambient floor: how dark cast shadows get
  sharedUniforms.uDirect.value  = Math.max(sunI, moonI);
  sunMat.opacity  = Math.min(1, Math.max(0, (sunElev + 0.10) * 8));
  moonMat.opacity = Math.min(1, Math.max(0, (moonElev + 0.10) * 8));
  starMat.opacity = (1 - dayF) * 0.9;

  const useSun = sunI >= moonI;
  if (shadowR > 0 && Math.max(sunI, moonI) > 0.02) {
    // near real-time: the shadow sun steps ~0.015° (~20/s). The soft PCF filter blurs each
    // step's sub-texel edge shift into a smooth crawl, so even at this rate there's no flicker
    // — shadows track the sun almost continuously (verify FPS holds; it's the pricier setting)
    const STEP = Math.PI / 12000;
    const qa = Math.floor(worldTime * Math.PI * 2 / STEP) * STEP;
    const cosT = Math.cos(0.12), sinT = Math.sin(0.12);
    _sv.set(Math.cos(qa), Math.sin(qa) * cosT, Math.sin(qa) * sinT);
    if (!useSun) _sv.multiplyScalar(-1);
    renderShadowMaps(_sv, qa + (useSun ? 0 : 7));
    sharedUniforms.uShadowOn.value = 1;
  } else {
    sharedUniforms.uShadowOn.value = 0;
  }
}

