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
                     ,'oak_sapling', 'birch_sapling', 'sugar_cane'];
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

async function buildAtlas() {
  // item sprites load alongside block tiles so drop geometry can read pixels synchronously
  await Promise.all([
    ...Object.keys(TEXTURES).map(n => loadImage(n)),
    ...Object.entries(ITEM_TEXTURES).map(([n, u]) => loadImage(n, u)),
    // armor-overlay sheets live in IMAGES too, but never enter the block atlas
    ...Object.entries(EQUIP_TEXTURES).map(([n, u]) => loadImage(n, u).catch(() => {})),
  ]);

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

  const tex = new THREE.CanvasTexture(cvs);
  tex.magFilter = THREE.NearestFilter;                    // crisp voxels up close
  tex.minFilter = THREE.NearestMipmapLinearFilter;        // mipmaps for the distance
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  return tex;
}

