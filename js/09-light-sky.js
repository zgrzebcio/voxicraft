'use strict';
/* voxiCraft — sky light: per-voxel daylight (cave darkness) */

/* ================================================================================================
   SKY LIGHT — per-voxel daylight so caves are genuinely dark. Every cell above a column's
   topmost opaque block is 15 ("open sky"); from there light BFS-spreads sideways/down with
   -1 falloff per step, crossing chunk borders. Stored per chunk in c.sky and packed into the
   HIGH nibble of the light byte at mesh time (glow keeps the low nibble).
   ================================================================================================ */
const SKY_LEVEL = 15;
/* Levels absorbed per water block. At the old 6 a column went black after two blocks, which
   crushed shallow shore water; the surface's own sense of depth now comes from the mesher
   darkening the top face by how much water is under it, so this only has to handle what's
   BELOW the surface and can be much gentler. */
const WATER_ABSORB = 3;
function chunkSkyArr(c) { return c.sky || (c.sky = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z)); }
function getSkyWorld(x, y, z) {
  if (y > 199) return SKY_LEVEL;
  if (y < 0) return 0;
  const c = getChunk(Math.floor(x / 16), Math.floor(z / 16));
  if (!c || !c.sky) return 0;
  return c.sky[(x & 15) + ((z & 15) << 4) + (y << 8)];
}
// BFS-spread seeded sky light; touched collects chunks whose values changed (for re-meshing)
function propagateSky(q, touched) {
  let head = 0;
  while (head < q.length) {
    const x = q[head++], y = q[head++], z = q[head++], lv = q[head++];
    if (lv <= 1) continue;
    for (const d of LIGHT_DIRS) {
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      if (ny < 0 || ny > 199) continue;
      const c = getChunk(Math.floor(nx / 16), Math.floor(nz / 16));
      if (!c || !c.data) continue;                    // never spread into unloaded space
      const i = (nx & 15) + ((nz & 15) << 4) + (ny << 8);
      const nid = c.data[i] & 255;
      if (PROPS[nid].opaque) continue;
      // water absorbs during sideways spread too, matching the vertical step
      const nl = lv - (nid === B.WATER ? WATER_ABSORB : 1);
      if (nl <= 0) continue;
      const sky = chunkSkyArr(c);
      if (sky[i] >= nl) continue;
      sky[i] = nl;
      if (touched) touched.add(key(c.cx, c.cz));
      q.push(nx, ny, nz, nl);
    }
  }
}
// column scan: first opaque block from the top (matches worker data layout)
function skyColumnTop(data, lx, lz) {
  const li = lx + (lz << 4);
  for (let y = 199; y >= 0; y--) if (PROPS[data[li + (y << 8)] & 255].opaque) return y;
  return -1;
}
// freshly generated chunk: seed open-sky columns, then spread into relief/caves and pull
// light in across borders from already-lit neighbours
function seedSkyForChunk(c) {
  const sky = chunkSkyArr(c);
  const data = c.data;
  const tops = new Int16Array(256);
  for (let lz = 0; lz < 16; lz++)
    for (let lx = 0; lx < 16; lx++) {
      const top = skyColumnTop(data, lx, lz);
      tops[lx + lz * 16] = top;
      const li = lx + (lz << 4);
      // descend from open sky; each water block absorbs WATER_ABSORB levels, so deep water
      // columns go dark and the seabed under them is barely lit (surface stays bright)
      let lv = SKY_LEVEL;
      for (let y = 199; y >= top + 1; y--) {
        const i = li + (y << 8);
        sky[i] = lv;
        if ((data[i] & 255) === B.WATER) lv = Math.max(0, lv - WATER_ABSORB);
      }
    }
  const q = [];
  const wx0 = c.cx * 16, wz0 = c.cz * 16;
  // seed the "relief band" of each column: open cells below a taller neighbouring column
  // (border columns treat outside as max height so light always reaches across chunks)
  for (let lz = 0; lz < 16; lz++)
    for (let lx = 0; lx < 16; lx++) {
      const top = tops[lx + lz * 16];
      let hi = top;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = lx + dx, nz = lz + dz;
        hi = Math.max(hi, (nx < 0 || nx > 15 || nz < 0 || nz > 15) ? 199 : tops[nx + nz * 16]);
      }
      // seed with the STORED (water-attenuated) value, not raw 15 — otherwise border
      // columns re-flood deep water with full daylight and erase the depth darkness
      for (let y = top + 1, yMax = Math.min(199, hi); y <= yMax; y++) {
        const v = sky[lx + (lz << 4) + (y << 8)];
        if (v > 1) q.push(wx0 + lx, y, wz0 + lz, v);
      }
    }
  // pull lit neighbour borders in (their earlier BFS stopped at this then-unloaded chunk)
  for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const n = getChunk(c.cx + dx, c.cz + dz);
    if (!n || !n.sky) continue;
    const side = dx === -1 ? 0 : dx === 1 ? 1 : dz === -1 ? 2 : 3;
    const plane = edgeSlice(n.sky, side, Uint8Array);
    for (let y = 0; y < 200; y++)
      for (let i = 0; i < 16; i++) {
        const v = plane[i + (y << 4)];
        if (v <= 1) continue;
        const wx = dx === -1 ? wx0 - 1 : dx === 1 ? wx0 + 16 : wx0 + i;
        const wz = dz === -1 ? wz0 - 1 : dz === 1 ? wz0 + 16 : wz0 + i;
        q.push(wx, y, wz, v);
      }
  }
  const touched = new Set();
  propagateSky(q, touched);
  touched.delete(key(c.cx, c.cz));            // self meshes later anyway
  for (const k of touched) { const t = chunks.get(k); if (t) markDirty(t); }
}
// after a block edit: rebuild sky in a box around the change (straight-down reseed per column,
// then BFS from in-box relief + light pulled through the box walls), re-mesh changed chunks
function reskyAround(x, y, z) {
  const R = SKY_LEVEL;
  const x0 = x - R, x1 = x + R, z0 = z - R, z1 = z + R;
  const W = x1 - x0 + 1;
  const tops = new Int16Array(W * W).fill(-2);          // -2 = column not loaded
  const touched = new Set();
  for (let zz = z0; zz <= z1; zz++)
    for (let xx = x0; xx <= x1; xx++) {
      const c = getChunk(Math.floor(xx / 16), Math.floor(zz / 16));
      if (!c || !c.data) continue;
      const lx = xx & 15, lz = zz & 15, li = lx + (lz << 4);
      const top = skyColumnTop(c.data, lx, lz);
      tops[(xx - x0) + (zz - z0) * W] = top;
      const sky = chunkSkyArr(c);
      let changed = false;
      // same water attenuation as seedSkyForChunk
      let lv = SKY_LEVEL;
      for (let yy = 199; yy >= 0; yy--) {
        const i = li + (yy << 8);
        let v = 0;
        if (yy > top) { v = lv; if ((c.data[i] & 255) === B.WATER) lv = Math.max(0, lv - WATER_ABSORB); }
        if (sky[i] !== v) { sky[i] = v; changed = true; }
      }
      if (changed) touched.add(key(c.cx, c.cz));
    }
  const q = [];
  for (let zz = z0; zz <= z1; zz++)
    for (let xx = x0; xx <= x1; xx++) {
      const top = tops[(xx - x0) + (zz - z0) * W];
      if (top === -2) continue;
      // relief band inside the box; box-edge columns also pull outside light through the wall
      let hi = top;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = xx + dx, nz = zz + dz;
        const nt = (nx < x0 || nx > x1 || nz < z0 || nz > z1)
          ? -1 : tops[(nx - x0) + (nz - z0) * W];
        hi = Math.max(hi, nt === -2 ? -1 : nt);
      }
      for (let yy = top + 1, yMax = Math.min(199, hi); yy <= yMax; yy++) {
        const v = getSkyWorld(xx, yy, zz);   // stored, water-attenuated value
        if (v > 1) q.push(xx, yy, zz, v);
      }
      const onWall = xx === x0 || xx === x1 || zz === z0 || zz === z1;
      if (onWall)
        for (let yy = 0; yy <= Math.min(199, top === -1 ? 199 : top + 1); yy++) {
          const ox = xx === x0 ? xx - 1 : xx === x1 ? xx + 1 : xx;
          const oz = zz === z0 ? zz - 1 : zz === z1 ? zz + 1 : zz;
          const v = getSkyWorld(ox, yy, oz);
          if (v > 1) q.push(ox, yy, oz, v);
        }
    }
  propagateSky(q, touched);
  for (const k of touched) { const t = chunks.get(k); if (t) markDirty(t); }
}

