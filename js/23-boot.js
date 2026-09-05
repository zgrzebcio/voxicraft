'use strict';
/* voxiCraft — settings restore, autosave timer, atlas load, debug handle */

/* ---------------------------------- boot ---------------------------------- */

// restore persisted settings into the menu
modeSel.value = localStorage.getItem('vc_mode') || 'creative';
fpsSel.value = String(fpsLimit || 0);
distInput.value = viewDist;
simInput.value = simRadius;
sensInput.value = Math.round(sens * 100);
shadowSel.value = String(shadowR);
splitDirSel.value = splitDir;
applyShadowDist();
player.canFly = modeSel.value !== 'survival';
if (!player.canFly) player.flying = false;
/* Split screen must exist before anything reads the HUD: initSplitScreen moves the whole HUD into
   player one's pane and takes the first snapshot of the per-player globals. */
initSplitScreen();
setPlayerName(0, activeProfileName());      // player one is whoever's profile is selected
startMenuBackdrop();                        // title screen: rotating "voxicraft"-seed panorama
/* First run has no profiles at all, and a nameless player cannot own a save — so the profile
   screen is the whole menu until one exists. refreshMenu enforces it; this just opens there. */
refreshMenu(needsFirstProfile() ? 'profiles' : 'home');
/* Failsafe: the veil is normally lifted from the frame loop once the panorama is built, but the
   frame loop only starts after the atlas resolves. If that ever fails, an unreachable menu is the
   worst possible outcome — so show it regardless after eight seconds. */
setTimeout(() => { overlay.classList.remove('veiled'); liftBootCover(); }, 8000);
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
  applyViewDist();
  requestAnimationFrame(frame);                   // start drawing the panorama immediately
  /* ...then pull the in-world art in behind it (0.724). Nothing on the title screen needs any of
     it, so this costs the menu nothing, and by the time anyone has picked a world it is normally
     already in hand — which is the difference between joining and staring at invisible items for
     five seconds. ensureGameArt is idempotent; world entry awaits the same promise. */
  ensureGameArt();
});

/* ---- deferred game assets (0.7146) ----
   Everything below is needed to PLAY and useless on the title screen, so none of it happens at
   boot any more. The HUD is hidden behind the menu, prefabs cannot spawn without a currentWorld,
   and the inventory is built by toggleInventory() the first time it is opened.

   The icon warm-up is the expensive one: an offscreen 3D render per placeable block, cached into
   ICON3D. It used to run synchronously before the very first frame — hundreds of renders with
   the screen still blank. Now it is sliced across frames, 3ms at a time, and only once a world is
   actually being entered, where there is a loading screen to hide it behind.

   Idempotent: entering a second world re-uses everything the first one warmed. */
let _gameAssetsStarted = false;
function ensureGameAssets() {
  if (_gameAssetsStarted) return;
  _gameAssetsStarted = true;
  ensureStructuresLoaded();                       // prefab manifest + files, fetched in parallel
  ensureVitalsSprites();                          // hearts / food / air / armor bar sprites
  /* Icons are cached for the life of the session the moment they are first drawn, and the chest,
     bed and door draw themselves from IMAGES — so warming them before their art has arrived bakes
     a black square in permanently. WAIT for the art (0.724); the loading screen is up anyway. */
  ensureGameArt().then(() => {
    /* Rebuild for EVERY player, not just whoever is installed: loadWorld already drew each seat's
       hotbar while this art was still in flight, so those slots are holding the empty string
       renderBlockIcon hands back for a not-yet-drawable icon. */
    forEachPlayerSlot(() => buildHotbar());
    let i = 0;
    const warmIcons = () => {
      const t0 = performance.now();
      while (i < PLACEABLE.length && performance.now() - t0 < 3) renderBlockIcon(PLACEABLE[i++]);
      if (i < PLACEABLE.length) { requestAnimationFrame(warmIcons); return; }
      buildInventory();                           // icons are cached by now, so this is cheap
      forEachPlayerSlot(() => buildHotbar());     // ...and the hotbars once more, now fully warm
    };
    requestAnimationFrame(warmIcons);
  });
}

// small console/debug handle (harmless in normal play)
window.__vc = {
  tp(x, y, z) { player.pos.set(x, y, z); player.spawned = true; },
  look(yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
  block: getBlock,
  set: setBlock,
  get player() { return player; },            // the ACTIVE player — split screen swaps this
  players: PLAYERS,
  join: () => setPlayerCount(PSTATE.length + 1),
  leave: () => setPlayerCount(PSTATE.length - 1),
  /* Controller diagnostic: exactly what this browser reports, next to what the game made of it.
     If a pad is physically connected but `raw` is empty, the browser has not been told about it
     yet — press a button on it and run this again. */
  pads() {
    let raw = null;
    try { raw = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { raw = 'threw: ' + e; }
    return {
      api: typeof navigator.getGamepads,
      rawLength: raw && raw.length,
      raw: raw && Array.from(raw, g => g && { index: g.index, id: g.id, connected: g.connected,
                                              buttons: g.buttons && g.buttons.length }),
      seen: connectedPads().map(g => ({ index: g.index, id: g.id })),
      binds: INPUT_BIND.slice(0, PSTATE.length),
      routed: PSTATE.map((s, i) => ({ seat: i, who: s.player.name, device: inputLabelFor(i) })),
    };
  },
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

/* background music lives in js/sound.js — it follows the menu/in-game state each frame */
