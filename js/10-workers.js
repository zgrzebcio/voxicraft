'use strict';
/* voxiCraft — worker pool: gen + mesh job dispatch */

/* ================================================================================================
   WORKER POOL — gen + mesh jobs, distance-prioritised, transferable buffers both ways.
   ================================================================================================ */
const workerSrc = `'use strict';\nconst CORE = (${VOXEL_CORE.toString()})();\n(${WORKER_MAIN.toString()})();`;
const workerURL = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
const WORKER_COUNT = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));

let SEED = (new URLSearchParams(location.search).get('seed') || '').replace(/[^a-z0-9]/gi, '')
        || Math.random().toString(36).slice(2, 10).toUpperCase();
let mainGen = CORE.makeGen(SEED);           // main-thread twin of the worker generator (HUD biome label)

const workers = [];
for (let i = 0; i < WORKER_COUNT; i++) {
  const w = new Worker(workerURL);
  w.busy = 0;
  w.onmessage = (e) => { w.busy--; onWorkerMessage(e.data); pump(); };
  workers.push(w);
}
function initWorkers(seed) { for (const w of workers) w.postMessage({ type: 'init', seed }); }
initWorkers(SEED);

