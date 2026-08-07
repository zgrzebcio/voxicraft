'use strict';
/* voxiCraft — world reset, surface scan, valid spawn search */

/* ---------------------------------- world reset (new seed) ---------------------------------- */
function resetWorld(seed, terrainType) {
  SEED = seed;
  TERRAIN_TYPE = terrainType || 'default';
  mainGen = CORE.makeGen(seed, TERRAIN_TYPE);
  history.replaceState(null, '', '?seed=' + encodeURIComponent(seed));
  genQueue.length = 0; meshQueue.length = 0; meshResults.length = 0;
  for (const [, c] of chunks) disposeChunkMeshes(c);
  chunks.clear();
  editStore.clear();
  glowLights.clear();
  _plyGlow = null;
  clearDrops();
  clearFallingLeaves();
  clearFelling();
  clearLitterRot();
  clearEntities();
  clearBeds();
  clearChests();
  player.spawnPos = null;
  initWorkers(seed, TERRAIN_TYPE);
  player.spawned = false;
  player.pos.set(8.5, 96, 8.5);
  playerCX = 1e9; playerCZ = 1e9;           // force queue rebuild
}

// scan a column for the highest solid block (used by spawn + void teleport)
function surfaceY(x, z) {
  for (let y = 199; y >= 0; y--) {
    const b = getBlock(x, y, z) & 255;
    if (b !== B.AIR && b !== B.WATER && b !== B.LAVA) return y;
  }
  return WATER_Y;
}

// find a valid spawn (x,z): surface must not be water/log/leaves, chunk must be loaded.
// spiral out from (0,0) up to radius 100. returns {x,z,y} or null if nothing loaded/valid yet.
function findValidSpawn() {
  const isValidTop = (id) => id !== B.WATER && id !== B.LAVA && id !== B.LOG && id !== B.LEAVES && id !== B.AIR;
  const check = (x, z) => {
    const c = getChunk(Math.floor(x / 16), Math.floor(z / 16));
    if (!c || !c.data) return null;
    const y = surfaceY(x, z);
    if (Math.abs(y - mainGen.heightAt(x, z)) > 3) return null;   // cave entrance hole — not real surface
    const top = getBlock(x, y, z) & 255;
    if (!isValidTop(top)) return null;
    // surfaceY skips water, so an ocean floor still reports its sand top — require open air above
    if ((getBlock(x, y + 1, z) & 255) !== B.AIR || (getBlock(x, y + 2, z) & 255) !== B.AIR) return null;
    return { x: x + 0.5, y: y + 2, z: z + 0.5 };
  };
  const first = check(0, 0);
  if (first) return first;
  for (let r = 1; r <= 100; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const hit1 = check(dx,  r); if (hit1) return hit1;
      const hit2 = check(dx, -r); if (hit2) return hit2;
    }
    for (let dz = -r + 1; dz <= r - 1; dz++) {
      const hit1 = check( r, dz); if (hit1) return hit1;
      const hit2 = check(-r, dz); if (hit2) return hit2;
    }
  }
  return null;
}

