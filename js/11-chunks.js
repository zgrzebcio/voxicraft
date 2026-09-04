'use strict';
/* voxiCraft — chunk manager, meshing pipeline, getBlock/setBlock */

/* ================================================================================================
   CHUNK MANAGER
   ================================================================================================ */
const chunks = new Map();      // "cx,cz" -> chunk record
const editStore = new Map();   // "cx,cz" -> Map(voxelIndex -> value): edits survive unload/reload
/* ---- light sources ----
   `glowLights` is the flat set of every emitter in loaded space. It used to be queried by scanning
   the WHOLE set and `split(',')`-ing each key — from setBlock (via glowNear), from relight, and
   once per chunk load. In a world with lava that set holds thousands of entries, so every block
   edit and every chunk arrival was doing thousands of string splits. That was the single largest
   contributor to the chunk-streaming stutter.

   `glowByChunk` indexes the same data by chunk column and stores decoded coordinates, so a query
   visits only the 3x3 chunks a light could possibly reach from and never parses a string. Both
   structures are maintained together — always go through glowAdd / glowDel / glowClear. */
const glowLights = new Set();  // "x,y,z" of every active emitter
const glowByChunk = new Map(); // "cx,cz" -> Map("x,y,z" -> [x, y, z])

const _glowChunkKey = (x, z) => Math.floor(x / 16) + ',' + Math.floor(z / 16);
function glowAdd(x, y, z) {
  const k = x + ',' + y + ',' + z;
  if (glowLights.has(k)) return;
  glowLights.add(k);
  const ck = _glowChunkKey(x, z);
  let m = glowByChunk.get(ck);
  if (!m) glowByChunk.set(ck, m = new Map());
  m.set(k, [x, y, z]);
}
function glowDel(x, y, z) {
  const k = x + ',' + y + ',' + z;
  if (!glowLights.delete(k)) return;
  const ck = _glowChunkKey(x, z);
  const m = glowByChunk.get(ck);
  if (m) { m.delete(k); if (!m.size) glowByChunk.delete(ck); }
}
function glowClear() { glowLights.clear(); glowByChunk.clear(); }

/* Visit every emitter whose column lies within `r` blocks of (x, z). Callers still do their own
   Y and exact-distance tests; this only narrows the candidate set. */
function forEachGlowNear(x, z, r, fn) {
  const cx0 = Math.floor((x - r) / 16), cx1 = Math.floor((x + r) / 16);
  const cz0 = Math.floor((z - r) / 16), cz1 = Math.floor((z + r) / 16);
  for (let cz = cz0; cz <= cz1; cz++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const m = glowByChunk.get(cx + ',' + cz);
      if (!m) continue;
      for (const p of m.values()) if (fn(p[0], p[1], p[2]) === false) return;
    }
}
const genQueue = [];           // {cx, cz, d2}
const meshQueue = [];
const meshResults = [];        // finished meshes waiting for capped main-thread upload
const key = (cx, cz) => cx + ',' + cz;
const CHUNK_AREA = CHUNK_X * CHUNK_Z;

function getChunk(cx, cz) { return chunks.get(key(cx, cz)); }
function ensureChunk(cx, cz) {
  let c = getChunk(cx, cz);
  if (!c) {
    c = { cx, cz, data: null, light: null, generating: false, meshing: false, queuedMesh: false,
          dirty: false, lit: false, rev: 0, meshes: [null, null, null] };
    chunks.set(key(cx, cz), c);
  }
  return c;
}

let playerCX = 1e9, playerCZ = 1e9;

// rebuild the load/mesh/unload sets — runs when the player crosses a chunk border,
// the view distance changes, or the world resets
function rebuildQueues() {
  genQueue.length = 0;
  meshQueue.length = 0;
  const R = viewDist, RG = R + 1;
  const requeue = [];                       // chunks that were awaiting a (re-)mesh

  for (const [k, c] of chunks) {
    if (c.queuedMesh) { c.queuedMesh = false; requeue.push(c); }  // queue was just cleared
    const dx = c.cx - playerCX, dz = c.cz - playerCZ, d2 = dx * dx + dz * dz;
    if (d2 > (R + 2) * (R + 2)) {           // unload: dispose GPU resources, drop voxel data
      disposeChunkMeshes(c);
      chunks.delete(k);                     // (edits are kept in editStore)
    } else if (d2 > R * R) {
      disposeChunkMeshes(c);                // data ring beyond render radius: keep data only
    }
  }
  for (let dz = -RG; dz <= RG; dz++) {
    for (let dx = -RG; dx <= RG; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > RG * RG) continue;
      const cx = playerCX + dx, cz = playerCZ + dz;
      const c = ensureChunk(cx, cz);
      if (!c.data && !c.generating) genQueue.push({ cx, cz, d2 });
      else if (c.data && d2 <= R * R && !c.meshes[0] && !c.meshes[1] && !c.meshes[2] && !c.meshes[3]) tryQueueMesh(c, d2);
    }
  }
  genQueue.sort((a, b) => a.d2 - b.d2);
  meshQueue.sort((a, b) => a.d2 - b.d2);
  for (const c of requeue)
    if (chunks.has(key(c.cx, c.cz))) tryQueueMesh(c, 0, true);    // don't lose pending edits
  pump();
}

function disposeChunkMeshes(c) {
  for (let i = 0; i < 4; i++) {
    if (c.meshes[i]) {
      scene.remove(c.meshes[i]);
      c.meshes[i].geometry.dispose();       // materials/texture are shared — never disposed
      c.meshes[i] = null;
    }
  }
}

function neighborsReady(c) {
  const n1 = getChunk(c.cx - 1, c.cz), n2 = getChunk(c.cx + 1, c.cz);
  const n3 = getChunk(c.cx, c.cz - 1), n4 = getChunk(c.cx, c.cz + 1);
  return n1 && n1.data && n2 && n2.data && n3 && n3.data && n4 && n4.data;
}

/* `lit` gates meshing on the chunk's own lighting pass having run. Without it there is a race:
   a neighbour's finishChunkGen spreads sky light into this chunk (which CREATES its c.sky array,
   filling only the handful of cells the flood reached) and then queues it for meshing, while its
   own seedSkyForChunk is still sitting in genFinishQueue. dispatchMesh only treats a MISSING
   c.sky as "assume open sky" — a present-but-unseeded one bakes as zero, and the chunk comes out
   pitch black with nothing left to re-mesh it. Opening a save makes this obvious because every
   chunk regenerates at once and the finish queue drains only a few per frame. */
function tryQueueMesh(c, d2, front) {
  if (!c.data || !c.lit || c.queuedMesh || c.meshing || !neighborsReady(c)) return;
  c.queuedMesh = true;
  if (front) meshQueue.unshift({ cx: c.cx, cz: c.cz, d2: 0 });   // edits jump the queue
  else meshQueue.push({ cx: c.cx, cz: c.cz, d2 });
}

/* Cached generated terrain is a raw voxel buffer, and 0.69 widened a voxel from 16 to 32 bits.
   A pre-0.69 cache reinterpreted as uint32 would be garbage, so the key changed with the format
   and the old entries are simply never read again.

   The key is also the ONLY way a generator change reaches a world someone has already visited:
   a chunk is generated once and then read back from this cache forever, which is why the tall
   grass added in 0.6855 never appeared in an existing save. Bump it whenever worldgen starts
   emitting something new that old worlds should get. Regenerating is safe — same seed, same
   terrain — and player edits are stored separately and replayed on top. */
const TERRAIN_KEY = 'terrain691:';
// extract a neighbour's 16x128 border plane (block data OR block light) for cross-chunk work
const ZERO_LIGHT = new Uint8Array(16 * 16 * 200);   // stand-in for un-lit neighbours
function edgeSlice(d, side, Ctor) {
  const s = new Ctor(16 * 200);
  for (let y = 0; y < 200; y++) {
    const yo = y << 8, so = y << 4;
    for (let i = 0; i < 16; i++) {
      if (side === 0) s[i + so] = d[15 + (i << 4) + yo];        // west nb: x=15 plane [z,y]
      else if (side === 1) s[i + so] = d[0 + (i << 4) + yo];    // east nb: x=0
      else if (side === 2) s[i + so] = d[i + (15 << 4) + yo];   // north nb: z=15 plane [x,y]
      else s[i + so] = d[i + yo];                               // south nb: z=0
    }
  }
  return s;
}

function dispatchMesh(worker, c) {
  const nw = getChunk(c.cx - 1, c.cz), ne = getChunk(c.cx + 1, c.cz);
  const nn = getChunk(c.cx, c.cz - 1), ns = getChunk(c.cx, c.cz + 1);
  c.meshing = true; c.queuedMesh = false; c.dirty = false; c.rev++;
  const data = c.data.slice();              // copy: main thread keeps the authoritative data
  // pack glow (low nibble) + sky (high nibble) into one byte per cell for the mesher
  const glow = c.light, skyA = c.sky;
  const light = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
  for (let i = 0; i < light.length; i++)
    light[i] = (glow ? glow[i] : 0) | ((skyA ? skyA[i] : SKY_LEVEL) << 4);
  const packedEdge = (n, side) => {
    const g = edgeSlice(n.light || ZERO_LIGHT, side, Uint8Array);
    if (n.sky) {
      const s = edgeSlice(n.sky, side, Uint8Array);
      for (let i = 0; i < g.length; i++) g[i] |= s[i] << 4;
    } else for (let i = 0; i < g.length; i++) g[i] |= 0xF0;   // unlit neighbour: assume open sky
    return g;
  };
  const sxn = edgeSlice(nw.data, 0, Uint32Array), sxp = edgeSlice(ne.data, 1, Uint32Array);
  const szn = edgeSlice(nn.data, 2, Uint32Array), szp = edgeSlice(ns.data, 3, Uint32Array);
  const lxn = packedEdge(nw, 0), lxp = packedEdge(ne, 1);
  const lzn = packedEdge(nn, 2), lzp = packedEdge(ns, 3);
  worker.postMessage({ type: 'mesh', cx: c.cx, cz: c.cz, rev: c.rev,
                       data: data.buffer, sxn: sxn.buffer, sxp: sxp.buffer, szn: szn.buffer, szp: szp.buffer,
                       light: light.buffer, lxn: lxn.buffer, lxp: lxp.buffer, lzn: lzn.buffer, lzp: lzp.buffer },
                     [data.buffer, sxn.buffer, sxp.buffer, szn.buffer, szp.buffer,
                      light.buffer, lxn.buffer, lxp.buffer, lzn.buffer, lzp.buffer]);
}

// hand queued jobs to idle workers — meshing near chunks beats generating far ones
function pump() {
  for (const w of workers) {
    while (w.busy < 2) {
      let job = null, kind = null;
      while (meshQueue.length || genQueue.length) {
        const m = meshQueue[0], g = genQueue[0];
        if (m && (!g || m.d2 <= g.d2 + 2)) {
          meshQueue.shift();
          const c = getChunk(m.cx, m.cz);
          if (c && c.data && c.queuedMesh && !c.meshing && neighborsReady(c)) { job = c; kind = 'mesh'; break; }
          if (c) c.queuedMesh = false;
        } else if (g) {
          genQueue.shift();
          const c = getChunk(g.cx, g.cz);
          if (c && !c.data && !c.generating) { job = c; kind = 'gen'; break; }
        }
      }
      if (!job) return;
      w.busy++;
      if (kind === 'gen') {
        job.generating = true;
        if (currentWorld && !menuScene) {
          const _cx = job.cx, _cz = job.cz, _w = w, _wid = currentWorld.id;
          idbGet(TERRAIN_KEY + _wid + ':' + key(_cx, _cz)).then(buf => {
            if (buf instanceof ArrayBuffer) {
              _w.busy--;
              const c = getChunk(_cx, _cz);
              if (c && c.generating) onWorkerMessage({ type: 'gen', cx: _cx, cz: _cz, data: buf, _fromSave: true });
              else if (c) c.generating = false;
              pump();
            } else {
              _w.postMessage({ type: 'gen', cx: _cx, cz: _cz });
            }
          });
        } else {
          w.postMessage({ type: 'gen', cx: job.cx, cz: job.cz });
        }
      } else {
        dispatchMesh(w, job);
      }
    }
  }
}

/* Chunks whose data has landed but whose lighting/decoration pass has not run yet. Drained a few
   per frame from the main loop so the per-chunk cost is spread instead of arriving in bursts. */
const genFinishQueue = [];

function finishChunkGen(c) {
  if (!c.data || !chunks.has(key(c.cx, c.cz))) return;      // unloaded while it waited
  /* Register world-generated emitters (lava, natural glowstone) so they actually cast light.

     This walks all 102,400 voxels of the chunk, so what it does PER voxel dominates the pass. It
     used to call blockLightOf(), which masks the id, compares against the furnace and then walks
     a `PROPS[id]?.light` property chain — several times the cost of the test itself. EMITTER_ID
     is a flat 256-entry lookup built once at boot, so the overwhelmingly common case (air, stone,
     dirt — cells that can never emit) is one typed-array read. */
  const wx0 = c.cx * 16, wz0 = c.cz * 16, d = c.data;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (!EMITTER_ID[v & 255]) continue;
    if (blockLightOf(v) > 0) glowAdd(wx0 + (i & 15), i >> 8, wz0 + ((i >> 4) & 15));
  }
  relightForChunk(c.cx, c.cz);             // pour in any nearby glowstone before this meshes
  seedSkyForChunk(c);                      // daylight columns + spread into caves/overhangs
  c.lit = true;                            // only now may it mesh — see the note on tryQueueMesh
  // structures are stamped AFTER terrain, on the main thread — see the header of 34-structures.js
  trySpawnStructureInChunk(c.cx, c.cz);
  // ...and the chunk rolls its mob population, once, the first time it ever exists
  trySpawnEntitiesInChunk(c.cx, c.cz);
  // this chunk (and each neighbour that was waiting on it) may be meshable now
  const R2 = viewDist * viewDist;
  for (const [dx, dz] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const n = getChunk(c.cx + dx, c.cz + dz);
    if (!n || !n.data || n.meshes[0] || n.meshes[1] || n.meshes[2] || n.meshes[3] || n.meshing || n.queuedMesh) continue;
    const ddx = n.cx - playerCX, ddz = n.cz - playerCZ, d2 = ddx * ddx + ddz * ddz;
    if (d2 <= R2) tryQueueMesh(n, d2);
  }
  meshQueue.sort((a, b) => a.d2 - b.d2);
  pump();
}

function processGenFinish(maxPerFrame) {
  let n = 0;
  while (genFinishQueue.length && n < maxPerFrame) { finishChunkGen(genFinishQueue.shift()); n++; }
}

function onWorkerMessage(m) {
  if (m.type === 'error') { console.error('[worker]', m.message); return; }
  const c = getChunk(m.cx, m.cz);
  if (m.type === 'gen') {
    if (!c) return;                          // chunk was unloaded while generating
    c.generating = false;
    c.data = new Uint32Array(m.data);
    if (!m._fromSave && currentWorld && !menuScene)
      idbPut(TERRAIN_KEY + currentWorld.id + ':' + key(m.cx, m.cz), c.data.buffer.slice()).catch(() => {});
    const edits = editStore.get(key(m.cx, m.cz));
    if (edits) for (const [i, v] of edits) c.data[i] = v;   // re-apply player edits
    /* The voxel data is installed immediately — it is only a typed-array wrap and the edit
       replay, and neighbours need it present to know they can mesh. Everything AFTER that (the
       full-chunk emitter scan, the sky seed, glow propagation, structure rolls) is queued, so
       four workers finishing in the same frame no longer means four of those passes back to
       back. That burst was what showed up as periodic stutter while flying. */
    genFinishQueue.push(c);
  } else if (m.type === 'mesh') {
    if (!c) return;
    c.meshing = false;
    if (m.rev === c.rev) { m.rush = !!c.editRush; meshResults.push(m); }   // stale revs are discarded
    if (c.dirty) tryQueueMesh(c, 0, true);
  }
}

// upload at most a few freshly meshed chunks per frame so the main thread never hitches.
// EDIT-triggered results ("rush") are grouped: when a dig at a chunk border re-meshes two
// chunks, applying them on different frames shows a see-through hole for a frame — so a rush
// result waits (a few frames max) until no adjacent rush re-mesh is still in flight, then all
// pending rush results apply together in the same frame, ignoring the per-frame cap.
function applyMeshResults(maxPerFrame) {
  let n = 0;
  let rushWaiting = false;
  for (const m of meshResults) {
    if (!m.rush) continue;
    m.waited = (m.waited || 0) + 1;
    if (m.waited >= 8) continue;                       // safety valve: never hold forever
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nb = getChunk(m.cx + dx, m.cz + dz);
      if (nb && nb.editRush && (nb.meshing || nb.queuedMesh)) { rushWaiting = true; break; }
    }
    if (rushWaiting) break;
  }
  if (!rushWaiting) {
    for (let i = meshResults.length - 1; i >= 0; i--) {
      if (!meshResults[i].rush) continue;
      const m = meshResults.splice(i, 1)[0];
      if (applyOneMesh(m)) n++;
    }
  }
  let qi = 0;
  while (qi < meshResults.length && n < maxPerFrame) {
    const m = meshResults[qi];
    if (m.rush) { qi++; continue; }                    // held for the grouped apply above
    meshResults.splice(qi, 1);
    if (applyOneMesh(m)) n++;
  }
  if (n > 0) shadowDirty = true;            // new/changed geometry must reach the shadow maps
}
function applyOneMesh(m) {
  {
    const c = getChunk(m.cx, m.cz);
    if (!c || m.rev !== c.rev) return false;
    c.editRush = false;
    disposeChunkMeshes(c);
    const midY = (m.minY + m.maxY) / 2;
    const sphere = new THREE.Sphere(new THREE.Vector3(8, midY, 8),
                                    Math.sqrt(128 + Math.pow((m.maxY - m.minY) / 2 + 1, 2)) + 1);
    for (let i = 0; i < 4; i++) {
      const p = m.passes[i];
      if (!p) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
      geo.setAttribute('uv',       new THREE.BufferAttribute(p.uv, 2));
      geo.setAttribute('tile',     new THREE.BufferAttribute(p.tile, 1, false));
      geo.setAttribute('shade',    new THREE.BufferAttribute(p.shade, 1, true));
      geo.setAttribute('blockLight', new THREE.BufferAttribute(p.lite, 1, false));
      geo.setIndex(new THREE.BufferAttribute(p.index, 1));
      geo.boundingSphere = sphere.clone();                  // manual: skip costly compute
      const mesh = new THREE.Mesh(geo, MATERIALS[i]);
      mesh.renderOrder = i;                                 // opaque -> cutout -> water -> lava
      mesh.layers.set(i === 0 ? 0 : i === 1 ? 2 : 3);       // shadow casters: 0 full, 2 weak; water/lava: layer 3
      mesh.position.set(m.cx * 16, 0, m.cz * 16);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;                        // static geometry
      scene.add(mesh);
      c.meshes[i] = mesh;
    }
    return true;
  }
}

/* ---------------------------------- world block access ---------------------------------- */
function getBlock(x, y, z) {
  if (y < 0 || y > 199) return 0;
  const c = getChunk(Math.floor(x / 16), Math.floor(z / 16));
  if (!c || !c.data) return 0;
  return c.data[(x & 15) + ((z & 15) << 4) + (y << 8)];
}
const isSolid = (x, y, z) => PROPS[getBlock(x, y, z) & 255].solid;
const FULL_BOX = [[0, 0, 0, 1, 1, 1]];
// collision sub-boxes of the block at (x,y,z) in world coords, or null if non-solid
function blockBoxes(x, y, z) {
  const val = getBlock(x, y, z);
  const prop = PROPS[val & 255];
  if (!prop.solid) return null;
  if (prop.model === 'stairs') return CORE.stairBoxesAt(getBlock, x, y, z, val);   // neighbour-aware corners
  if (prop.boxesOf) return prop.boxesOf(val);      // variant too wide to index (layered carpet)
  if (prop.boxesByVar) { const b = prop.boxesByVar[(val >> 8) & 255]; if (b) return b; }
  return prop.boxes || FULL_BOX;
}
// raycast / selection / crack box list for the block at (x,y,z) — same corner logic, honouring
// rayBoxesByVar (doors) where present. Returns falsy for full cubes so callers fall back to 1×1×1.
function rayBoxesAt(x, y, z) {
  const val = getBlock(x, y, z), prop = PROPS[val & 255];
  if (prop.model === 'stairs') return CORE.stairBoxesAt(getBlock, x, y, z, val);
  if (prop.boxesOf) return prop.boxesOf(val);
  const bvr = prop.rayBoxesByVar || prop.boxesByVar;
  return bvr ? (bvr[(val >> 8) & 255] || prop.boxes) : prop.boxes;
}

let editRushing = false;   // true while a player edit runs: marks its re-meshes for grouped apply
// set by 34-structures.js around bulk stamping; see the lighting note inside setBlock
let structBulkLight = false;
function setBlock(x, y, z, val) {
  if (y < 0 || y > 199) return;
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  const c = getChunk(cx, cz);
  if (!c || !c.data) return;
  editRushing = true;
  const lx = x & 15, lz = z & 15;
  const i = lx + (lz << 4) + (y << 8);
  if (c.data[i] === val) return;
  const oldVal = c.data[i], oldId = oldVal & 255, newId = val & 255;
  c.data[i] = val;
  const oldLit = blockLightOf(oldVal) > 0, newLit = blockLightOf(val) > 0;
  if (oldLit && !newLit) glowDel(x, y, z);
  if (newLit && !oldLit) glowAdd(x, y, z);
  // leveling ledger: remember cells the player placed into, forget them when they are cleared
  if (typeof notePlacedCell === 'function') notePlacedCell(x, y, z, newId);
  let edits = editStore.get(key(cx, cz));
  if (!edits) editStore.set(key(cx, cz), edits = new Map());
  edits.set(i, val);
  markDirty(c);
  // faces on the border also live in the neighbour's mesh
  if (lx === 0)  markDirty(getChunk(cx - 1, cz));
  if (lx === 15) markDirty(getChunk(cx + 1, cz));
  if (lz === 0)  markDirty(getChunk(cx, cz - 1));
  if (lz === 15) markDirty(getChunk(cx, cz + 1));
  /* Lighting is by far the most expensive part of a setBlock: a single opacity change kicks off a
     sky-light BFS, and carving a dungeon room is a couple of hundred of them back to back. While
     a structure is being stamped the flag below suppresses the per-cell work, and 34-structures.js
     re-lights each affected chunk ONCE when the job finishes. Everything else in setBlock still
     runs, so the world data and the edit store stay correct either way. */
  if (!structBulkLight) {
    // re-flood block light if this change is/was a light source or sits within reach of one
    // (oldLit matters: a removed source is already out of glowLights, so glowNear misses it)
    if (oldLit || newLit || glowNear(x, y, z)) relight(x, y, z);
    // sky light changes on ANY opacity edit (dig opens daylight in, place casts shade)
    if (PROPS[oldId].opaque !== PROPS[newId].opaque) reskyAround(x, y, z);
  }
  // snow-on-grass: the grass directly under a snow block wears snowy sides (variant), and reverts
  // to plain grass when the snow is removed. Recursive setBlock is safe (grass fires no snow hook).
  // snow carpet counts as snow cover here too — a trunk replacing a carpet must clear the rim
  // a layered carpet only frosts the grass under it when one of its layers is actually snow —
  // a pile of pure leaf litter must leave the rim green
  const _snowy = (v) => {
    const i = v & 255;
    if (i === B.SNOW || i === B.SNOW_CARPET) return true;
    if (i !== B.CARPET) return false;
    for (let l = carpetTop(v) - 1; l >= 0; l--) if (carpetMat(v, l) === CARPET_MAT.SNOW) return true;
    return false;
  };
  if (_snowy(val) && !_snowy(oldVal) && (getBlock(x, y - 1, z) & 255) === B.GRASS)
    setBlock(x, y - 1, z, B.GRASS | (V.GRASS_SNOWY << 8));
  if (_snowy(oldVal) && !_snowy(val)) {
    const below = getBlock(x, y - 1, z);
    if ((below & 255) === B.GRASS && ((below >> 8) & 255) === V.GRASS_SNOWY) setBlock(x, y - 1, z, B.GRASS);
  }
  // fluid contact reactions: placing water next to lava (or vice versa) must trigger the
  // opposite fluid's own tick queue so the transmute rules (obsidian/stone/cobble) fire.
  if (newId === B.WATER) queueLavaAround(x, y, z);
  if (newId === B.LAVA)  queueWaterAround(x, y, z);
  // any block change ripples nearby fluids: cleared cells let them fill, placed cells might cut
  // off flow. Cheap because queueWaterAt/queueLavaAt no-op unless neighbour is actually fluid.
  if (newId !== B.WATER && newId !== B.LAVA) {
    queueWaterAround(x, y, z);
    queueLavaAround(x, y, z);
  }
  // fluid on top of grass block wears it back to dirt (any level, water or lava)
  if ((newId === B.WATER || newId === B.LAVA) && y > 0 && (getBlock(x, y - 1, z) & 255) === B.GRASS)
    setBlock(x, y - 1, z, B.DIRT);
  // water source destroyed (replaced by anything non-water): dry every flowing cell it fed
  if (oldId === B.WATER && ((oldVal >> 8) & 15) === 0 && newId !== B.WATER) dryWaterFrom(x, y, z);
  // same rule for lava sources
  if (oldId === B.LAVA && ((oldVal >> 8) & 15) === 0 && newId !== B.LAVA) dryLavaFrom(x, y, z);
  // furnace removed/replaced: spill its contents and drop the state
  if (oldId === B.FURNACE && newId !== B.FURNACE) furnaceBroken(x, y, z);
  // door half removed: take the other half + the animated mesh with it
  if (oldId === B.DOOR && newId !== B.DOOR) doorBroken(x, y, z, oldVal);
  // bed half removed: take the other half + the mesh with it
  if (oldId === B.BED && newId !== B.BED) bedBroken(x, y, z, oldVal);
  // chest removed/replaced: spill its contents and drop the mesh
  if (oldId === B.CHEST && newId !== B.CHEST) chestBroken(x, y, z, oldVal);
  // structure block gone: forget its size/name settings and drop its outline
  if (oldId === B.STRUCTURE_BLOCK && newId !== B.STRUCTURE_BLOCK) structBlockBroken(x, y, z);
  // placing a solid block against a cactus's side snaps the cactus off (column chain-breaks up).
  // Cactus is exempt from its own rule — arms attach side-on to the trunk.
  if (PROPS[newId]?.solid && newId !== B.CACTUS)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if ((getBlock(nx, y, nz) & 255) === B.CACTUS) {
        setBlock(nx, y, nz, B.AIR);
        if (!player.canFly)
          for (const d of blockDrop(B.CACTUS)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, nx, y, nz);
      }
    }
  // tall grass: breaking the UPPER half removes the lower half too (whole plant goes)
  if (newId === B.AIR && oldId === B.TALL_UPPER && (getBlock(x, y - 1, z) & 255) === B.TALL_LOWER)
    setBlock(x, y - 1, z, B.AIR);
  /* Door / bed support: both need solid ground under them, so digging out any ONE of the cells
     they stand on drops the whole thing. Each block's own break hook then takes its other half,
     so only the cell directly above has to be handled here. Guarded on the new block not being
     solid, otherwise swapping dirt for stone under a door would demolish it. */
  if (!PROPS[newId]?.solid && y + 1 <= 199) {
    const upVal = getBlock(x, y + 1, z), upId = upVal & 255;
    const isDoorBottom = upId === B.DOOR && !((upVal >> 8) & 8);
    if (isDoorBottom || upId === B.BED) {
      setBlock(x, y + 1, z, B.AIR);
      if (!player.canFly)
        for (const d of blockDrop(upId)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, y + 1, z);
    }
  }
  // billboard support: breaking the block under a cross-model block (torch, mushroom) pops it off
  if (newId === B.AIR && y + 1 <= 199) {
    const above = getBlock(x, y + 1, z) & 255;
    if (PROPS[above]?.model === 'cross' || above === B.CACTUS) {   // cactus columns chain-break upward
      setBlock(x, y + 1, z, B.AIR);
      if (!player.canFly)
        for (const d of blockDrop(above)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, y + 1, z);
    }
  }
  /* A cactus arm hangs off the SIDE of its trunk, so the upward chain-break above never reached
     it — cutting the trunk out left arms floating. When a cactus goes, take any neighbouring cell
     that is a cactus lying horizontally (variant axis 1 or 2, i.e. an arm root rather than another
     column). Removing that root re-enters this hook, and the upward rule carries the rest of the
     arm with it. */
  if (oldId === B.CACTUS && newId !== B.CACTUS)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      const nv = getBlock(nx, y, nz);
      if ((nv & 255) !== B.CACTUS || (((nv >> 8) & 3) === 0)) continue;   // vertical = its own trunk
      setBlock(nx, y, nz, B.AIR);
      if (!player.canFly)
        for (const d of blockDrop(B.CACTUS)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, nx, y, nz);
    }
  // sulfur down-tip hangs from the block ABOVE — pop it when that ceiling block is destroyed
  if (newId === B.AIR && y > 0) {
    const bVal = getBlock(x, y - 1, z);
    if ((bVal & 255) === B.SULFUR_UP_TIP && ((bVal >> 8) & 1)) {
      setBlock(x, y - 1, z, B.AIR);
      if (!player.canFly)
        for (const d of blockDrop(B.SULFUR_UP_TIP)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, y - 1, z);
    }
  }
  // gravity: clear below a gravity block → it falls; gravity block placed above air → also falls
  if (newId === B.AIR && y + 1 <= 199) scheduleFall(x, y + 1, z);
  if ((newId === B.SAND || newId === B.RED_SAND || newId === B.GRAVEL) && y > 0 && (getBlock(x, y - 1, z) & 255) === B.AIR)
    scheduleFall(x, y, z);
  editRushing = false;
}
/* ---- layered carpet: one cell, up to CARPET_MAX layers of mixed material ----
   Everything that creates litter or snow cover goes through addCarpetLayer, so a fresh leaf
   landing on a snow drift just pushes another material onto the same cell instead of needing a
   free cell of its own. Legacy single-material carpets from pre-0.69 saves are converted on
   contact, which is also how they gain the ability to mix. */
function carpetValAt(x, y, z) {
  const v = getBlock(x, y, z), id = v & 255;
  if (id === B.CARPET) return v;
  const mat = CARPET_MAT_OF[id];                       // legacy carpet: rebuild it as a stack
  if (!mat) return null;
  return carpetFill(mat, Math.min(CARPET_MAX, ((v >> 8) & 255) + 1));
}
// push one layer of `mat` onto the cell. Returns false if it is full or not a carpet cell.
function addCarpetLayer(x, y, z, mat) {
  const cur = carpetValAt(x, y, z);
  if (cur === null) {
    if (!isPlaceableInto(getBlock(x, y, z) & 255)) return false;
    setBlock(x, y, z, carpetFill(mat, 1));
    return true;
  }
  const next = carpetPush(cur, mat);
  if (next === cur) return false;                      // already CARPET_MAX layers deep
  setBlock(x, y, z, next);
  return true;
}
/* Breaking a stack takes the TOP layer only and hands back that layer's own carpet block, so a
   drift you built out of snow and three kinds of leaf comes apart in the order it went on. */
function carpetBreakInfo(val) {
  const id = val & 255;
  if (id !== B.CARPET && !CARPET_MAT_OF[id]) return null;
  const cur = id === B.CARPET ? val : carpetFill(CARPET_MAT_OF[id], Math.min(CARPET_MAX, ((val >> 8) & 255) + 1));
  const top = carpetTop(cur);
  if (!top) return null;
  const mat = carpetMat(cur, top - 1);
  return { dropId: CARPET_MAT_ITEM[mat] || B.SNOW_CARPET, mat, remainVal: carpetPop(cur) };
}
// is any glowstone within light range of (x,y,z)? (so opaque edits there re-shadow correctly)
function glowNear(x, y, z) {
  let hit = false;
  forEachGlowNear(x, z, GLOW_LEVEL, (gx, gy, gz) => {
    if (Math.abs(gx - x) <= GLOW_LEVEL && Math.abs(gy - y) <= GLOW_LEVEL && Math.abs(gz - z) <= GLOW_LEVEL) {
      hit = true;
      return false;                       // found one — stop walking
    }
  });
  if (hit) return true;
  if (_plyGlow && Math.abs(_plyGlow[0]-x) <= GLOW_LEVEL && Math.abs(_plyGlow[1]-y) <= GLOW_LEVEL && Math.abs(_plyGlow[2]-z) <= GLOW_LEVEL) return true;
  return false;
}
function markDirty(c) {
  if (!c || !c.data) return;
  if (editRushing) c.editRush = true;       // player edit: apply this re-mesh grouped with siblings
  if (c.meshing) c.dirty = true;
  else tryQueueMesh(c, 0, true);
}

