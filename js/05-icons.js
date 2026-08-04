'use strict';
/* voxiCraft — automatic 3D block icon renderer */

/* ================================================================================================
   BLOCK ICON RENDERER — fully automatic 3D icons. Each icon is produced by meshing a single
   block through the SAME VOXEL_CORE mesher and drawing it with the SAME atlas materials the
   world uses, into an offscreen render target with a Minecraft-style dimetric camera.
   Because it goes through the real model pipeline, every future block — new textures, tints,
   variants, or custom non-cube models (stairs, doors, ...) — gets a correct 3D icon with zero
   extra art or per-block code. Non-block ITEMS keep classic flat icons: give an inventory
   entry `{ item: 'name', icon2d: 'textureName' }` instead of `{ block: id }`.
   ================================================================================================ */
const ICON3D = {};    // "id:variant" -> dataURL (transparent png)
const ICON_IMG = {};  // "id:variant" -> HTMLImageElement (for canvas drawing, e.g. the radial)

function renderItemIcon(id) {
  const key = 'item:' + id;
  if (ICON3D[key]) return ICON3D[key];
  const url = ITEM_TEXTURES[ITEM_PROPS[id]?.icon] || '';
  ICON3D[key] = url;
  return url;
}

// shared tail: render a prepared icon scene to a transparent data URL
function _renderIconScene(scene, cam) {
  const SIZE = 256;
  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const px = new Uint8Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, px);
  renderer.setRenderTarget(null);
  renderer.setClearColor(SKY, 1);
  rt.dispose();
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = SIZE;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++)
    img.data.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
  ctx.putImageData(img, 0, 0);
  return cvs.toDataURL();
}

function renderBlockIcon(id, variant = 0) {
  if (id >= 256) return renderItemIcon(id);
  const key = id + ':' + variant;
  if (ICON3D[key]) return ICON3D[key];
  if (id === B.CHEST) {                   // chest has no chunk-mesh model — render its real mesh
    const scene = new THREE.Scene();
    const m = buildChestMesh();
    m.group.position.set(-0.5, -0.5, -0.5);   // centre the cell on the origin
    scene.add(m.group);
    const cam = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
    cam.position.set(1.4, 1.15, 1.8);
    cam.lookAt(0, -0.05, 0);
    const url = _renderIconScene(scene, cam);
    m.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    for (const mt of m.mats) mt.dispose();
    ICON3D[key] = url;
    const im = new Image(); im.src = url; ICON_IMG[key] = im;
    return url;
  }
  if (id === B.BED) {                     // bed has no chunk-mesh model — render its real mesh
    const scene = new THREE.Scene();
    const m = bedMattressMesh();
    const legs = bedUndersideMesh();
    const g = new THREE.Group();
    g.add(m.mesh);
    g.add(legs.mesh);
    g.position.set(-0.5, -0.3, -1);       // centre the 1x2 footprint on the origin
    scene.add(g);
    const cam = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 12);
    cam.position.set(2.0, 1.9, 2.2);
    cam.lookAt(0, 0, 0);
    const url = _renderIconScene(scene, cam);
    for (const c of g.children) c.geometry.dispose();
    for (const mt of [...m.mats, ...legs.mats]) mt.dispose();
    ICON3D[key] = url;
    const im = new Image(); im.src = url; ICON_IMG[key] = im;
    return url;
  }
  if (id === B.DOOR) {                    // door has no chunk-mesh model — render its panel mesh
    const scene = new THREE.Scene();
    const m = doorMaterials();
    const mesh = new THREE.Mesh(doorPanelGeom(false), m.mats);   // centred, unhinged
    scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1.25, 1.25, 1.25, -1.25, 0.1, 10);
    cam.position.set(1.8, 1.6, 1.8);
    cam.lookAt(0, 0, 0);
    const url = _renderIconScene(scene, cam);
    mesh.geometry.dispose(); m.face.dispose(); m.edge.dispose();
    ICON3D[key] = url;
    const im = new Image(); im.src = url; ICON_IMG[key] = im;
    return url;
  }

  // 1) mesh one lone block through the real chunk mesher
  const data = new Uint16Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
  data[CORE.idx(8, 64, 8)] = id | (variant << 8);
  const empty = () => new Uint16Array(16 * 200).buffer;
  const lite = () => new Uint8Array(16 * 200).fill(0xF0).buffer;
  // icons render fully sky-lit (high nibble 15); if the block itself glows, brighten its own
  // faces too so the icon reads as "lit" (glowstone faces get glow level 15 in the icon mesh)
  const lightArr = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z).fill(0xF0);
  if (PROPS[id].light) {
    for (const d of [[9,64,8],[7,64,8],[8,65,8],[8,63,8],[8,64,9],[8,64,7]]) lightArr[CORE.idx(d[0], d[1], d[2])] = 0xFF;
  }
  const r = CORE.meshChunk(data.buffer, empty(), empty(), empty(), empty(),
                           lightArr.buffer, lite(), lite(), lite(), lite());

  // 2) draw it with the world's materials into an offscreen target
  const scene = new THREE.Scene();
  for (let p = 0; p < 3; p++) {
    const g = r.passes[p];
    if (!g) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(g.uv, 2));
    geo.setAttribute('tile',     new THREE.BufferAttribute(g.tile, 1, false));
    geo.setAttribute('shade',    new THREE.BufferAttribute(g.shade, 1, true));
    geo.setAttribute('blockLight', new THREE.BufferAttribute(g.lite, 1, false));
    geo.setIndex(new THREE.BufferAttribute(g.index, 1));
    geo.translate(-8.5, -64.5, -8.5);           // centre the block on the origin
    const mesh = new THREE.Mesh(geo, MATERIALS[p]);
    mesh.renderOrder = p;
    scene.add(mesh);
  }
  const cam = new THREE.OrthographicCamera(-0.82, 0.82, 0.82, -0.82, 0.1, 10);
  cam.position.set(1.6, 1.5, 1.6);              // MC-ish dimetric: top + two shaded sides
  cam.lookAt(0, 0, 0);

  const url = _renderIconScene(scene, cam);     // supersampled; browser smooth-downscales
  scene.traverse(o => o.geometry && o.geometry.dispose());
  ICON3D[key] = url;
  const im = new Image();
  im.src = url;
  ICON_IMG[key] = im;
  return url;
}

// icon for any inventory entry — 3D render for blocks, classic flat texture for items
function iconSrc(entry) {
  if (entry.block !== undefined) return renderBlockIcon(entry.block, entry.variant || 0);
  return TEXTURES[entry.icon2d];
}

