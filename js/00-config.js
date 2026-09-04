'use strict';
/* voxiCraft — shared constants + persisted settings (loads first) */

function clampi(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ---------------------------------- configuration ---------------------------------- */
const GAME_VERSION = '0.71';           // stamped onto worlds at create + each load
const CHUNK_X = 16, CHUNK_Y = 200, CHUNK_Z = 16;
const WATER_Y = 99;                       // top water surface fills up to this y
const DEFAULT_VIEW_DIST = 10;             // in chunks (radius)
let   viewDist = clampi(parseInt(localStorage.getItem('vc_dist')) || DEFAULT_VIEW_DIST, 8, 32);
/* ---- two chunk radii (0.712) ----
   `viewDist` is the GENERATION/render radius: how far chunks are built, meshed and drawn. It is
   a graphics setting and people push it high.

   `simDist` is the SIMULATION radius, and it is deliberately much smaller and capped. Only
   chunks inside it tick: entity AI, fluid flow, gravity blocks, falling leaves, litter rot, snow
   melt, berry regrowth. Everything outside is drawn but frozen — a pause, never a cancellation:
   queued work stays queued and resumes the moment the player comes back within range.

   This is what stops render distance from being a simulation-cost multiplier. At dist 32 the old
   code was flowing water and stepping mobs across ~4000 chunks; now it is ~110 whatever the
   render distance says. */
const SIM_DIST_MIN = 2, SIM_DIST_MAX = 16;
const DEFAULT_SIM_DIST = 6;
let   simRadius = clampi(parseInt(localStorage.getItem('vc_sim')) || DEFAULT_SIM_DIST,
                         SIM_DIST_MIN, SIM_DIST_MAX);
/* Never larger than the render distance — simulating chunks that do not exist is meaningless,
   so lowering render distance quietly clamps the effective simulation radius with it. */
const simDist = () => Math.max(SIM_DIST_MIN, Math.min(simRadius, viewDist));
// chunk-space range test. playerCX/CZ live in 11-chunks.js and are read at call time.
function inSimRangeChunk(cx, cz) {
  const r = simDist(), dx = cx - playerCX, dz = cz - playerCZ;
  return dx * dx + dz * dz <= r * r;
}
const inSimRange = (x, z) => inSimRangeChunk(Math.floor(x / 16), Math.floor(z / 16));
let   fpsLimit = clampi(parseInt(localStorage.getItem('vc_fps')) || 0, 0, 240);   // 0 = uncapped
let   sens = clampi(parseInt(localStorage.getItem('vc_sens')) || 100, 10, 400) / 100;  // look sensitivity
let   rafHz = 120;                          // display refresh rate, measured at boot
