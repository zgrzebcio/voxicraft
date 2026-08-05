'use strict';
/* voxiCraft — shared constants + persisted settings (loads first) */

function clampi(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ---------------------------------- configuration ---------------------------------- */
const GAME_VERSION = '0.672';           // stamped onto worlds at create + each load
const CHUNK_X = 16, CHUNK_Y = 200, CHUNK_Z = 16;
const WATER_Y = 99;                       // top water surface fills up to this y
const DEFAULT_VIEW_DIST = 10;             // in chunks (radius)
let   viewDist = clampi(parseInt(localStorage.getItem('vc_dist')) || DEFAULT_VIEW_DIST, 8, 32);
let   fpsLimit = clampi(parseInt(localStorage.getItem('vc_fps')) || 0, 0, 240);   // 0 = uncapped
let   sens = clampi(parseInt(localStorage.getItem('vc_sens')) || 100, 10, 400) / 100;  // look sensitivity
let   rafHz = 120;                          // display refresh rate, measured at boot
