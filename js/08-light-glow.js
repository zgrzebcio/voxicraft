'use strict';
/* voxiCraft — block light: glowstone flood-fill */

/* ================================================================================================
   BLOCK LIGHT — flood-fill from glowstone, respecting opaque walls. Light levels 0..15 live in a
   per-chunk Uint8 array; the mesher bakes each face's level from the transparent cell it faces.
   Propagation runs on the main thread (glowstones are rare, player-placed, tracked in glowLights),
   crossing chunk borders via getBlock/getLightWorld, and marks touched chunks dirty to re-mesh.
   ================================================================================================ */
function chunkLightArr(c) { return c.light || (c.light = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z)); }
function getLightWorld(x, y, z) {
  if (y < 0 || y > 199) return 0;
  const c = getChunk(Math.floor(x / 16), Math.floor(z / 16));
  if (!c || !c.light) return 0;
  return c.light[(x & 15) + ((z & 15) << 4) + (y << 8)];
}
function setLightWorld(x, y, z, val) {
  const c = getChunk(Math.floor(x / 16), Math.floor(z / 16));
  if (!c || !c.data) return;
  chunkLightArr(c)[(x & 15) + ((z & 15) << 4) + (y << 8)] = val;
}
const LIGHT_DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
// effective light emission of a raw voxel value — variant-aware (lit furnace glows, unlit doesn't)
const FURNACE_GLOW = 5;
function blockLightOf(val) {
  const id = val & 255;
  if (id === B.FURNACE) return ((val >> 8) & V.FURNACE_ON) ? FURNACE_GLOW : 0;   // lit bit (facing bits below it)
  return PROPS[id]?.light || 0;
}
// per-position emission: read the block's own light level (torch 10, glowstone 14, furnace 5...)
const glowLevelAt = (gx, gy, gz) => blockLightOf(getBlock(gx, gy, gz)) || GLOW_LEVEL;

let _plyGlow = null; // null | [x, y, z, level] — virtual player held-light source

// perf gate: only light sources within half the view distance (in chunks) of the player
// propagate. Far sources are skipped — no BFS, no chunk dirtying. Chunks outside this ring
// keep whatever light they last computed until the player moves closer and relightForChunk
// reruns for them (or they get evicted and reloaded).
function _lightSrcActive(sx, sz) {
  const scx = Math.floor(sx / 16), scz = Math.floor(sz / 16);
  const half = Math.max(1, viewDist >> 1);
  return Math.abs(scx - playerCX) <= half && Math.abs(scz - playerCZ) <= half;
}

// BFS-relax light from a source; level defaults to GLOW_LEVEL for placed glowstone.
// Skips unloaded chunks entirely — without a visited mark there the flood revisits cells
// endlessly (queue blowup = the save-load lag near placed lights); relightForChunk pours
// light into those chunks once they load, so nothing is missed.
function propagateLight(gx, gy, gz, level = GLOW_LEVEL) {
  const q = [gx, gy, gz, level + 1];    // seed one above so neighbours get `level`
  let head = 0;
  let ccx = 1e9, ccz = 1e9, cData = null, cLight = null;   // cached chunk arrays
  while (head < q.length) {
    const x = q[head++], y = q[head++], z = q[head++], lv = q[head++];
    const nl = lv - 1;
    if (nl <= 0) continue;
    for (const d of LIGHT_DIRS) {
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      if (ny < 0 || ny > 199) continue;
      const kx = Math.floor(nx / 16), kz = Math.floor(nz / 16);
      if (kx !== ccx || kz !== ccz) {
        ccx = kx; ccz = kz;
        const c = getChunk(kx, kz);
        cData = c && c.data ? c.data : null;
        cLight = cData ? chunkLightArr(c) : null;
      }
      if (!cData) continue;             // unloaded: relightForChunk handles it on load
      const i = (nx & 15) + ((nz & 15) << 4) + (ny << 8);
      if (PROPS[cData[i] & 255].opaque) continue;
      if (cLight[i] >= nl) continue;
      cLight[i] = nl;
      q.push(nx, ny, nz, nl);
    }
  }
}

// recompute block light in a bounded box around a change, then re-mesh the chunks it touches
function relight(x, y, z) {
  const R = GLOW_LEVEL;
  const near = [];
  for (const k of glowLights) {
    const p = k.split(','), gx = +p[0], gy = +p[1], gz = +p[2];
    if (Math.abs(gx - x) <= 2 * R && Math.abs(gy - y) <= 2 * R && Math.abs(gz - z) <= 2 * R) {
      if (!_lightSrcActive(gx, gz)) continue;
      near.push([gx, gy, gz, glowLevelAt(gx, gy, gz)]);
    }
  }
  if (_plyGlow) {
    const [gx, gy, gz] = _plyGlow;
    if (Math.abs(gx - x) <= 2 * R && Math.abs(gy - y) <= 2 * R && Math.abs(gz - z) <= 2 * R) near.push(_plyGlow);
  }
  let x0 = x - R, x1 = x + R, y0 = y - R, y1 = y + R, z0 = z - R, z1 = z + R;
  for (const g of near) { x0 = Math.min(x0, g[0]-R); x1 = Math.max(x1, g[0]+R); y0 = Math.min(y0, g[1]-R); y1 = Math.max(y1, g[1]+R); z0 = Math.min(z0, g[2]-R); z1 = Math.max(z1, g[2]+R); }
  y0 = Math.max(0, y0); y1 = Math.min(199, y1);
  for (let yy = y0; yy <= y1; yy++) for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) setLightWorld(xx, yy, zz, 0);
  for (const g of near) propagateLight(g[0], g[1], g[2], g[3]);
  for (let ccz = Math.floor(z0/16); ccz <= Math.floor(z1/16); ccz++)
    for (let ccx = Math.floor(x0/16); ccx <= Math.floor(x1/16); ccx++) {
      const c = getChunk(ccx, ccz); if (c && c.data) markDirty(c);
    }
}

// Update the player's virtual held-light source.
// Call when the player moves a block or changes held item. level=0 clears.
function updatePlayerLight(nx, ny, nz, level) {
  const old = _plyGlow;
  _plyGlow = level > 0 ? [nx, ny, nz, level] : null;
  if (!old && !_plyGlow) return;

  const R = GLOW_LEVEL;
  // guard: if old and new are far apart (world reset), skip old in the bounding box
  const skipOld = old && (Math.abs(old[0]-nx) > 2*R || Math.abs(old[1]-ny) > 2*R || Math.abs(old[2]-nz) > 2*R);

  const cx = _plyGlow ? nx : old[0], cy = _plyGlow ? ny : old[1], cz = _plyGlow ? nz : old[2];
  // sources to re-propagate: placed glowLights + new player light. Old is NOT a source — it gets cleared.
  const sources = [];
  for (const k of glowLights) {
    const p = k.split(','), gx = +p[0], gy = +p[1], gz = +p[2];
    if (Math.abs(gx-cx)<=2*R && Math.abs(gy-cy)<=2*R && Math.abs(gz-cz)<=2*R) {
      if (!_lightSrcActive(gx, gz)) continue;
      sources.push([gx,gy,gz,glowLevelAt(gx,gy,gz)]);
    }
  }
  if (_plyGlow) sources.push(_plyGlow);

  // bbox: cover new position + old position so old light gets cleared
  let x0=cx-R, x1=cx+R, y0=cy-R, y1=cy+R, z0=cz-R, z1=cz+R;
  if (!skipOld && old) { x0=Math.min(x0,old[0]-R); x1=Math.max(x1,old[0]+R); y0=Math.min(y0,old[1]-R); y1=Math.max(y1,old[1]+R); z0=Math.min(z0,old[2]-R); z1=Math.max(z1,old[2]+R); }
  for (const g of sources) { x0=Math.min(x0,g[0]-R); x1=Math.max(x1,g[0]+R); y0=Math.min(y0,g[1]-R); y1=Math.max(y1,g[1]+R); z0=Math.min(z0,g[2]-R); z1=Math.max(z1,g[2]+R); }
  y0=Math.max(0,y0); y1=Math.min(199,y1);
  for (let yy=y0;yy<=y1;yy++) for (let zz=z0;zz<=z1;zz++) for (let xx=x0;xx<=x1;xx++) setLightWorld(xx,yy,zz,0);
  for (const g of sources) propagateLight(g[0],g[1],g[2],g[3]);
  for (let ccz=Math.floor(z0/16);ccz<=Math.floor(z1/16);ccz++)
    for (let ccx=Math.floor(x0/16);ccx<=Math.floor(x1/16);ccx++) {
      const c=getChunk(ccx,ccz); if(c&&c.data) markDirty(c);
    }
}

// a freshly loaded chunk: pour in any glowstone within reach so it isn't dark
function relightForChunk(cx, cz) {
  const half = Math.max(1, viewDist >> 1);
  // skip if the chunk itself is beyond half view distance from player
  if (Math.abs(cx - playerCX) > half || Math.abs(cz - playerCZ) > half) return;
  for (const k of glowLights) {
    const p = k.split(','), gx = +p[0], gy = +p[1], gz = +p[2];
    if (!_lightSrcActive(gx, gz)) continue;
    const dx = Math.max(cx*16 - gx, gx - (cx*16+15), 0), dz = Math.max(cz*16 - gz, gz - (cz*16+15), 0);
    if (dx <= GLOW_LEVEL && dz <= GLOW_LEVEL) propagateLight(gx, gy, gz, glowLevelAt(gx, gy, gz));
  }
  if (_plyGlow) {
    const [gx, gy, gz, lv] = _plyGlow;
    const dx = Math.max(cx*16 - gx, gx - (cx*16+15), 0), dz = Math.max(cz*16 - gz, gz - (cz*16+15), 0);
    if (dx <= lv && dz <= lv) propagateLight(gx, gy, gz, lv);
  }
}

// Dev test — run _dbgHeldLight() in browser console while holding a light block
window._dbgHeldLight = () => {
  const px = Math.floor(player.pos.x), py = Math.floor(player.pos.y + player.EYE), pz = Math.floor(player.pos.z);
  console.log('[held-light] _plyGlow:', _plyGlow);
  console.log('[held-light] player block:', px, py, pz);
  const rows = [];
  for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const lv = getLightWorld(px+dx, py+dy, pz+dz);
    if (lv > 0) rows.push({ dx, dy, dz, light: lv });
  }
  console.table(rows);
};

