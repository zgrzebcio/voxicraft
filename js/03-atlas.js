'use strict';
/* voxiCraft — texture atlas builder (512x512, 5x5 grid) */


/* ================================================================================================
   TEXTURE ATLAS — 512x512, 4x4 grid of 128px cells. Each 64px tile is drawn 2x2 wrapped
   inside its cell and sampled from the centre 64x64 window, giving every tile a 32px
   correctly-wrapped gutter: NEAREST magnification stays crisp and mipmapped minification
   never bleeds across tiles. The shader tiles UVs with fract(), so greedy-merged quads
   repeat their texture across any width/height.
   ================================================================================================ */
// atlas is an ATLAS_COLS×ATLAS_COLS grid of 128px cells; bump ATLAS_COLS when tiles exceed COLS²
const ATLAS_COLS = 10;                                       // 10×10 = 100 slots
const ATLAS_TILES = ['grass_block_top', 'grass_block_side', 'dirt', 'stone', 'sand', 'bedrock',
                     'oak_log', 'oak_log_top', 'oak_planks', 'oak_leaves', 'glass', 'water', 'glowstone',
                     'clay', 'snow', 'grass_block_snow', 'cobblestone',
                     'coal_ore', 'iron_ore', 'diamond_ore', 'gravel', 'red_mushroom', 'brown_mushroom',
                     'crafting_bench_top', 'crafting_bench_front', 'crafting_bench_side', 'torch',
                     'furnace_front', 'furnace_front_on', 'furnace_side', 'furnace_top',
                     'red_sand', 'cactus_side', 'cactus_top', 'cactus_bottom', 'bricks', 'melon_top', 'melon_side' 
                     ,'stone_brick', 'wool', 'pumpkin_top', 'pumpkin_side', 'wheat_full'
                     ,'birch_log', 'birch_log_top', 'birch_planks', 'birch_leaves'
                     ,'hay_top', 'hay_side', 'marble', 'granite', 'limestone'
                     ,'grass', 'poppy', 'orchid', 'tallgrass_bottom', 'tallgrass_top', 'lava'
                     ,'tin_ore', 'gold_ore', 'copper_ore'
                     ,'obsidian', 'tnt_top', 'tnt_side', 'tnt_bottom'
                     ,'sulfur_block', 'sulfur_down_tip', 'sulfur_up_tip'
                     ,'tnt_lit'
                     ,'oak_sapling', 'birch_sapling', 'sugar_cane'
                     ,'stripped_oak_log', 'stripped_oak_log_top'
                     ,'stripped_birch_log', 'stripped_birch_log_top'
                     ,'spruce_log', 'spruce_log_top', 'spruce_planks', 'spruce_leaves'
                     ,'spruce_sapling'
                     ,'stripped_spruce_log', 'stripped_spruce_log_top'
                     ,'pincushions', 'structure_block'
                     ,'berry_bush_empty', 'berry_bush_fruitling', 'berry_bush'];
const IMAGES = {}; // name -> HTMLImageElement (also reused for hotbar / radial icons)

// glowstone uses the embedded texture if present; otherwise a procedural warm-speckle fallback
// so the game runs before the real PNG is injected (same data-URI slot, transparently replaced)
if (!TEXTURES.lava) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  for (let gy = 0; gy < 16; gy++) for (let gx = 0; gx < 16; gx++) {
    const n = Math.random();
    g.fillStyle = n < 0.07 ? '#fff8c0' : n < 0.22 ? '#ffcc00' : n < 0.55 ? '#ff7200' : n < 0.82 ? '#cc2e00' : '#881100';
    g.fillRect(gx * 4, gy * 4, 4, 4);
  }
  // brighten centre blob
  for (let k = 0; k < 12; k++) {
    g.fillStyle = '#ffaa00';
    g.fillRect((4 + (Math.random() * 8 | 0)) * 4, (4 + (Math.random() * 8 | 0)) * 4, 8, 8);
  }
  TEXTURES.lava = c.toDataURL();
}

if (!TEXTURES.glowstone) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  for (let gy = 0; gy < 16; gy++) for (let gx = 0; gx < 16; gx++) {
    const n = Math.random();
    g.fillStyle = n < 0.12 ? '#fff2c0' : n < 0.4 ? '#ffd873' : n < 0.75 ? '#e9b449' : '#c9922f';
    g.fillRect(gx * 4, gy * 4, 4, 4);
  }
  for (let k = 0; k < 9; k++) { g.fillStyle = '#fff6d0'; g.fillRect((Math.random() * 14 | 0) * 4, (Math.random() * 14 | 0) * 4, 8, 8); }
  TEXTURES.glowstone = c.toDataURL();
}

function loadImage(name, url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { IMAGES[name] = img; res(img); };
    img.onerror = rej;
    img.src = url || TEXTURES[name];
  });
}

/* ================================================================================================
   IN-WORLD ART — item sprites, armour sheets, and the block art that is NOT in the atlas
   ================================================================================================

   None of this is needed to draw the title panorama, so 0.7146 stopped loading it at boot; the
   first frame no longer waited on a pile of files the menu never touches. The cost landed on world
   ENTRY instead — around a hundred separate PNG requests — which is the five to ten seconds of
   invisible items and blank icons after joining.

   Two changes fix that (0.724), the same two the atlas already uses:

   1. It is CACHED. Every image is stored, once, as a PNG blob inside a single IndexedDB record,
      so later boots do one read instead of a hundred round trips. The key carries GAME_VERSION and
      the number of images, so adding or changing art misses the cache and refetches.

   2. It is STARTED AT BOOT, in the background, the moment the atlas is ready — while the player is
      still looking at the title screen. Entering a world then usually finds it already done. It is
      still awaited before icons are drawn, because an icon is a rasterised snapshot: taken early,
      it is a blank square for the rest of the session.

   MESH_TEXTURES is the part that has to be here rather than in the atlas: the door panel, the bed,
   the chest and the sheep's fleece own their own three.js meshes and sample IMAGES directly.
   buildAtlas loads all of TEXTURES on its stitching path, so they used to come along for free —
   but the atlas cache short-circuits that loop, so from the second boot onward nothing fetched
   them, `new THREE.Texture(undefined)` produced a blank map, and those meshes rendered BLACK. */
const MESH_TEXTURES = ['oak_door',
                       'bed_top', 'bed_long', 'bed_end', 'bed_leg', 'bed_down',
                       'chest_top', 'chest_bottom', 'chest_side', 'chest_front',
                       'wool'];
// name -> url for everything in this group; MESH_TEXTURES resolve through TEXTURES like block art
const _gameArtSources = () => ({
  ...ITEM_TEXTURES, ...EQUIP_TEXTURES,
  ...Object.fromEntries(MESH_TEXTURES.map(n => [n, TEXTURES[n]])),
});

/* Decoded images are kept as CANVASES, never as ImageBitmaps: three.js treats a bitmap source
   differently on upload (notably flipY), and the atlas cache learned that the hard way. */
function _bitmapToCanvas(bmp) {
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}
async function _loadCachedArt(names) {
  try {
    await idbReady;
    const rec = await idbGet(_artCacheKey(names));
    if (!rec || typeof rec !== 'object') return false;
    // an incomplete pack is not worth patching up — refetch the lot rather than half-load
    for (const n of names) if (!(rec[n] instanceof Blob)) return false;
    // same colour-management trap as the atlas cache above — decode the stored bytes verbatim
    await Promise.all(names.map(async (n) => {
      IMAGES[n] = _bitmapToCanvas(await createImageBitmap(rec[n], { colorSpaceConversion: 'none' }));
    }));
    return true;
  } catch { return false; }              // any failure at all: silently fetch from source
}
function _cacheArt(names) {
  const rec = {};
  Promise.all(names.map(n => new Promise((res) => {
    const img = IMAGES[n];
    if (!img) return res();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    try { c.toBlob(b => { if (b) rec[n] = b; res(); }, 'image/png'); } catch { res(); }
  }))).then(() => {
    if (Object.keys(rec).length === names.length) idbPut(_artCacheKey(names), rec).catch(() => {});
  });
}
const _artCacheKey = (names) => 'art:' + GAME_VERSION + ':' + names.length;

let _gameArtPromise = null;
function ensureGameArt() {
  if (_gameArtPromise) return _gameArtPromise;
  const src = _gameArtSources();
  const names = Object.keys(src);
  _gameArtPromise = (async () => {
    if (await _loadCachedArt(names)) return;                       // no network at all
    await Promise.all(names.map(n => loadImage(n, src[n]).catch(() => {})));
    _cacheArt(names);          // async, off the critical path — next boot skips every fetch above
  })();
  return _gameArtPromise;
}

/* ---- atlas cache (0.7147) ----
   The atlas is stitched from ~90 individual PNGs, and every one of them is its own HTTP request.
   Measured cold on the dev server: 162 requests finishing ~94ms apart, 15.2 SECONDS before the
   first frame could draw. No amount of JS scheduling helps with that — the fix is to stop making
   the requests.

   So the finished 1280x1280 sheet is stored in IndexedDB and reloaded whole on later boots: one
   read instead of ninety fetches. The key carries GAME_VERSION and the tile-list shape, so any
   change to the textures or the layout misses the cache and rebuilds from source — a stale atlas
   would be a far worse bug than a slow boot. */
const ATLAS_CACHE_KEY = 'atlas:' + GAME_VERSION + ':' + ATLAS_COLS + 'x' + ATLAS_TILES.length;
function _atlasTexFrom(source) {
  const tex = new THREE.CanvasTexture(source);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  return tex;
}
async function _loadCachedAtlas() {
  try {
    await idbReady;
    const blob = await idbGet(ATLAS_CACHE_KEY);
    if (!(blob instanceof Blob)) return null;
    /* colorSpaceConversion:'none' is NOT optional (0.7291). Decoding a PNG defaults to letting the
       browser apply colour management, and how much it applies depends on the browser and the
       display profile — so the cached sheet came back subtly DARKER than the one stitched from the
       source images, and only on some machines. The world runs with THREE.ColorManagement off and
       does its own sRGB encoding, so any decode-time conversion is pure error. Asking for none
       makes the cached path byte-identical to the fresh one everywhere. */
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    /* Draw the bitmap back into a real canvas rather than handing the ImageBitmap straight to
       CanvasTexture. three.js treats an ImageBitmap source differently from a canvas on upload —
       notably flipY — so the cached sheet came out mirrored against its own UVs and every block
       sampled a neighbouring tile. Round-tripping through a canvas makes the cached path
       byte-identical to the freshly stitched one, which is the only way this cache is safe. */
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = ATLAS_COLS * 128;
    const g = cvs.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(bmp, 0, 0);
    bmp.close?.();
    return _atlasTexFrom(cvs);
  } catch { return null; }                 // any failure at all: silently rebuild from source
}
function _cacheAtlas(cvs) {
  try {
    cvs.toBlob(b => { if (b) idbPut(ATLAS_CACHE_KEY, b).catch(() => {}); }, 'image/png');
  } catch {}
}

async function buildAtlas() {
  const cached = await _loadCachedAtlas();
  if (cached) return cached;                                         // no network at all
  await Promise.all(Object.keys(TEXTURES).map(n => loadImage(n)));   // block tiles only

  // tall_grass.png is one 2-tall sprite (e.g. 60x120): split it into a top and bottom half so
  // each of the two stacked blocks samples the correct portion instead of the whole squished image
  if (IMAGES.tallgrass) {
    const src = IMAGES.tallgrass, hw = src.width, hh = src.height / 2;
    for (const [name, sy] of [['tallgrass_bottom', hh], ['tallgrass_top', 0]]) {
      const c = document.createElement('canvas'); c.width = hw; c.height = hh;
      c.getContext('2d').drawImage(src, 0, sy, hw, hh, 0, 0, hw, hh);
      IMAGES[name] = c;
    }
  }
  // TNT lit: tnt_side texture with a 50% white overlay so the blink still reveals the pattern
  if (IMAGES.tnt_side) {
    const src = IMAGES.tnt_side;
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalAlpha = 0.5;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    IMAGES.tnt_lit = c;
  }

  // sample the grass colour from the coloured rim of grass_block_side, so the tinted
  // (grayscale) top texture matches the sides exactly
  const probe = document.createElement('canvas');
  probe.width = probe.height = 64;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(IMAGES.grass_block_side, 0, 0);
  const px = pctx.getImageData(0, 0, 64, 16).data;
  let r = 0, g = 0, b = 0, cnt = 0;
  for (let i = 0; i < px.length; i += 4)
    if (px[i + 1] > px[i] + 8 && px[i + 1] > px[i + 2] + 8) { r += px[i]; g += px[i + 1]; b += px[i + 2]; cnt++; }
  const tint = cnt ? `rgb(${(r / cnt) | 0},${(g / cnt) | 0},${(b / cnt) | 0})` : 'rgb(110,190,74)';

  /* tall_grass.png ships grayscale, so it reads as white in the world. Tint the two halves HERE,
     on the source image, rather than inside the atlas loop: that loop stamps every tile as 3x3
     wrapped copies, and `destination-in` run once per copy intersects the alpha nine times over
     at nine different offsets — which is empty, i.e. invisible tall grass. Doing it on the 64x64
     source means exactly one multiply and one alpha restore. */
  for (const name of ['tallgrass_bottom', 'tallgrass_top']) {
    const src = IMAGES[name];
    if (!src) continue;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const g2 = c.getContext('2d');
    g2.imageSmoothingEnabled = false;
    g2.drawImage(src, 0, 0);
    g2.globalCompositeOperation = 'multiply';          // keeps the blade shading, colours it
    g2.fillStyle = tint;
    g2.fillRect(0, 0, c.width, c.height);
    g2.globalCompositeOperation = 'destination-in';    // the fill also painted the gaps — undo that
    g2.drawImage(src, 0, 0);
    IMAGES[name] = c;
  }

  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = ATLAS_COLS * 128;
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  ATLAS_TILES.forEach((name, i) => {
    const cellX = (i % ATLAS_COLS) * 128, cellY = ((i / ATLAS_COLS) | 0) * 128;
    // per-block alpha baked into the atlas: water and leaves translucent but mostly opaque
    ctx.save();
    ctx.beginPath();
    ctx.rect(cellX, cellY, 128, 128);
    ctx.clip();
    ctx.globalAlpha = name === 'water' ? 0.65 : name === 'oak_leaves' ? 0.9 : 1.0;
    // 3x3 wrapped copies, offset so the tile's (0,0) texel lands exactly on the centre
    // 64x64 sample window — the surrounding 32px ring is a correctly-wrapped mip gutter
    for (let oy = 0; oy < 3; oy++)
      for (let ox = 0; ox < 3; ox++)
        ctx.drawImage(IMAGES[name], cellX - 32 + ox * 64, cellY - 32 + oy * 64, 64, 64);
    ctx.restore();
    if (name === 'water') {                               // deep-blue dark overlay: more saturated, less transparent
      ctx.save();
      ctx.beginPath(); ctx.rect(cellX, cellY, 128, 128); ctx.clip();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#0c1e2f';
      ctx.fillRect(cellX, cellY, 128, 128);
      ctx.restore();
    }
    if (name === 'grass_block_top') {                     // opaque tile: multiply tint (rich)
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = tint;
      ctx.fillRect(cellX, cellY, 128, 128);
      ctx.globalCompositeOperation = 'source-over';
    } //else if (name === 'grass' || name === 'tallgrass') {
      // short-grass sprite: light green tint over the existing blade pixels only (source-atop
      // never touches the transparent gaps).
     // ctx.save();
     // ctx.beginPath(); ctx.rect(cellX, cellY, 128, 128); ctx.clip();
      //ctx.globalCompositeOperation = 'source-atop';
      //ctx.globalAlpha = 0.8;
     // ctx.fillStyle = tint;
     // ctx.fillRect(cellX, cellY, 128, 128);
     // ctx.restore();
    //}
  });

  _cacheAtlas(cvs);          // async, off the critical path — next boot skips every fetch above
  return _atlasTexFrom(cvs);
}

