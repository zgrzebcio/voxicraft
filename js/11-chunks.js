'use strict';
/* voxiCraft — chunk manager, meshing pipeline, getBlock/setBlock */

/* ================================================================================================
   CHUNK MANAGER
   ================================================================================================ */
const chunks = new Map();      // "cx,cz" -> chunk record
const editStore = new Map();   // "cx,cz" -> Map(voxelIndex -> value): edits survive unload/reload
const glowLights = new Set();  // "x,y,z" of placed glowstone blocks (terrain never generates them)
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
          dirty: false, rev: 0, meshes: [null, null, null] };
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

function tryQueueMesh(c, d2, front) {
  if (!c.data || c.queuedMesh || c.meshing || !neighborsReady(c)) return;
  c.queuedMesh = true;
  if (front) meshQueue.unshift({ cx: c.cx, cz: c.cz, d2: 0 });   // edits jump the queue
  else meshQueue.push({ cx: c.cx, cz: c.cz, d2 });
}

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
  const sxn = edgeSlice(nw.data, 0, Uint16Array), sxp = edgeSlice(ne.data, 1, Uint16Array);
  const szn = edgeSlice(nn.data, 2, Uint16Array), szp = edgeSlice(ns.data, 3, Uint16Array);
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
          idbGet('terrain:' + _wid + ':' + key(_cx, _cz)).then(buf => {
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

function onWorkerMessage(m) {
  if (m.type === 'error') { console.error('[worker]', m.message); return; }
  const c = getChunk(m.cx, m.cz);
  if (m.type === 'gen') {
    if (!c) return;                          // chunk was unloaded while generating
    c.generating = false;
    c.data = new Uint16Array(m.data);
    if (!m._fromSave && currentWorld && !menuScene)
      idbPut('terrain:' + currentWorld.id + ':' + key(m.cx, m.cz), c.data.buffer.slice()).catch(() => {});
    const edits = editStore.get(key(m.cx, m.cz));
    if (edits) for (const [i, v] of edits) c.data[i] = v;   // re-apply player edits
    // register world-generated light emitters (lava, natural glowstone) into glowLights so they
    // actually cast light — otherwise only player-placed emitters would light the world.
    {
      const wx0 = m.cx * 16, wz0 = m.cz * 16;
      for (let i = 0; i < c.data.length; i++) {
        if (blockLightOf(c.data[i]) > 0)
          glowLights.add((wx0 + (i & 15)) + ',' + (i >> 8) + ',' + (wz0 + ((i >> 4) & 15)));
      }
    }
    relightForChunk(m.cx, m.cz);             // pour in any nearby glowstone before this meshes
    seedSkyForChunk(c);                      // daylight columns + spread into caves/overhangs
    // this chunk (and each neighbour that was waiting on it) may be meshable now
    const R2 = viewDist * viewDist;
    for (const [dx, dz] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const n = getChunk(m.cx + dx, m.cz + dz);
      if (!n || !n.data || n.meshes[0] || n.meshes[1] || n.meshes[2] || n.meshes[3] || n.meshing || n.queuedMesh) continue;
      const ddx = n.cx - playerCX, ddz = n.cz - playerCZ, d2 = ddx * ddx + ddz * ddz;
      if (d2 <= R2) tryQueueMesh(n, d2);
    }
    meshQueue.sort((a, b) => a.d2 - b.d2);
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
  if (prop.boxesByVar) { const b = prop.boxesByVar[(val >> 8) & 255]; if (b) return b; }
  return prop.boxes || FULL_BOX;
}
// raycast / selection / crack box list for the block at (x,y,z) — same corner logic, honouring
// rayBoxesByVar (doors) where present. Returns falsy for full cubes so callers fall back to 1×1×1.
function rayBoxesAt(x, y, z) {
  const val = getBlock(x, y, z), prop = PROPS[val & 255];
  if (prop.model === 'stairs') return CORE.stairBoxesAt(getBlock, x, y, z, val);
  const bvr = prop.rayBoxesByVar || prop.boxesByVar;
  return bvr ? (bvr[(val >> 8) & 255] || prop.boxes) : prop.boxes;
}

let editRushing = false;   // true while a player edit runs: marks its re-meshes for grouped apply
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
  if (oldLit && !newLit) glowLights.delete(x + ',' + y + ',' + z);
  if (newLit && !oldLit) glowLights.add(x + ',' + y + ',' + z);
  let edits = editStore.get(key(cx, cz));
  if (!edits) editStore.set(key(cx, cz), edits = new Map());
  edits.set(i, val);
  markDirty(c);
  // faces on the border also live in the neighbour's mesh
  if (lx === 0)  markDirty(getChunk(cx - 1, cz));
  if (lx === 15) markDirty(getChunk(cx + 1, cz));
  if (lz === 0)  markDirty(getChunk(cx, cz - 1));
  if (lz === 15) markDirty(getChunk(cx, cz + 1));
  // re-flood block light if this change is/was a light source or sits within reach of one
  // (oldLit matters: a removed source is already out of glowLights, so glowNear misses it)
  if (oldLit || newLit || glowNear(x, y, z)) relight(x, y, z);
  // sky light changes on ANY opacity edit (dig opens daylight in, place casts shade)
  if (PROPS[oldId].opaque !== PROPS[newId].opaque) reskyAround(x, y, z);
  // snow-on-grass: the grass directly under a snow block wears snowy sides (variant), and reverts
  // to plain grass when the snow is removed. Recursive setBlock is safe (grass fires no snow hook).
  if (newId === B.SNOW && oldId !== B.SNOW && (getBlock(x, y - 1, z) & 255) === B.GRASS)
    setBlock(x, y - 1, z, B.GRASS | (V.GRASS_SNOWY << 8));
  if (oldId === B.SNOW && newId !== B.SNOW) {
    const below = getBlock(x, y - 1, z);
    if ((below & 255) === B.GRASS && ((below >> 8) & 255) === V.GRASS_SNOWY) setBlock(x, y - 1, z, B.GRASS);
  }
  // furnace removed/replaced: spill its contents and drop the state
  if (oldId === B.FURNACE && newId !== B.FURNACE) furnaceBroken(x, y, z);
  // door half removed: take the other half + the animated mesh with it
  if (oldId === B.DOOR && newId !== B.DOOR) doorBroken(x, y, z, oldVal);
  // placing a solid block against a cactus's side snaps the cactus off (column chain-breaks up)
  if (PROPS[newId]?.solid)
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
  // billboard support: breaking the block under a cross-model block (torch, mushroom) pops it off
  if (newId === B.AIR && y + 1 <= 199) {
    const above = getBlock(x, y + 1, z) & 255;
    if (PROPS[above]?.model === 'cross' || above === B.CACTUS) {   // cactus columns chain-break upward
      setBlock(x, y + 1, z, B.AIR);
      if (!player.canFly)
        for (const d of blockDrop(above)) for (let n = 0; n < d.count; n++) spawnDrop(d.id, x, y + 1, z);
    }
  }
  // gravity: clear below a gravity block → it falls; gravity block placed above air → also falls
  if (newId === B.AIR && y + 1 <= 199) scheduleFall(x, y + 1, z);
  if ((newId === B.SAND || newId === B.RED_SAND || newId === B.GRAVEL) && y > 0 && (getBlock(x, y - 1, z) & 255) === B.AIR)
    scheduleFall(x, y, z);
  editRushing = false;
}
// is any glowstone within light range of (x,y,z)? (so opaque edits there re-shadow correctly)
function glowNear(x, y, z) {
  for (const k of glowLights) {
    const p = k.split(',');
    if (Math.abs(+p[0] - x) <= GLOW_LEVEL && Math.abs(+p[1] - y) <= GLOW_LEVEL && Math.abs(+p[2] - z) <= GLOW_LEVEL) return true;
  }
  if (_plyGlow && Math.abs(_plyGlow[0]-x) <= GLOW_LEVEL && Math.abs(_plyGlow[1]-y) <= GLOW_LEVEL && Math.abs(_plyGlow[2]-z) <= GLOW_LEVEL) return true;
  return false;
}
function markDirty(c) {
  if (!c || !c.data) return;
  if (editRushing) c.editRush = true;       // player edit: apply this re-mesh grouped with siblings
  if (c.meshing) c.dirty = true;
  else tryQueueMesh(c, 0, true);
}

