'use strict';
/* voxiCraft — settings restore, autosave timer, atlas load, debug handle */

/* ---------------------------------- boot ---------------------------------- */

// restore persisted settings into the menu
modeSel.value = localStorage.getItem('vc_mode') || 'creative';
fpsSel.value = String(fpsLimit || 0);
distInput.value = viewDist;
sensInput.value = Math.round(sens * 100);
shadowSel.value = String(shadowR);
applyShadowDist();
player.canFly = modeSel.value !== 'survival';
if (!player.canFly) player.flying = false;
startMenuBackdrop();                        // title screen: rotating "voxicraft"-seed panorama
refreshMenu('home');
// prune orphaned world blobs (saves whose registry entry is gone, e.g. deleted elsewhere)
for (const k of Object.keys(localStorage))
  if (k.startsWith('vc_world_') && !WORLDS.some(w => 'vc_world_' + w.id === k)) localStorage.removeItem(k);
// remove legacy pre-world-save survival inventory keys (migration code removed in 0.0722)
localStorage.removeItem('vc_hotbar_survival');
localStorage.removeItem('vc_inv_survival');
setInterval(() => { if (currentWorld && playing) saveWorld(); }, 60000);   // autosave every 1m
window.addEventListener('beforeunload', () => { if (currentWorld) saveWorld(true); });

// measure the display refresh rate — rAF is vsync-bound, so fps caps above it can't add
// frames; surface that in the menu and in the HUD's "FPS x / max" readout. Use the SHORTEST
// inter-frame gap seen over a window (not the average): boot/chunk-loading frames are slow
// and would drag an average down, but the fastest frame reveals the true refresh interval.
(function measureHz() {
  let prev = 0, n = 0, minDelta = 1e9;
  function tick(t) {
    if (prev) { const d = t - prev; if (d > 1 && d < minDelta) minDelta = d; }
    prev = t;
    if (++n < 90) { requestAnimationFrame(tick); return; }
    rafHz = clampi(Math.round(1000 / minDelta / 5) * 5, 30, 240);   // snap to nearest 5
    document.getElementById('hzNote').textContent =
      `display ≈ ${rafHz} Hz — fps limits above that have no effect`;
  }
  requestAnimationFrame(tick);
})();

buildAtlas().then((tex) => {
  sharedUniforms.map.value = tex;
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  PLACEABLE.forEach(id => renderBlockIcon(id));   // pre-render all 3D block icons (once)
  buildHotbar();
  buildInventory();
  applyViewDist();
  requestAnimationFrame(frame);
});

// small console/debug handle (harmless in normal play)
window.__vc = {
  tp(x, y, z) { player.pos.set(x, y, z); player.spawned = true; },
  look(yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
  block: getBlock,
  set: setBlock,
  player,
  biome: (x, z) => mainGen.biomeAt(x, z),
  height: (x, z) => mainGen.heightAt(x, z),
  lightAt: (x, y, z) => getLightWorld(x, y, z),
  skyAt: (x, y, z) => getSkyWorld(x, y, z),
  time: (t) => { if (t !== undefined) worldTime = ((t % 1) + 1) % 1; return worldTime; },
  uniforms: sharedUniforms,
  blockName: (x, y, z) => PROPS[getBlock(x, y, z) & 255].name,
  inv: () => ({ mode: currentInvMode,
                HOTBAR: HOTBAR.map(s => s ? {id: s.id, count: s.count} : null),
                invSlots: invSlots.map(s => s ? {id: s.id, count: s.count} : null),
                spawnPos: player.spawnPos && player.spawnPos.toArray() }),
  hardness: (id) => PROPS[id].hardness,
  stack: (id) => stackSize(id),
  mining: () => ({ active: mining.active, x: mining.x, y: mining.y, z: mining.z, elapsed: mining.elapsed, needed: mining.needed, stage: mining.stage }),
  drops: () => DROPS.map(d => ({ id: d.id, x: d.group.position.x, y: d.group.position.y, z: d.group.position.z, age: d.age, grounded: d.grounded })),
  stats() { return { fps, chunks: chunks.size, draws: renderer.info.render.calls,
                     tris: renderer.info.render.triangles, pos: player.pos.toArray(),
                     genQ: genQueue.length, meshQ: meshQueue.length, results: meshResults.length }; },
};

/* ---- background music: loops forever at low volume; starts on first user gesture
   (browsers block autoplay until an interaction) ---- */
{
  const bgm = new Audio('/sound/Music/Sneaky-Snitch(chosic.com).mp3');
  bgm.loop = true;
  bgm.volume = 0.1;
  const startMusic = () => {
    bgm.play().then(() => {
      removeEventListener('pointerdown', startMusic);
      removeEventListener('keydown', startMusic);
    }).catch(() => {});     // still blocked — next gesture retries
  };
  startMusic();             // try immediately (works if autoplay is allowed)
  addEventListener('pointerdown', startMusic);
  addEventListener('keydown', startMusic);
}
