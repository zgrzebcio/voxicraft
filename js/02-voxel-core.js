'use strict';
/* voxiCraft — VOXEL_CORE + WORKER_MAIN: terrain gen, mesher, block registry. Stringified into the worker blob — MUST stay self-contained (no outer-scope references) */

/* ================================================================================================
   VOXEL_CORE — code shared verbatim between the main thread and the web workers.
   This function is stringified into the worker blob, so it must be fully self-contained
   (no references to outer-scope variables). It provides:
     - the block registry (IDs + per-type properties, per-face tiles, geometry model)
     - seeded simplex noise + terrain generator
     - the greedy mesher
   ================================================================================================ */
function VOXEL_CORE() {
  'use strict';

  /* ---------- block registry ----------
     Every block = numeric ID + properties. A voxel in storage is a uint16:
       low byte  = block ID
       high byte = variant/metadata (wool colour, wood type, rotation bits... reserved for
                   future use — it is carried through storage and the mesher already).
     `model` describes geometry: 'cube' is the only model implemented, but the mesher
     dispatches on it so slabs/stairs/torches can be added without touching cube code.
     `faces` = atlas tile per face, ordered [+X, -X, +Y(top), -Y(bottom), +Z, -Z].          */
  const T = { GRASS_TOP:0, GRASS_SIDE:1, DIRT:2, STONE:3, SAND:4, BEDROCK:5,
              LOG:6, LOG_TOP:7, PLANKS:8, LEAVES:9, GLASS:10, WATER:11, GLOWSTONE:12,
              CLAY:13, SNOW:14, GRASS_SNOW_SIDE:15, COBBLE:16,
              COAL_ORE:17, IRON_ORE:18, DIAMOND_ORE:19, GRAVEL:20, RED_MUSHROOM:21, BROWN_MUSHROOM:22,
              CRAFT_TOP:23, CRAFT_FRONT:24, CRAFT_SIDE:25, TORCH:26,
              FURNACE_FRONT:27, FURNACE_FRONT_ON:28, FURNACE_SIDE:29, FURNACE_TOP:30,
              RED_SAND:31, CACTUS_SIDE:32, CACTUS_TOP:33, CACTUS_BOTTOM:34, BRICKS:35, MELON_TOP:36, MELON_SIDE:37, STONE_BRICK:38, WOOL:39,
              PUMPKIN_TOP:40, PUMPKIN_SIDE:41, WHEAT:42, TIN_ORE:43, COPPER_ORE:44, GOLD_ORE:45,
              BIRCH_LOG:43, BIRCH_LOG_TOP:44, BIRCH_PLANKS:45, BIRCH_LEAVES:46,
              HAY_TOP:47, HAY_SIDE:48, MARBLE:49, GRANITE:50, LIMESTONE:51,
              GRASS_PLANT:52, POPPY:53, ORCHID:54, TALL_BOT:55, TALL_TOP:56, LAVA:57, TIN_ORE:58, GOLD_ORE:59, COPPER_ORE:60,
              OBSIDIAN:61, TNT_TOP:62, TNT_SIDE:63, TNT_BOTTOM:64, SULFUR_BLOCK:65, SULFUR_DOWN_TIP:66,
              SULFUR_UP_TIP:67, TNT_LIT:68, OAK_SAPLING:69, BIRCH_SAPLING:70, SUGAR_CANE:71 };
  const B = { AIR:0, GRASS:1, DIRT:2, STONE:3, LOG:4, PLANKS:5, LEAVES:6, SAND:7,
              GLASS:8, BEDROCK:9, WATER:10, GLOWSTONE:11, OAKSLAB:12, CLAY:13, SNOW:14, COBBLE:15,
              COAL_ORE:16, IRON_ORE:17, DIAMOND_ORE:18, GRAVEL:19, RED_MUSHROOM:20, BROWN_MUSHROOM:21,
              CRAFTING_BENCH:22, TORCH:23, FURNACE:24, RED_SAND:25, CACTUS:26, DOOR:27, STAIRS:28,
              COBBLESLAB:29, BRICKS:30, BRICKSSLAB:31, BRICKSSTAIRS:32, MELON:33, STONE_BRICK:34, STONE_BRICKSLAB:35,
              STONESLAB:36, CACTUSSLAB:37, GLASSSLAB:38, WOOL:39, PUMPKIN:40, WHEAT:41,
              BIRCH_LOG:42, BIRCH_PLANKS:43, BIRCH_LEAVES:44, HAY:45, MARBLE:46, GRANITE:47, LIMESTONE:48,
              TALLGRASS:49, POPPY:50, ORCHID:51, TALL_LOWER:52, TALL_UPPER:53, TIN_ORE:54, GOLD_ORE:55, COPPER_ORE:56, LAVA:57, SNOW_CARPET:58, 
              OBSIDIAN:59, SULFUR_BLOCK:60, SULFUR_DOWN_TIP:61, SULFUR_UP_TIP:62, OAK_SAPLING:63, BIRCH_SAPLING:64, SUGAR_CANE:65, TNT:66, };
  /* variant byte layout:
     - grass: 1 = snowy sides
     - rot:'side' blocks (furnace, bench): bits 0-1 = facing (0:+Z 1:-Z 2:+X 3:-X);
       furnace additionally uses bit 2 (value 4) = lit
     - log (rot:'all'): 0 = Y axis, 1 = X (lying), 2 = Z (lying)
     - slab (rot:'all'): 0 bottom, 1 top(ceiling), 2..5 vertical halves (-X,+X,-Z,+Z side) */
  const V = { GRASS_SNOWY:1, FURNACE_ON:4 };
  const SIDE_FACE = [4, 5, 0, 1];            // facing bits -> faces[] index of the front
  // pass: 0 = opaque, 1 = cutout/transparent (leaves, glass), 2 = water
  // `light` = block-light emission level (0..15); glowstone lights up to 14 blocks around
  const PROPS = [];
  // `hardness` = seconds to break by hand in survival. Infinity = unbreakable (bedrock).
  PROPS[B.AIR]     = { name:'Air',        solid:false, opaque:false, raycast:false, pass:0, model:'cube', hardness:0,    faces:null };
  PROPS[B.GRASS]   = { name:'Grass',      solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:2.0,  faces:[T.GRASS_SIDE,T.GRASS_SIDE,T.GRASS_TOP,T.DIRT,T.GRASS_SIDE,T.GRASS_SIDE] };
  PROPS[B.DIRT]    = { name:'Dirt',       solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:1.8, faces:[T.DIRT,T.DIRT,T.DIRT,T.DIRT,T.DIRT,T.DIRT] };
  PROPS[B.STONE]   = { name:'Stone',      solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:8.0,  faces:[T.STONE,T.STONE,T.STONE,T.STONE,T.STONE,T.STONE] };
  // slim log collision/raycast boxes per trunk axis (match the inset visual). opaque:false so a
  // log never culls its neighbours' faces (otherwise the 1/16 gap around it shows holes).
  const LOG_COLL = [ [[0.0625,0,0.0625, 0.9375,1,0.9375]],   // var 0: Y-axis
                     [[0,0.0625,0.0625, 1,0.9375,0.9375]],   // var 1: X-axis
                     [[0.0625,0.0625,0, 0.9375,0.9375,1]] ];  // var 2: Z-axis
  PROPS[B.LOG]     = { name:'Oak log',    solid:true,  opaque:false, raycast:true,  pass:0, model:'log', rot:'all', stack:60, hardness:4.0, boxes:LOG_COLL[0], boxesByVar:LOG_COLL, faces:[T.LOG,T.LOG,T.LOG_TOP,T.LOG_TOP,T.LOG,T.LOG] };
  PROPS[B.PLANKS]  = { name:'Oak planks', solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:4.0,  faces:[T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS] };
  PROPS[B.LEAVES]  = { name:'Oak leaves',     solid:false, opaque:false, raycast:true,  pass:1, model:'cube', stack:60, hardness:0.4,  faces:[T.LEAVES,T.LEAVES,T.LEAVES,T.LEAVES,T.LEAVES,T.LEAVES] };
  PROPS[B.BIRCH_LOG]    = { name:'Birch log',    solid:true,  opaque:false,  raycast:true, pass:0, model:'log', rot:'all', stack:60, hardness:4.0, boxes:LOG_COLL[0], boxesByVar:LOG_COLL, faces:[T.BIRCH_LOG,T.BIRCH_LOG,T.BIRCH_LOG_TOP,T.BIRCH_LOG_TOP,T.BIRCH_LOG,T.BIRCH_LOG] };
  PROPS[B.BIRCH_PLANKS] = { name:'Birch planks', solid:true,  opaque:true,  raycast:true, pass:0, model:'cube', stack:60, hardness:3.0, faces:[T.BIRCH_PLANKS,T.BIRCH_PLANKS,T.BIRCH_PLANKS,T.BIRCH_PLANKS,T.BIRCH_PLANKS,T.BIRCH_PLANKS] };
  PROPS[B.BIRCH_LEAVES] = { name:'Birch leaves', solid:false, opaque:false, raycast:true, pass:1, model:'cube', stack:60, hardness:0.4, faces:[T.BIRCH_LEAVES,T.BIRCH_LEAVES,T.BIRCH_LEAVES,T.BIRCH_LEAVES,T.BIRCH_LEAVES,T.BIRCH_LEAVES] };
  PROPS[B.SAND]    = { name:'Sand',       solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:1.9, faces:[T.SAND,T.SAND,T.SAND,T.SAND,T.SAND,T.SAND] };
  PROPS[B.GLASS]   = { name:'Glass',      solid:true,  opaque:false, raycast:true,  pass:1, model:'cube', stack:60, hardness:0.9, faces:[T.GLASS,T.GLASS,T.GLASS,T.GLASS,T.GLASS,T.GLASS] };
  PROPS[B.BEDROCK] = { name:'Bedrock',    solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:Infinity, faces:[T.BEDROCK,T.BEDROCK,T.BEDROCK,T.BEDROCK,T.BEDROCK,T.BEDROCK] };
  PROPS[B.WATER]   = { name:'Water',      solid:false, opaque:false, raycast:false, pass:2, model:'cube', hardness:0,    faces:[T.WATER,T.WATER,T.WATER,T.WATER,T.WATER,T.WATER] };
  PROPS[B.GLOWSTONE] = { name:'Glowstone', solid:true, opaque:true, raycast:true, pass:0, model:'cube', light:20,handLight:10, stack:60, hardness:2.5, faces:[T.GLOWSTONE,T.GLOWSTONE,T.GLOWSTONE,T.GLOWSTONE,T.GLOWSTONE,T.GLOWSTONE] };
  // first non-cube model: bottom-half slab. opaque:false so neighbours keep their faces
  // (no holes behind it); `boxes` = collision sub-boxes; variant byte reserved for top slabs.
  // slab variants — shared by both slab types (collision, raycast, mesher):
  //  0-5           single half (bottom/top/west/east/north/south)
  //  6+o           same-type double, o = axis (0=Y,1=X,2=Z) — full cell, two half boxes
  //  16+pi*8+v     mixed double: THIS block occupies half v (box0), partner slab (SLAB_IDS[pi])
  //                occupies complement v^1 (box1). pi = partner's index in the slab registry.
  const SLAB_HALF = [[0,0,0,1,0.5,1],[0,0.5,0,1,1,1],[0,0,0,0.5,1,1],[0.5,0,0,1,1,1],[0,0,0,1,1,0.5],[0,0,0.5,1,1,1]];
  const SLAB_VAR = [];
  {
    const bx = SLAB_HALF;
    for (let v = 0; v < 6; v++) SLAB_VAR[v] = [bx[v]];
    for (let o = 0; o < 3; o++) SLAB_VAR[6 + o] = [bx[2*o], bx[2*o + 1]];
    // mixed-double box geometry depends only on own half v (partner just picks the tile)
    for (let pi = 0; pi < 16; pi++)
      for (let v = 0; v < 6; v++) SLAB_VAR[16 + pi*8 + v] = [bx[v], bx[v ^ 1]];
  }
  // cactus slab: same halves, but inset 1/16 on the two full axes so it reads thin (cactus-arm look)
  const CACTUS_SLAB_VAR = SLAB_VAR.map(boxes => boxes && boxes.map(b => {
    const o = b.slice();
    for (let a = 0; a < 3; a++) if (b[a+3] - b[a] > 0.99) { o[a] += 0.0625; o[a+3] -= 0.0625; }
    return o;
  }));
  // slab registry (compact index <-> block id) — partner index for mixed doubles, fits 0..15
  const SLAB_IDS = [];
  PROPS[B.OAKSLAB]    = { name:'Oak slab',   solid:true,  opaque:false, raycast:true,  pass:0, model:'slab', rot:'all', stack:60, hardness:4.0, boxes:[[0,0,0,1,0.5,1]], boxesByVar: SLAB_VAR, faces:[T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS] };
  PROPS[B.CLAY]    = { name:'Clay',       solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:2.2,  faces:[T.CLAY,T.CLAY,T.CLAY,T.CLAY,T.CLAY,T.CLAY] };
  PROPS[B.SNOW]    = { name:'Snow',       solid:true,  opaque:true,  raycast:true,  pass:0, model:'cube', stack:60, hardness:1.2,  faces:[T.SNOW,T.SNOW,T.SNOW,T.SNOW,T.SNOW,T.SNOW] };
  // snow carpet: 1..6 layer stack, variant 0..5 = layer count-1. 6 layers == full block visually.
  // Placed like a plant (topOnly, on any solid). Right-clicking one with a carpet adds a layer.
  // Break yields a single carpet regardless of stack height.
  const CARPET_VAR = [];
  for (let v = 0; v < 6; v++) CARPET_VAR[v] = [[0, 0, 0, 1, (v + 1) / 6, 1]];
  PROPS[B.SNOW_CARPET] = { name:'Snow carpet', solid:true, opaque:false, raycast:true, pass:0, model:'carpet', topOnly:true, stack:60, hardness:0.3, boxes:CARPET_VAR[0], boxesByVar:CARPET_VAR, faces:[T.SNOW,T.SNOW,T.SNOW,T.SNOW,T.SNOW,T.SNOW] };
  PROPS[B.COBBLE]      = { name:'Cobblestone', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:8.0, faces:[T.COBBLE,T.COBBLE,T.COBBLE,T.COBBLE,T.COBBLE,T.COBBLE] };
  PROPS[B.COAL_ORE]    = { name:'Coal ore',    solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:9.0,  faces:[T.COAL_ORE,T.COAL_ORE,T.COAL_ORE,T.COAL_ORE,T.COAL_ORE,T.COAL_ORE] };
  PROPS[B.IRON_ORE]    = { name:'Iron ore',    solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:12.0,  faces:[T.IRON_ORE,T.IRON_ORE,T.IRON_ORE,T.IRON_ORE,T.IRON_ORE,T.IRON_ORE] };
  PROPS[B.DIAMOND_ORE] = { name:'Diamond ore', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:18.0, faces:[T.DIAMOND_ORE,T.DIAMOND_ORE,T.DIAMOND_ORE,T.DIAMOND_ORE,T.DIAMOND_ORE,T.DIAMOND_ORE] };
  PROPS[B.COPPER_ORE]    = { name:'Copper ore',    solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:10.0,  faces:[T.COPPER_ORE,T.COPPER_ORE,T.COPPER_ORE,T.COPPER_ORE,T.COPPER_ORE,T.COPPER_ORE] };
  PROPS[B.TIN_ORE]    = { name:'Tin ore',    solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:13.0,  faces:[T.TIN_ORE,T.TIN_ORE,T.TIN_ORE,T.TIN_ORE,T.TIN_ORE,T.TIN_ORE] };
  PROPS[B.GOLD_ORE]    = { name:'Gold ore',    solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:15.0,  faces:[T.GOLD_ORE,T.GOLD_ORE,T.GOLD_ORE,T.GOLD_ORE,T.GOLD_ORE,T.GOLD_ORE] };
  PROPS[B.MARBLE]      = { name:'Marble',    solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:8.0, faces:[T.MARBLE,T.MARBLE,T.MARBLE,T.MARBLE,T.MARBLE,T.MARBLE] };
  PROPS[B.GRANITE]     = { name:'Granite',   solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:8.5, faces:[T.GRANITE,T.GRANITE,T.GRANITE,T.GRANITE,T.GRANITE,T.GRANITE] };
  PROPS[B.LIMESTONE]   = { name:'Limestone', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:7.5, faces:[T.LIMESTONE,T.LIMESTONE,T.LIMESTONE,T.LIMESTONE,T.LIMESTONE,T.LIMESTONE] };
  PROPS[B.LAVA]        = { name:'Lava',      solid:false,opaque:false, raycast:false, pass:3, model:'cube', light:15, hardness:0, faces:[T.LAVA,T.LAVA,T.LAVA,T.LAVA,T.LAVA,T.LAVA] };
  // Sulfur crystal block: full opaque cube, drops itself. Common cave form.
  PROPS[B.SULFUR_BLOCK] = { name:'Sulfur block', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:2.5, faces:[T.SULFUR_BLOCK,T.SULFUR_BLOCK,T.SULFUR_BLOCK,T.SULFUR_BLOCK,T.SULFUR_BLOCK,T.SULFUR_BLOCK] };
  // Sulfur tip billboards: cross model, two orientations. Down tip = stalactite (from ceiling),
  // up tip = stalagmite (from floor). Break drops ITEM.SULFUR only (handled in blockDrop).
  // Sulfur tip — single placeable block with rotation via variant (0 = up, 1 = down).
  // Legacy SULFUR_DOWN_TIP kept for storage compatibility, hidden from inventory, drops as SULFUR_UP_TIP.
  PROPS[B.SULFUR_DOWN_TIP] = { name:'Sulfur tip', solid:false, opaque:false, raycast:true, pass:1, model:'cross', noInv:true, stack:60, hardness:0.6, boxes:[[0.2,0.2,0.2,0.8,1,0.8]], faces:[T.SULFUR_DOWN_TIP] };
  PROPS[B.SULFUR_UP_TIP]   = { name:'Sulfur tip', solid:false, opaque:false, raycast:true, pass:1, model:'cross', stack:60, hardness:0.6, boxes:[[0.2,0,0.2,0.8,0.8,0.8]], faces:[T.SULFUR_UP_TIP] };
  // TNT: full cube. Variant byte's low bit (0/1) is the "lit" blink flag — mesher swaps faces to
  // the snow (white) tile when set, so a ticking TNT visibly pulses. hardness 0.5 for a quick pre-arm
  // break; a separate map (TNTS in 22-main-loop.js) protects blocks with an active fuse.
  PROPS[B.TNT] = { name:'TNT', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:0.5, faces:[T.TNT_SIDE,T.TNT_SIDE,T.TNT_TOP,T.TNT_BOTTOM,T.TNT_SIDE,T.TNT_SIDE] };
  // Obsidian: dark blast/lava-quench block. Very hard, pickaxe required (see MINE_REQ / TOOL_BLOCKS).
  PROPS[B.OBSIDIAN] = { name:'Obsidian', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:30, faces:[T.OBSIDIAN,T.OBSIDIAN,T.OBSIDIAN,T.OBSIDIAN,T.OBSIDIAN,T.OBSIDIAN] };
  // Saplings — placed on grass, grow into a tree after 7..14 in-game days (tracked in SAPLINGS map)
  PROPS[B.OAK_SAPLING]   = { name:'Oak sapling',   solid:false, opaque:false, raycast:true, pass:1, model:'cross', topOnly:true, stack:99, hardness:0, boxes:[[0.25,0,0.25,0.75,0.8,0.75]], faces:[T.OAK_SAPLING] };
  PROPS[B.BIRCH_SAPLING] = { name:'Birch sapling', solid:false, opaque:false, raycast:true, pass:1, model:'cross', topOnly:true, stack:99, hardness:0, boxes:[[0.25,0,0.25,0.75,0.8,0.75]], faces:[T.BIRCH_SAPLING] };
  // Sugar cane — cross billboard; only placeable on sand/grass/dirt next to water, or stacked on
  // an existing cane. Column capped at 5 blocks tall. Break drops one sugar cane per broken block.
  PROPS[B.SUGAR_CANE]    = { name:'Sugar cane',    solid:false, opaque:false, raycast:true, pass:1, model:'cross', stack:64, hardness:0, boxes:[[0.1,0,0.1,0.9,1,0.9]], faces:[T.SUGAR_CANE] };
  PROPS[B.GRAVEL]      = { name:'Gravel',      solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:2.5,  faces:[T.GRAVEL,T.GRAVEL,T.GRAVEL,T.GRAVEL,T.GRAVEL,T.GRAVEL] };
  PROPS[B.RED_MUSHROOM]  = { name:'Red mushroom',  solid:false,opaque:false,raycast:true, pass:1, model:'cross',stack:99, hardness:0, boxes:[[0.3,0,0.3,0.7,0.8,0.7]], faces:[T.RED_MUSHROOM] };
  PROPS[B.BROWN_MUSHROOM]= { name:'Brown mushroom',solid:false,opaque:false,raycast:true, pass:1, model:'cross',stack:99, hardness:0, boxes:[[0.3,0,0.3,0.7,0.8,0.7]], faces:[T.BROWN_MUSHROOM] };
  PROPS[B.TALLGRASS]     = { name:'Grass',   solid:false,opaque:false,raycast:true, pass:1, model:'cross',rot:'all',topOnly:true, stack:99, hardness:0, boxes:[[0.1,0,0.1,0.9,0.9,0.9]], faces:[T.GRASS_PLANT] };
  PROPS[B.POPPY]         = { name:'Poppy',   solid:false,opaque:false,raycast:true, pass:1, model:'cross',topOnly:true, stack:99, hardness:0, boxes:[[0.25,0,0.25,0.75,0.85,0.75]], faces:[T.POPPY] };
  PROPS[B.ORCHID]        = { name:'Blue orchid',solid:false,opaque:false,raycast:true, pass:1, model:'cross',topOnly:true, stack:99, hardness:0, boxes:[[0.25,0,0.25,0.75,0.85,0.75]], faces:[T.ORCHID] };
  PROPS[B.TALL_LOWER]    = { name:'Tall grass', solid:false,opaque:false,raycast:true, pass:1, model:'cross',topOnly:true, noInv:true, stack:99, hardness:0, boxes:[[0.05,0,0.05,0.95,1,0.95]], faces:[T.TALL_BOT] };
  PROPS[B.TALL_UPPER]    = { name:'Tall grass', solid:false,opaque:false,raycast:true, pass:1, model:'cross',noInv:true, stack:99, hardness:0, boxes:[[0.05,0,0.05,0.95,1,0.95]], faces:[T.TALL_TOP] };
  // faces [+X,-X,top,bottom,+Z,-Z]; front picked per variant (rot:'side') in the mesher
  PROPS[B.CRAFTING_BENCH] = { name:'Crafting bench', solid:true, opaque:true, raycast:true, pass:0, model:'cube', rot:'side', stack:30, hardness:4.5, faces:[T.CRAFT_SIDE,T.CRAFT_SIDE,T.CRAFT_TOP,T.PLANKS,T.CRAFT_FRONT,T.CRAFT_FRONT] };
  // torch: cross model (texture has transparent margins so it reads as a small stick),
  // light 10 placed / 5 in hand (handLight overrides the default held-light scaling),
  // topOnly = placeable only when clicking a block's top face
  PROPS[B.TORCH] = { name:'Torch', solid:false, opaque:false, raycast:true, pass:1, model:'cross', stack:99, hardness:0, light:15, handLight:8, topOnly:true, boxes:[[0.4,0,0.4,0.6,0.7,0.6]], faces:[T.TORCH] };
  // furnace: front picked per variant facing (rot:'side'); lit bit swaps the front tile
  PROPS[B.FURNACE] = { name:'Furnace', solid:true, opaque:true, raycast:true, pass:0, model:'cube', rot:'side', stack:30, hardness:8.5, faces:[T.FURNACE_SIDE,T.FURNACE_SIDE,T.FURNACE_TOP,T.FURNACE_TOP,T.FURNACE_FRONT,T.FURNACE_SIDE] };
  PROPS[B.RED_SAND] = { name:'Red Sand', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:2.1, faces:[T.RED_SAND,T.RED_SAND,T.RED_SAND,T.RED_SAND,T.RED_SAND,T.RED_SAND] };
  // oak door: 2-cell (bottom + upper half), 1/8 thick. Rendered as an animated standalone mesh
  // (27-doors.js) — the chunk mesher emits nothing for it. Collision boxes swap with the open
  // bit so an open door is passable. variant: bits 0-1 facing, bit 2 open, bit 3 upper half.
  {
    const t = 0.125;
    const closed = [[[0,0,0,1,1,t]], [[0,0,1-t,1,1,1]], [[0,0,0,t,1,1]], [[1-t,0,0,1,1,1]]];
    // open door: thin panel flush against a side wall INSIDE its own cell. 27-doors.js applies a
    // per-facing position nudge so the swung mesh lands exactly on these boxes (a corner-hinged
    // panel can't be flush both closed and open by rotation alone). Doorway stays clear — you walk
    // through the gap but not through the panel.
    const opened = [ [[0,0,0,t,1,1]], [[0,0,0,t,1,1]], [[0,0,0,1,1,t]], [[0,0,0,1,1,t]] ];
    const bv = [], rv = [];
    for (let v = 0; v < 16; v++) {
      bv[v] = (v & 4) ? opened[v & 3] : closed[v & 3];   // open door now has a thin panel hitbox
      rv[v] = bv[v];                                      // raycast == collision (both match the visual)
    }
    PROPS[B.DOOR] = { name:'Oak door', solid:true, opaque:false, raycast:true, pass:1, model:'door', rot:'side', stack:20, hardness:3.5, boxes:closed[0], boxesByVar:bv, rayBoxesByVar:rv, faces:[T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS] };
  }
  // oak stairs: base half-slab + back step. variant: bits 0-1 facing (full side toward player),
  // bit 2 (4) = upside-down (ceiling placement). Two boxes per variant, shared by collision,
  // raycast and the mesher.
  const STAIR_BOXES = [];
  for (let v = 0; v < 8; v++) {
    const f = v & 3, flip = v & 4;
    const base = flip ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
    const sy0 = flip ? 0 : 0.5, sy1 = flip ? 0.5 : 1;
    const step = f === 0 ? [0, sy0, 0,   1,   sy1, 0.5] : f === 1 ? [0,   sy0, 0.5, 1, sy1, 1]
               : f === 2 ? [0, sy0, 0,   0.5, sy1, 1  ] :           [0.5, sy0, 0,   1, sy1, 1];
    STAIR_BOXES[v] = [base, step];
  }
  // Minecraft-style stair corners: shape derived live from neighbouring stairs, not stored.
  // g(x,y,z) = block-val getter — the worker passes its chunk+neighbour reader, the main thread
  // passes getBlock, so collision, raycast, selection and the mesher all agree on the same shape.
  // NB: in this game the tall step sits on BACK(f); MC's `facing` points at that tall side, so
  // MC's facing dir = OPP[f]. All neighbour tests run in that "tall direction" (M) space.
  const STAIR_DIR = [[0,1],[0,-1],[1,0],[-1,0]];     // facing index -> unit dir: 0:+Z 1:-Z 2:+X 3:-X
  const STAIR_OPP = [1,0,3,2];                        // opposite facing index
  const STAIR_CCW = [2,3,1,0];                        // 90° CCW (top view) of a facing index
  const STAIR_CF = [                                  // per f: axisZ + back/front/left/right sub-indices
    { axisZ:true,  back:0, front:1, left:1, right:0 },
    { axisZ:true,  back:1, front:0, left:0, right:1 },
    { axisZ:false, back:0, front:1, left:0, right:1 },
    { axisZ:false, back:1, front:0, left:1, right:0 },
  ];
  function stairBoxesAt(g, x, y, z, val) {
    const f = (val >> 8) & 3, flip = (val >> 8) & 4;
    const M = STAIR_OPP[f];                           // MC facing = tall-side direction
    const isSt   = v => { const p = PROPS[v & 255]; return !!(p && p.model === 'stairs'); };
    const tallOf = v => STAIR_OPP[(v >> 8) & 3];      // a stair's tall-side dir index
    const flipOf = v => (v >> 8) & 4;
    const axis   = i => i < 2 ? 0 : 1;
    let shape = 0, fside = 0;                         // shape 0 straight, 1 inner, 2 outer; fside 0=left(f) 1=right(f)
    // outer: the stair the tall side faces (M) turns perpendicular, unless it's a continuing run
    const fd = STAIR_DIR[M], fv = g(x + fd[0], y, z + fd[1]);
    if (isSt(fv) && flipOf(fv) === flip && axis(tallOf(fv)) !== axis(M)) {
      const t = tallOf(fv), gd = STAIR_DIR[STAIR_OPP[t]], gg = g(x + gd[0], y, z + gd[1]);
      if (!isSt(gg) || tallOf(gg) !== M || flipOf(gg) !== flip) { shape = 2; fside = t === STAIR_CCW[M] ? 1 : 0; }
    }
    // inner: the stair on the low side (opp M) turns perpendicular (outer wins if both, per MC)
    if (!shape) {
      const bd = STAIR_DIR[STAIR_OPP[M]], bv = g(x + bd[0], y, z + bd[1]);
      if (isSt(bv) && flipOf(bv) === flip && axis(tallOf(bv)) !== axis(M)) {
        const t = tallOf(bv), gd = STAIR_DIR[t], gg = g(x + gd[0], y, z + gd[1]);
        if (!isSt(gg) || tallOf(gg) !== M || flipOf(gg) !== flip) { shape = 1; fside = t === STAIR_CCW[M] ? 1 : 0; }
      }
    }
    if (!shape) return STAIR_BOXES[(val >> 8) & 7] || STAIR_BOXES[0];
    const c = STAIR_CF[f];
    const sy0 = flip ? 0 : 0.5, sy1 = flip ? 0.5 : 1;
    const base = flip ? [0,0.5,0,1,1,1] : [0,0,0,1,0.5,1];
    const mkQ = (xi, zi) => [xi*0.5, sy0, zi*0.5, xi*0.5+0.5, sy1, zi*0.5+0.5];
    const strip = c.axisZ ? [0, sy0, c.back*0.5, 1, sy1, c.back*0.5+0.5]
                          : [c.back*0.5, sy0, 0, c.back*0.5+0.5, sy1, 1];
    const sIdx = fside ? c.right : c.left;
    if (shape === 2) {                               // outer corner: single back-side quarter step
      const q = c.axisZ ? mkQ(sIdx, c.back) : mkQ(c.back, sIdx);
      return [base, q];
    }
    const q = c.axisZ ? mkQ(sIdx, c.front) : mkQ(c.front, sIdx);   // inner: back strip + front-side quarter
    return [base, strip, q];
  }
  PROPS[B.STAIRS] = { name:'Oak stairs', solid:true, opaque:false, raycast:true, pass:0, model:'stairs', rot:'all', stack:60, hardness:3, boxes:STAIR_BOXES[0], boxesByVar:STAIR_BOXES, faces:[T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS,T.PLANKS] };
  // cactus: own model — side faces inset 1/16 so the column reads thin; touching it hurts (19-vitals)
  PROPS[B.CACTUS] = { name:'Cactus', solid:true, opaque:false, raycast:true, pass:1, model:'cactus', stack:60, hardness:1.4, boxes:[[0.0625,0,0.0625,0.9375,1,0.9375]], faces:[T.CACTUS_SIDE,T.CACTUS_SIDE,T.CACTUS_TOP,T.CACTUS_BOTTOM,T.CACTUS_SIDE,T.CACTUS_SIDE] };
  PROPS[B.COBBLESLAB]    = { name:'Cobblestone slab',   solid:true,  opaque:false, raycast:true,  pass:0, model:'slab', rot:'all', stack:60, hardness:8, boxes:[[0,0,0,1,0.5,1]], boxesByVar: SLAB_VAR, faces:[T.COBBLE,T.COBBLE,T.COBBLE,T.COBBLE,T.COBBLE,T.COBBLE] };
  PROPS[B.BRICKS]    = { name:'Bricks', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:6.5, faces:[T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS] };
  PROPS[B.BRICKSSLAB]    = { name:'Brick slab',   solid:true,  opaque:false, raycast:true,  pass:0, model:'slab', rot:'all', stack:60, hardness:6.5, boxes:[[0,0,0,1,0.5,1]], boxesByVar: SLAB_VAR,faces:[T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS] };
  PROPS[B.BRICKSSTAIRS] = { name:'Oak stairs', solid:true, opaque:false, raycast:true, pass:0, model:'stairs', rot:'all', stack:60, hardness:6.5, boxes:STAIR_BOXES[0], boxesByVar:STAIR_BOXES,faces:[T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS,T.BRICKS] };
  PROPS[B.MELON]    = { name:'Watermelon', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:2.5, faces:[T.MELON_SIDE,T.MELON_SIDE,T.MELON_TOP,T.MELON_TOP,T.MELON_SIDE,T.MELON_SIDE] };
  PROPS[B.PUMPKIN]  = { name:'Pumpkin', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:2.5, faces:[T.PUMPKIN_SIDE,T.PUMPKIN_SIDE,T.PUMPKIN_TOP,T.PUMPKIN_TOP,T.PUMPKIN_SIDE,T.PUMPKIN_SIDE] };
  PROPS[B.WHEAT]    = { name:'Wheat', solid:false, opaque:false, raycast:true, pass:1, model:'cross', stack:99, hardness:0, boxes:[[0.15,0,0.15,0.85,0.9,0.85]], faces:[T.WHEAT] };
  PROPS[B.STONE_BRICK]    = { name:'Stone brick', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:8.5, faces:[T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK] };
  PROPS[B.STONE_BRICKSLAB]    = { name:'Stone brick slab', solid:true, opaque:false, raycast:true, pass:0, model:'slab', rot:'all', stack:60, hardness:8.5, boxes:[[0,0,0,1,0.5,1]], boxesByVar: SLAB_VAR, faces:[T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK,T.STONE_BRICK] };
  PROPS[B.STONESLAB]    = { name:'Stone slab', solid:true, opaque:false, raycast:true, pass:0, model:'slab', rot:'all', stack:60, hardness:8.0, boxes:[[0,0,0,1,0.5,1]], boxesByVar: SLAB_VAR, faces:[T.STONE,T.STONE,T.STONE,T.STONE,T.STONE,T.STONE] };
  PROPS[B.CACTUSSLAB]    = { name:'Cactus slab', solid:true, opaque:false, raycast:true, pass:0, model:'slab', rot:'all', stack:60, hardness:1.0, boxes:CACTUS_SLAB_VAR[0], boxesByVar: CACTUS_SLAB_VAR, faces:[T.CACTUS_SIDE,T.CACTUS_SIDE,T.CACTUS_TOP,T.CACTUS_BOTTOM,T.CACTUS_SIDE,T.CACTUS_SIDE] };
  PROPS[B.GLASSSLAB]    = { name:'Glass slab', solid:true, opaque:false, raycast:true, pass:0, model:'slab', rot:'all', stack:60, hardness:0.9, boxes:[[0,0,0,1,0.5,1]], boxesByVar: SLAB_VAR, faces:[T.GLASS,T.GLASS,T.GLASS,T.GLASS,T.GLASS,T.GLASS] };
  PROPS[B.WOOL]    = { name:'Wool', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:2.5, faces:[T.WOOL,T.WOOL,T.WOOL,T.WOOL,T.WOOL,T.WOOL] };
  PROPS[B.HAY]     = { name:'Hay bale', solid:true, opaque:true, raycast:true, pass:0, model:'cube', stack:60, hardness:1.0, faces:[T.HAY_SIDE,T.HAY_SIDE,T.HAY_TOP,T.HAY_TOP,T.HAY_SIDE,T.HAY_SIDE] };
  // auto-wire geometry: any block declared model 'slab'/'stairs' inherits the shared collision/
  // raycast/mesh box tables, so a new one needs only { model, faces } — no per-block box wiring.
  for (let id = 0; id < PROPS.length; id++) {
    const p = PROPS[id];
    if (!p) continue;
    if (p.model === 'slab'   && !p.boxesByVar) { p.boxesByVar = SLAB_VAR;    p.boxes = SLAB_VAR[0]; }
    if (p.model === 'stairs' && !p.boxesByVar) { p.boxesByVar = STAIR_BOXES; p.boxes = STAIR_BOXES[0]; }
    if (p.model === 'slab') SLAB_IDS.push(id);   // registry order = ascending id; index used as mixed-double partner key
  }
  const CX = 16, CY = 200, CZ = 16, WATER_LEVEL = 99;
  const idx = (x, y, z) => x + (z << 4) + (y << 8);   // voxel index inside a chunk

  /* ---------- seeded PRNG + 2D simplex noise ---------- */
  function xmur3(str) {                       // string hash -> 32-bit seed stream
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function sfc32(a, b, c, d) {
    return () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  const G2D = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  const F2 = 0.5 * (Math.sqrt(3) - 1), GG2 = (3 - Math.sqrt(3)) / 6;

  function makeNoise(rand) {
    const p = new Uint8Array(512);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {           // Fisher–Yates with seeded PRNG
      const j = (rand() * (i + 1)) | 0;
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

    return function noise2(xin, yin) {        // classic Gustavson simplex, range ~[-1,1]
      let n0 = 0, n1 = 0, n2 = 0;
      const s = (xin + yin) * F2;
      const i = Math.floor(xin + s), j = Math.floor(yin + s);
      const t = (i + j) * GG2;
      const x0 = xin - (i - t), y0 = yin - (j - t);
      const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
      const x1 = x0 - i1 + GG2, y1 = y0 - j1 + GG2;
      const x2 = x0 - 1 + 2 * GG2, y2 = y0 - 1 + 2 * GG2;
      const ii = i & 255, jj = j & 255;
      let t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) { t0 *= t0; const g = G2D[p[ii + p[jj]] & 7];       n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
      let t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) { t1 *= t1; const g = G2D[p[ii + i1 + p[jj + j1]] & 7]; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
      let t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 > 0) { t2 *= t2; const g = G2D[p[ii + 1 + p[jj + 1]] & 7];   n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
      return 70 * (n0 + n1 + n2);
    };
  }

  /* ---------- terrain generator ---------- */
  function makeGen(seedStr) {
    const seedFn = xmur3(String(seedStr));
    const seedInt = seedFn();
    const noise2 = makeNoise(sfc32(seedFn(), seedFn(), seedFn(), seedFn()));

    function fbm(x, y, oct) {                 // fractal brownian motion
      let sum = 0, amp = 1, freq = 1, norm = 0;
      for (let o = 0; o < oct; o++) {
        sum += amp * noise2(x * freq, y * freq);
        norm += amp; amp *= 0.5; freq *= 2;
      }
      return sum / norm;
    }
    const smooth01 = (t, a, b) => {
      t = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };

    // world-space column terrain sample: continents + biome-weighted hills + ridged mountains.
    // The biome selector `t` sweeps forest -> plains -> desert; fPlains rises through BOTH
    // plains and desert (it flattens hills/mountains and fades out trees), while fDesert
    // separates desert from plains. Both factors are smooth 0..1 so borders blend seamlessly.
    function terrainInfo(x, z) {
      const cont   = fbm(x * 0.0016, z * 0.0016, 3);
      const hills  = fbm(x * 0.009 + 37.3, z * 0.009 - 11.7, 4);
      const ridge  = 1 - Math.abs(fbm(x * 0.004 + 91.1, z * 0.004 + 57.9, 3));
      const mMask  = smooth01((fbm(x * 0.0011 - 71.7, z * 0.0011 + 13.9, 2) + 1) * 0.5, 0.44, 0.74);

      // biome selector, domain-warped + high-frequency dither so borders meander instead of
      // following the razor-straight contours of a single low-frequency noise
      // wider warp + no fine dither: border wobble happens at ~250-block wavelength,
      // so a biome pocket can't be narrower than ~25-30 blocks in either axis.
      // warp amplitude 80 (was 120): strong enough to meander borders, weak enough that the
      // warp can no longer pinch a biome band into a ~10-block sliver. Lower selector freq
      // (0.0009) makes every biome patch larger overall.
      const bwx = x + noise2(x * 0.004 + 313.1, z * 0.004 - 97.7) * 80;
      const bwz = z + noise2(x * 0.004 - 411.9, z * 0.004 + 229.3) * 80;
      const t = fbm(bwx * 0.0009 + 523.7, bwz * 0.0009 - 331.9, 2);
      // climate temperature (separate low-freq field): deserts need HOT, snow needs COLD. Because
      // it's one smooth field, hot and cold regions are always separated by a temperate band —
      // so a snow biome can never sit next to a desert.
      // temperate spawn: 99% of seeds pull the temperature field toward 0 near origin so
       // the player lands in Forest/Plains, not Snow/Desert. 1% skip the bias so extreme
       // spawns still happen occasionally (future temperature-system stress test).
       let temp = fbm(x * 0.00075 + 811.3, z * 0.00075 - 442.1, 2);
       if ((seedInt >>> 0) % 100 !== 0) {
         const bias = 1 - smooth01(Math.hypot(x, z), 120, 480);   // 1 at origin, 0 past 480
         temp *= (1 - bias * 0.95);
       }
      const warm = smooth01(temp, 0.02, 0.30);
      const cold = smooth01(-temp, 0.02, 0.30);

      const fPlains = smooth01(t, 0.0, 0.1);            // narrower band -> smaller plains
      const fDesert = smooth01(t, 0.16, 0.28) * warm;  // wider band = bigger deserts; hot climate only
      const fSnow   = cold;                             // snowy surface in cold climate

      // `flat` saturates at fPlains=0.5 — the exact point where the biome label flips to
      // Plains/Desert — so everywhere labelled Plains is genuinely flat (no half-suppressed
      // mountains leaking across the border band)
      const flat    = Math.min(1, fPlains * 2);
      const hillAmp = 6 * (1 - flat) + (0.8 + 1.2 * fDesert) * flat;       // plains ~dead flat; deserts mostly flat too
      const mTerm   = mMask * ridge * ridge * 90 * (1 - flat);             // mountains only in forest zones
      // desert hills sub-biome: tall dunes / small sandy mountains with rocky tops
      const dh     = smooth01(fbm(x * 0.0035 + 641.3, z * 0.0035 - 141.7, 2), 0.25, 0.62) * fDesert;   // rarer dune hills = flatter deserts
      // red sand sub-desert: separate low-freq mask splits hot deserts into normal / red zones
      const fRed = smooth01(fbm(x * 0.00065 - 911.7, z * 0.00065 + 617.3, 2), 0.22, 0.36) * fDesert;   // half freq = 2x patch size
      // red spike hills: narrow ridged spikes (all red sand — no sandstone yet), clustered
      // by their own hill mask so flat red desert and spike fields both exist
      const rdh = smooth01(fbm(x * 0.0035 + 941.3, z * 0.0035 - 241.7, 2), 0.1, 0.55) * fRed;
      let h = 102 + cont * 16 + hills * hillAmp + mTerm + dh * 30;
      if (rdh > 0.01) {
        const sp = 1 - Math.abs(fbm(x * 0.045 + 77.7, z * 0.045 - 55.5, 2));
        h += Math.pow(smooth01(sp, 0.78, 0.97), 2) * 30 * rdh;
      }
      if (cont < -0.2) h += (cont + 0.2) * 45;          // continental shelf -> oceans
      // deep ocean: separate low-freq mask carves broad abyssal basins well below the shelf
      const deep = smooth01(fbm(x * 0.0009 + 1571.3, z * 0.0009 - 733.1, 2), 0.02, 0.42)
                 * smooth01(-cont, 0.16, 0.3);          // only inside real oceans
      h -= deep * 34;

      // rivers & lakes (fade out in deserts, oceans, real mountains). Carving is TWO-tier so
      // water never sits in a canyon: a broad `valley` mask first eases the surrounding land
      // gently down to a low rim, then a tighter `core` mask scoops a shallow basin. Because
      // the rim descent spans a wide noise band, high plains/forest slope down to the shore
      // over many blocks instead of leaving vertical walls beside the water.
      let rT = 0, lk = 0;
      // river/lake carving stays active across the continental shelf so a river mouth cuts
      // straight through to the ocean instead of fading out and leaving a beach ridge
      const landF = smooth01(cont, -0.30, -0.20) * (1 - fDesert) * (1 - Math.min(1, mTerm / 18));
      if (landF > 0.01) {
        const rn = 1 - Math.abs(fbm(x * 0.0014 + 1223.7, z * 0.0014 - 817.3, 2));   // river ridge (lower freq -> longer rivers)
        const ln = fbm(x * 0.0042 - 313.7, z * 0.0042 + 991.1, 2);                  // lake blobs
        const valley = Math.max(smooth01(ln, 0.18, 0.74), smooth01(rn, 0.34, 0.95)) * landF;
        // wider river core band (0.88-0.965): rivers are several blocks across at minimum,
        // never a 1-block water thread at the threshold edge
        const core   = Math.max(smooth01(ln, 0.64, 0.84), smooth01(rn, 0.88, 0.965)) * landF;
        if (valley > 0.001) {
          const rim = WATER_LEVEL + 1, floor = WATER_LEVEL - 3;    // 64 rim, 60 floor (shallow)
          let target = h + (rim - h) * valley;                     // ease land down to the rim
          target += (floor - rim) * core;                          // then scoop the basin
          if (target < h) h = target;                              // only ever lower terrain
        }
        rT = smooth01(rn, 0.88, 0.965) * landF;
        lk = smooth01(ln, 0.64, 0.84) * landF;
      }
      h = Math.min(196, Math.max(4, Math.floor(h)));
      return { h, fPlains, fDesert, fSnow, dh, fRed, rdh, rT, lk, deep };
    }
    const heightAt = (x, z) => terrainInfo(x, z).h;

    // biome classification — used by the generator and by the HUD label on the main thread
    function biomeAt(x, z) {
      const { h, fPlains, fDesert, fSnow, dh, fRed, rdh, rT, lk, deep } = terrainInfo(x, z);
      if (h < WATER_LEVEL) {
        if (rT > 0.3 && rT >= lk) return 'River';
        if (lk > 0.3) return 'Lake';
        if (deep > 0.45 && h < 84) return 'Deep Ocean';
        return h < 94 ? 'Ocean' : 'Beach';
      }
      if (h <= WATER_LEVEL + 3) {
        // find nearest wet column and its type; ocean uses width 4..8, river/lake 2..4
        let hitType = 0, minD2 = 9999;
        for (let dz = -8; dz <= 8; dz++)
          for (let dx = -8; dx <= 8; dx++) {
            const ti = terrainInfo(x + dx, z + dz);
            if (ti.h >= WATER_LEVEL) continue;
            const t = (ti.rT > 0.3 || ti.lk > 0.3) ? 2 : 1;
            const d2 = dx * dx + dz * dz;
            if (d2 < minD2) { minD2 = d2; hitType = t; }
          }
        const bn = (fbm(x * 0.007 + 217.3, z * 0.007 - 803.7, 2) + 1) * 0.5;
        const width = hitType === 1 ? 4 + bn * 4 : 2 + bn * 2;
        const dist  = Math.sqrt(minD2);
        const dither = fbm(x * 0.02 + 401.3, z * 0.02 - 193.7, 2) * 0.8;
        const nearWater = hitType > 0 && dist < width + dither;
        if (nearWater) {
          if (rT > 0.3 && rT >= lk) return 'River';
          if (lk > 0.3) return 'Lake';
          return 'Beach';
        }
      }
      if (fRed > 0.5) return rdh > 0.35 ? 'Red Sand Hills' : 'Red Sand';
      if (fDesert > 0.5) return dh > 0.35 ? 'Desert Hills' : 'Desert';
      if (fSnow > 0.5) {
        if (h > 132) return 'Snowy Mountains';
        // snow forest sub-biome: same mask the tree pass uses; outside it snow is treeless
        return fbm(x * 0.004 + 2222, z * 0.004 + 888, 2) > 0.25 ? 'Snow Forest' : 'Snow';
      }
      if (h > 132) return 'Mountains';
      if (fPlains > 0.5) return 'Plains';
      if (fbm(x * 0.004 + 1234, z * 0.004 - 987, 2) > 0.35) return 'Birch Forest';   // matches birchRegion
      return 'Forest';
    }

    // deterministic per-column hash in [0,1) — used for tree placement
    function hash2(x, z) {
      let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) ^ seedInt;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }

    // 3D value noise for cave carving: hashed lattice + trilinear smoothstep interpolation
    function hash3(x, y, z) {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 217645177) + Math.imul(z, 668265263)) ^ seedInt;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }
    function vnoise3(x, y, z) {
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      const fx = x - ix, fy = y - iy, fz = z - iz;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
      const c000 = hash3(ix, iy, iz),     c100 = hash3(ix + 1, iy, iz);
      const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz);
      const c001 = hash3(ix, iy, iz + 1),     c101 = hash3(ix + 1, iy, iz + 1);
      const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1);
      const x00 = c000 + (c100 - c000) * sx, x10 = c010 + (c110 - c010) * sx;
      const x01 = c001 + (c101 - c001) * sx, x11 = c011 + (c111 - c011) * sx;
      const y0 = x00 + (x10 - x00) * sy, y1 = x01 + (x11 - x01) * sy;
      return (y0 + (y1 - y0) * sz) * 2 - 1;
    }
    function fbm3(x, y, z, oct) {
      let sum = 0, amp = 1, freq = 1, norm = 0;
      for (let o = 0; o < oct; o++) {
        sum += amp * vnoise3(x * freq, y * freq, z * freq);
        norm += amp; amp *= 0.5; freq *= 2;
      }
      return sum / norm;
    }

    /* Generate one chunk of voxels. Column layout (top -> bottom):
       air/water | 1 grass (sand near water) | 5 dirt (or sand) | stone | 2 bedrock.
       Trees are stamped from a 2-block margin so canopies cross chunk borders seamlessly
       (placement is a pure function of world position, so every chunk agrees).            */
    function genChunk(cx, cz) {
      const data = new Uint16Array(CX * CY * CZ);
      const H = new Int16Array(400);                           // heights incl. 2-block margin
      const DES = new Uint8Array(400);                         // desert surface flag
      const RED = new Uint8Array(400);                         // red-sand desert flag
      const ROCK = new Uint8Array(400);                        // rocky desert-hill top flag
      const SNO = new Uint8Array(400);                         // snowy (cold biome) surface flag
      const TREE = new Float32Array(400);                      // tree density factor (0 in plains/desert)
      // wider wet grid (32x32, 8-block margin) so beach width can vary per water type:
      // ocean 4..8 blocks, river/lake 2..4. WW cells: 0 dry, 1 ocean, 2 river/lake.
      const WW = new Uint8Array(1024);
      for (let gz = 0; gz < 32; gz++)
        for (let gx = 0; gx < 32; gx++) {
          const ti = terrainInfo(cx * 16 + gx - 8, cz * 16 + gz - 8);
          let ww = 0;
          if (ti.h < WATER_LEVEL) ww = (ti.rT > 0.3 || ti.lk > 0.3) ? 2 : 1;
          WW[gx + gz * 32] = ww;
          if (gx >= 6 && gx <= 25 && gz >= 6 && gz <= 25) {
            const i = (gx - 6) + (gz - 6) * 20;
            H[i] = ti.h;
            DES[i] = ti.fDesert > 0.5 ? 1 : 0;
            RED[i] = ti.fRed > 0.5 ? 1 : 0;
            ROCK[i] = (ti.dh > 0.5 && ti.fRed <= 0.5) ? 1 : 0;   // tall desert hills expose stone (not in red zones)
            SNO[i] = ti.fSnow > 0.5 ? 1 : 0;
            TREE[i] = 1 - ti.fPlains;
          }
        }

      for (let z = 0; z < CZ; z++) {
        for (let x = 0; x < CX; x++) {
          const gi = (x + 2) + (z + 2) * 20;
          const h = H[gi];
          const wx = cx * 16 + x, wz = cz * 16 + z;
          // surface material: grass/dirt on land, sand on beaches/seafloor/deserts, stone caps on
          // desert hills, clay+dirt patches on the seabed, snowy grass (+snow cap) in cold biomes
          let topB, underB, snowCap = false;
          // beach mask: for above-water columns near shore level, sand only if the nearest
          // wet column is closer than that water type's beach width. Ocean beaches vary 4..8,
          // river/lake beaches 2..4, both from a low-freq noise so widths change by region.
          let nearWater = false;
          if (h <= WATER_LEVEL + 3 && h >= WATER_LEVEL) {
            const gxw = x + 8, gzw = z + 8;
            let hitType = 0, minD2 = 9999;
            for (let dz = -8; dz <= 8; dz++)
              for (let dx = -8; dx <= 8; dx++) {
                const t = WW[(gxw + dx) + (gzw + dz) * 32];
                if (!t) continue;
                const d2 = dx * dx + dz * dz;
                if (d2 < minD2) { minD2 = d2; hitType = t; }
              }
            if (hitType) {
              const bn = (fbm(wx * 0.007 + 217.3, wz * 0.007 - 803.7, 2) + 1) * 0.5;
              const width = hitType === 1 ? 2 + bn * 2 : bn * 0.4;
              const dist  = Math.sqrt(minD2);
              const dither = fbm(wx * 0.02 + 401.3, wz * 0.02 - 193.7, 2) * 0.8;
              if (dist < width + dither) nearWater = true;
            }
          }
          if (ROCK[gi]) {
            topB = underB = B.STONE;
          } else if (h < WATER_LEVEL || (h <= WATER_LEVEL + 3 && nearWater) || DES[gi] === 1) {
            const submerged = h < WATER_LEVEL - 1;
            const clay       = submerged && fbm(wx * 0.045 - 205.1, wz * 0.045 + 733.7, 2) > 0.55;  // reduced clay
            const oceanDirt  = submerged && !clay && fbm(wx * 0.02 + 911.3, wz * 0.02 + 417.9, 2) > 0.12;  // more/larger dirt
            const oceanGravel = submerged && !clay && !oceanDirt && fbm(wx * 0.025 + 531.7, wz * 0.025 - 644.3, 2) > 0.35;
            topB = underB = clay ? B.CLAY : oceanDirt ? B.DIRT : oceanGravel ? B.GRAVEL
                          : RED[gi] ? B.RED_SAND : B.SAND;
          } else if (SNO[gi]) {
            topB = B.GRASS | (V.GRASS_SNOWY << 8);  // snowy sides; a snow block caps it below
            underB = B.DIRT; snowCap = true;
          } else {
            topB = B.GRASS; underB = B.DIRT;
          }
          data[idx(x, 0, z)] = B.BEDROCK;
          data[idx(x, 1, z)] = B.BEDROCK;
          const dirtFrom = Math.max(2, h - 5);
          for (let y = 2; y < dirtFrom; y++) data[idx(x, y, z)] = B.STONE;
          for (let y = dirtFrom; y < h; y++) data[idx(x, y, z)] = underB;
          if (h >= 2) data[idx(x, h, z)] = topB;
          if (snowCap && h + 1 <= 199) {
            // Pattern-driven snow cover:
            //  - biome edge (non-SNO neighbor): thin 1-layer carpet, keeps a crisp biome seam
            //  - steep terrain (neighbour Δh ≥ 2): thick 4-5 layer carpet, reads like a snow drift
            //  - interior: fbm patch noise decides full snow vs tapered carpet.
            //    Layer count fades 5..1 as patch rises above the full-block threshold, so cells
            //    bordering full SNOW blocks always come in at ~5 layers for a smooth blend.
            let bioEdge = false, steep = false;
            for (const [ndx, ndz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
              const ngi = (x + 2 + ndx) + (z + 2 + ndz) * 20;
              if (!SNO[ngi]) { bioEdge = true; break; }
              if (Math.abs(H[ngi] - h) >= 2) steep = true;
            }
            if (bioEdge) {
              data[idx(x, h + 1, z)] = B.SNOW_CARPET;             // variant 0 = 1 layer
            } else if (steep) {
              const thick = 4 + Math.floor(hash2(wx * 17 + 331, wz * 19 + 733) * 2);   // 4 or 5
              data[idx(x, h + 1, z)] = B.SNOW_CARPET | ((thick - 1) << 8);
            } else {
              const patch = (fbm(wx * 0.045 + 1201.7, wz * 0.045 - 903.3, 3) + 1) * 0.5;
              if (patch < 0.42) {
                data[idx(x, h + 1, z)] = B.SNOW;                  // solid snowfield
              } else {
                // taper: patch 0.42 → 5 layers (blends into neighbouring full blocks); patch 1.0 → 1 layer
                const layers = Math.min(5, Math.max(1, 5 - Math.floor((patch - 0.42) * 8)));
                data[idx(x, h + 1, z)] = B.SNOW_CARPET | ((layers - 1) << 8);
              }
            }
          }
          for (let y = h + 1; y <= WATER_LEVEL; y++) data[idx(x, y, z)] = B.WATER;
        }
      }

      /* ---- ore veins (before caves so cave walls naturally expose ore faces) ---- */
      {
        const ORE_TYPES = [
       // [oreId,   attempts, minN, maxN, bestLo, bestHi, rangeLo, rangeHi]
          [B.COAL_ORE,    20,    4,   14,     60,     90,      35,     180],
          [B.IRON_ORE,    12,    3,    9,     50,     65,      15,     130],
          [B.DIAMOND_ORE,  2,    1,    5,     15,     20,       2,      30],
          [B.COPPER_ORE,   8,    3,   10,     70,     80,      20,      85],
          [B.TIN_ORE,      6,    2,    8,     40,     45,      10,      70],
          [B.GOLD_ORE,     4,    2,    6,     20,     30,       5,      40],
          // big rock patches embedded in stone (chunky blobs, wide depth range)
          [B.MARBLE,       5, 24, 60, 50, 92,  30, 94],
          [B.GRANITE,      5, 24, 60,  6, 55,   2, 60],
          [B.LIMESTONE,    5, 24, 60, 40, 92,  20, 94],
        ];
        for (let oi = 0; oi < ORE_TYPES.length; oi++) {
          const [oreId, attempts, minN, maxN, bestLo, bestHi, rangeLo, rangeHi] = ORE_TYPES[oi];
          for (let ai = 0; ai < attempts; ai++) {
            const lx = (hash3(cx * 47 + oi + ai,       11, cz * 43 + oi + ai    ) * 16) | 0;
            const lz = (hash3(cx * 53 + oi + ai * 3,   17, cz * 59 + oi + ai    ) * 16) | 0;
            const inBest = hash3(cx + oi * 7 + ai * 3, 31, cz + oi * 3 + ai * 7) < 0.7;
            const ly = inBest
              ? bestLo  + ((hash3(cx * 13 + ai + oi, 41, cz * 11 + ai) * (bestHi  - bestLo  + 1)) | 0)
              : rangeLo + ((hash3(cx * 19 + ai + oi, 37, cz * 17 + ai) * (rangeHi - rangeLo + 1)) | 0);
            if (ly < rangeLo || ly > rangeHi || ly < 2 || ly > 198) continue;
            if ((data[idx(lx, ly, lz)] & 255) !== B.STONE) continue;
            const count = minN + ((hash3(cx + ai, ly + oi, cz + ai) * (maxN - minN + 1)) | 0);
            // LCG seeded from position for deterministic vein shape
            let lcg = (Math.imul(cx * 37 + lx + oi * 13, 374761393) ^ Math.imul(ly * 7 + ai, 668265263) ^ (cz * 41 + lz)) | 0;
            const nlcg = () => { lcg = Math.imul(lcg, 1664525) + 1013904223 | 0; return (lcg >>> 0) / 4294967296; };
            const front = [[lx, ly, lz]];
            let placed = 0;
            while (front.length && placed < count) {
              const fi = (nlcg() * front.length) | 0;
              const [bx, by, bz] = front.splice(fi, 1)[0];
              if (bx < 0 || bx > 15 || bz < 0 || bz > 15 || by < 2 || by > 198) continue;
              if ((data[idx(bx, by, bz)] & 255) !== B.STONE) continue;
              data[idx(bx, by, bz)] = oreId;
              placed++;
              front.push([bx+1,by,bz],[bx-1,by,bz],[bx,by+1,bz],[bx,by-1,bz],[bx,by,bz+1],[bx,by,bz-1]);
            }
          }
        }
      }

      /* ---- gravel patches: mountain slopes and underground cave floors ---- */
      {
        // mountain surface patches — near surface of tall columns
        for (let ai = 0; ai < 9; ai++) {
          const lx = (hash3(cx * 47 + 500 + ai,       7, cz * 43 + 500 + ai    ) * 16) | 0;
          const lz = (hash3(cx * 53 + 500 + ai * 3,  13, cz * 59 + 500 + ai    ) * 16) | 0;
          const gi = (lx + 2) + (lz + 2) * 20;
          if (H[gi] <= 82) continue;                             // only in mountain columns
          const ly = H[gi] - 4 - ((hash3(cx + 500 + ai, 29, cz + 500 + ai) * 16) | 0);
          if (ly < 2 || ly > 198) continue;
          if ((data[idx(lx, ly, lz)] & 255) !== B.STONE) continue;
          const count = 20 + ((hash3(cx + ai + 500, ly, cz + ai + 500) * 30) | 0);
          let lcg = (Math.imul(cx * 37 + lx + 500, 374761393) ^ Math.imul(ly * 7 + ai, 668265263) ^ (cz * 41 + lz)) | 0;
          const nlcg = () => { lcg = Math.imul(lcg, 1664525) + 1013904223 | 0; return (lcg >>> 0) / 4294967296; };
          const front = [[lx, ly, lz]];
          let placed = 0;
          while (front.length && placed < count) {
            const fi = (nlcg() * front.length) | 0;
            const [bx, by, bz] = front.splice(fi, 1)[0];
            if (bx < 0 || bx > 15 || bz < 0 || bz > 15 || by < 2 || by > 198) continue;
            if ((data[idx(bx, by, bz)] & 255) !== B.STONE) continue;
            data[idx(bx, by, bz)] = B.GRAVEL;
            placed++;
            front.push([bx+1,by,bz],[bx-1,by,bz],[bx,by+1,bz],[bx,by-1,bz],[bx,by,bz+1],[bx,by,bz-1]);
          }
        }
        // underground patches — scattered through caves / mid-depth stone
        for (let ai = 0; ai < 8; ai++) {
          const lx = (hash3(cx * 47 + 600 + ai,       11, cz * 43 + 600 + ai    ) * 16) | 0;
          const lz = (hash3(cx * 53 + 600 + ai * 3,   17, cz * 59 + 600 + ai    ) * 16) | 0;
          const ly = 12 + ((hash3(cx + 600 + ai, 23, cz + 600 + ai) * 48) | 0);
          if (ly < 2 || ly > 198) continue;
          if ((data[idx(lx, ly, lz)] & 255) !== B.STONE) continue;
          const count = 10 + ((hash3(cx + ai + 600, ly, cz + ai + 600) * 20) | 0);
          let lcg = (Math.imul(cx * 37 + lx + 600, 374761393) ^ Math.imul(ly * 7 + ai, 668265263) ^ (cz * 41 + lz)) | 0;
          const nlcg = () => { lcg = Math.imul(lcg, 1664525) + 1013904223 | 0; return (lcg >>> 0) / 4294967296; };
          const front = [[lx, ly, lz]];
          let placed = 0;
          while (front.length && placed < count) {
            const fi = (nlcg() * front.length) | 0;
            const [bx, by, bz] = front.splice(fi, 1)[0];
            if (bx < 0 || bx > 15 || bz < 0 || bz > 15 || by < 2 || by > 198) continue;
            if ((data[idx(bx, by, bz)] & 255) !== B.STONE) continue;
            data[idx(bx, by, bz)] = B.GRAVEL;
            placed++;
            front.push([bx+1,by,bz],[bx-1,by,bz],[bx,by+1,bz],[bx,by-1,bz],[bx,by,bz+1],[bx,by,bz-1]);
          }
        }
        // general-biome surface patches — small, all elevated terrain h > 65
        for (let ai = 0; ai < 6; ai++) {
          const lx = (hash3(cx * 47 + 700 + ai,       31, cz * 43 + 700 + ai    ) * 16) | 0;
          const lz = (hash3(cx * 53 + 700 + ai * 3,   37, cz * 59 + 700 + ai    ) * 16) | 0;
          const gi = (lx + 2) + (lz + 2) * 20;
          if (H[gi] <= 65) continue;                             // only above beach level
          const ly = H[gi] - 3 - ((hash3(cx + 700 + ai, 43, cz + 700 + ai) * 10) | 0);
          if (ly < 2 || ly > 198) continue;
          if ((data[idx(lx, ly, lz)] & 255) !== B.STONE) continue;
          const count = 5 + ((hash3(cx + ai + 700, ly, cz + ai + 700) * 12) | 0);
          let lcg = (Math.imul(cx * 37 + lx + 700, 374761393) ^ Math.imul(ly * 7 + ai, 668265263) ^ (cz * 41 + lz)) | 0;
          const nlcg = () => { lcg = Math.imul(lcg, 1664525) + 1013904223 | 0; return (lcg >>> 0) / 4294967296; };
          const front = [[lx, ly, lz]];
          let placed = 0;
          while (front.length && placed < count) {
            const fi = (nlcg() * front.length) | 0;
            const [bx, by, bz] = front.splice(fi, 1)[0];
            if (bx < 0 || bx > 15 || bz < 0 || bz > 15 || by < 2 || by > 198) continue;
            if ((data[idx(bx, by, bz)] & 255) !== B.STONE) continue;
            data[idx(bx, by, bz)] = B.GRAVEL;
            placed++;
            front.push([bx+1,by,bz],[bx-1,by,bz],[bx,by+1,bz],[bx,by-1,bz],[bx,by,bz+1],[bx,by,bz-1]);
          }
        }
      }

      /* ---- caves: two 3D-noise bands intersect into winding tunnels ("spaghetti"), plus
         large low-altitude "cheese" caverns. A solid crust stays under the surface (6 land /
         9 underwater) so caves only reach daylight through the entrance shafts below. */
      for (let z = 0; z < CZ; z++)
        for (let x = 0; x < CX; x++) {
          const gi = (x + 2) + (z + 2) * 20;
          const h = H[gi];
          const wx = cx * 16 + x, wz = cz * 16 + z;
          const capY = h - (h < WATER_LEVEL ? 9 : 6);
          // long-tunnel region gate (2D, per-column): ~40% of areas also grow long sweeping
          // tunnels from a separate LOW-frequency band pair (long wavelength = long tunnels)
          const longTun = fbm(wx * 0.003 + 4040, wz * 0.003 - 2020, 2) > 0.12;
          for (let y = 3; y <= capY; y++) {
            // taper the band shut approaching the crust so noise never breaches the surface
            const taper = Math.min(1, (capY - y) * 0.25 + 0.4);
            // boost band width inside tall mountains so interiors are more cavernous
            const w = (0.062 + (1 - y / 96) * 0.02 + Math.max(0, h - 90) * 0.00045) * taper;
            const n1 = fbm3(wx * 0.055, y * 0.075, wz * 0.055, 2);
            if (Math.abs(n1) <= w) {                          // spaghetti band
              const n2 = fbm3(wx * 0.055 + 133.7, y * 0.075 - 71.3, wz * 0.055 + 291.1, 2);
              if (Math.abs(n2) <= w) { data[idx(x, y, z)] = B.AIR; continue; }
            }
            if (!longTun) continue;                           // long tunnels only in gated regions
            const lw = w * 0.85;                              // a touch narrower so they read as tunnels
            const t1 = fbm3(wx * 0.018 + 512, y * 0.05 - 88, wz * 0.018 + 707, 2);
            if (Math.abs(t1) > lw) continue;                  // early out before the 2nd band
            const t2 = fbm3(wx * 0.018 - 333, y * 0.05 + 219, wz * 0.018 - 141, 2);
            if (Math.abs(t2) <= lw) data[idx(x, y, z)] = B.AIR;
          }
          // cheese caverns deep down (big rooms, stone only). Some regions widen into GRAND
          // caverns — taller, lower carve threshold — held up by full stone pillars and
          // floor/ceiling rock spikes (per-column hash keeps them chunk-border stable).
          const grand = fbm(wx * 0.006 + 777, wz * 0.006 + 321, 2) > 0.30;
          const thr = grand ? 0.40 : 0.47;
          const pr = hash2(wx * 13 + 5, wz * 29 - 11);
          const isPillar = grand && pr < 0.012;                          // full floor-to-ceiling pillar
          const stalag = grand && !isPillar && pr < 0.055 ? 4 + ((pr * 4096 | 0) % 7) : 0;   // floor spike
          const stalac = grand && !isPillar && pr >= 0.055 && pr < 0.095 ? 4 + ((pr * 8192 | 0) % 7) : 0; // ceiling spike
          const yMaxC = Math.min(grand ? 42 : 34, capY);
          for (let y = 5; y <= yMaxC; y++) {
            const i = idx(x, y, z);
            if ((data[i] & 255) !== B.STONE) continue;
            if (isPillar) continue;
            if (stalag && y < 5 + stalag) continue;
            if (stalac && y > yMaxC - stalac) continue;
            if (fbm3(wx * 0.02, y * 0.03, wz * 0.02, 2) > thr) data[i] = B.AIR;
          }
        }

      /* ---- cave entrances: one dice roll per 16-block cell; a winding shaft bores from the
         surface down into cave depth. Land: 5% of cells (14% in mountains), r~2.4 with a
         flared mouth. Underwater: 0.5% and a tighter r~1.5. Pure function of world position.
         Shafts travel ~1.5 blocks horizontally per block of descent so entrances slope gently
         rather than plunging straight down. */
      const EMARGIN = 28;
      for (let ecz = Math.floor((cz * 16 - EMARGIN) / 16); ecz <= Math.floor((cz * 16 + 15 + EMARGIN) / 16); ecz++)
        for (let ecx = Math.floor((cx * 16 - EMARGIN) / 16); ecx <= Math.floor((cx * 16 + 15 + EMARGIN) / 16); ecx++) {
          const roll = hash2(ecx * 913 + 71, ecz * 641 - 233);
          const jx = ecx * 16 + 3 + (((roll * 4241) | 0) % 10);   // jittered start inside the cell
          const jz = ecz * 16 + 3 + (((roll * 6553) | 0) % 10);
          const ti = terrainInfo(jx, jz);
          const under = ti.h < WATER_LEVEL;                       // column has water above it
          const isMtn = !under && ti.h > 126;
          const landChance = isMtn ? 0.14 : 0.05;
          if (roll > (under ? 0.005 : landChance)) continue;
          const depth = 14 + (((roll * 88007) | 0) % 12) + (isMtn ? 6 : 0);
          const targetY = Math.max(8, ti.h - depth);
          let px = jx + 0.5, pz = jz + 0.5;
          let ang = hash2(ecx * 57 + 991, ecz * 83 - 447) * Math.PI * 2;
          // entrance style: 0 gentle winding slope · 1 plain vertical hole · 2 steep drop ·
          // 3 grand flared mouth · 4 grotto (hemispherical room, then a slope out its floor) ·
          // 5 long near-level tunnel that ends in a steep drop
          const style = ((roll * 7919) | 0) % 6;
          const clearCell = (gx, gy, gz) => {                    // shared carve helper (local coords)
            const lx = gx - cx * 16, lz = gz - cz * 16;
            if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || gy < 3 || gy > 199) return;
            const ii = idx(lx, gy, lz), bid = data[ii] & 255;
            if (bid !== B.WATER && bid !== B.BEDROCK) data[ii] = B.AIR;
          };
          let startY = ti.h + 1;
          if (style === 4 && !under) {                           // grotto: dome carved into the surface
            const R = 4 + (((roll * 331) | 0) % 2);
            for (let dy = 0; dy <= R; dy++)
              for (let oz = -R; oz <= R; oz++)
                for (let ox = -R; ox <= R; ox++) {
                  if (ox * ox + oz * oz + dy * dy * 2 > R * R) continue;
                  clearCell(Math.round(px) + ox, ti.h + 1 - dy, Math.round(pz) + oz);
                }
            startY = ti.h + 1 - R;                               // shaft leaves through the grotto floor
          }
          if (style === 5 && !under) {                           // long gently-declining tunnel first
            const L = 8 + (((roll * 557) | 0) % 8);
            for (let s2 = 0; s2 < L; s2++) {
              px += Math.cos(ang) * 1.0; pz += Math.sin(ang) * 1.0;
              ang += (hash2(jx * 19 + s2, jz * 23 - s2) - 0.5) * 0.3;
              const yy0 = ti.h - 1 - (s2 >> 2);
              const cxi = Math.round(px), czi = Math.round(pz);
              for (let oz = -2; oz <= 2; oz++)
                for (let ox = -2; ox <= 2; ox++) {
                  if (ox * ox + oz * oz > 3.2) continue;
                  clearCell(cxi + ox, yy0, czi + oz);
                  clearCell(cxi + ox, yy0 - 1, czi + oz);
                }
              startY = yy0 - 1;                                  // steep drop starts at tunnel end
            }
          }
          const horiz = style === 1 ? 0 : (style === 2 || style === 5) ? 0.5 : 1.5;
          const flare = style === 3 ? 2.6 : 1.1;
          const rBase = (under ? 1.5 : (isMtn ? 2.8 : 2.4)) * (style === 1 ? 0.9 : 1);
          for (let y = startY; y >= targetY; y--) {
            const t = startY - y;                                 // steps below the entry point
            ang += (hash2(jx * 31 + t, jz * 17 - t) - 0.5) * 0.55; // gentle wobble for gradual slope
            px += Math.cos(ang) * horiz;
            pz += Math.sin(ang) * horiz;
            const flaring = style <= 3 && t < (style === 3 ? 4 : 2) && !under;
            const r = rBase + (flaring ? flare * Math.max(0.3, 1 - t * 0.25) : 0) - Math.min(0.8, t * 0.04);
            const cxi = Math.round(px), czi = Math.round(pz), ri = Math.ceil(r);
            for (let oz = -ri; oz <= ri; oz++)
              for (let ox = -ri; ox <= ri; ox++) {
                if (ox * ox + oz * oz > r * r) continue;
                const lx = cxi + ox - cx * 16, lz = czi + oz - cz * 16;
                if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
                for (let dy = 0; dy >= -1; dy--) {                // 2-tall passage
                  const yy = y + dy;
                  if (yy < 3 || yy > 199) continue;
                  const ii = idx(lx, yy, lz);
                  const bid = data[ii] & 255;
                  if (bid !== B.WATER && bid !== B.BEDROCK) data[ii] = B.AIR;
                }
              }
          }
        }

      // ---- cave lava pools (pool-seeded grid, bowl-shaped multi-y crater) ----
      // 22×22 cells, 22% chance each, radius up to ~6 blocks. Per-cell pool y is deterministic;
      // each column within radius carves a lava column from (poolY - bowlDepth) up to poolY, with
      // bowlDepth tapering parabolically from ~4 at the centre to 0 at the rim → looks like a
      // real crater/pond, not a flat slab. Rim pass fills air side-neighbors with stone.
      {
        const PCELL = 22, PR = 6, PR2 = PR * PR;
        for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) {
          const wx = cx * 16 + x, wz = cz * 16 + z;
          const gcx = Math.round(wx / PCELL), gcz = Math.round(wz / PCELL);
          const ddx = wx - gcx * PCELL, ddz = wz - gcz * PCELL;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > PR2) continue;
          if (hash2(gcx * 31 + 5501, gcz * 37 + 6601) > 0.08) continue;
          const poolY = 5 + Math.floor(hash2(gcx * 71 + 2201, gcz * 73 + 3301) * 40);   // 5..44
          // parabolic bowl: deeper in middle, 0 at edge
          const t = 1 - d2 / PR2;
          const bowlDepth = Math.max(0, Math.floor(4 * t * t));
          const y0 = poolY - bowlDepth, y1 = poolY;
          for (let y = y0; y <= y1; y++) {
            const cur = data[idx(x, y, z)] & 255;
            if (cur === B.AIR || cur === B.STONE) data[idx(x, y, z)] = B.LAVA;
          }
        }
        // rim: side-neighbours of any lava cell that are air become stone (dam flow)
        for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) for (let y = 3; y < 48; y++) {
          if ((data[idx(x, y, z)] & 255) !== B.LAVA) continue;
          for (const [ndx, ndz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = x + ndx, nz = z + ndz;
            if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
            if ((data[idx(nx, y, nz)] & 255) === B.AIR) data[idx(nx, y, nz)] = B.STONE;
          }
        }
      }

      // ---- surface lava ponds (crater-shape, biome-biased, cross-chunk consistent) ----
      // Uses terrainInfo(wx,wz) — a pure noise function — for every decision (rim y, biome bias,
      // flatness, water proximity), so any chunk overlapping a pool computes IDENTICAL results.
      // No dependence on the local chunk's H array or data grid → no seams, no floating lava.
      // Chances reduced 90% from 0.582; hill/mountain terrain rejected via rim y cap + flatness.
      {
        const PCELL = 40, PR = 6, PR2 = PR * PR;
        // deterministic per-pool center info, cached
        const centerCache = new Map();
        const centerInfo = (gcx, gcz) => {
          const k = gcx + ',' + gcz;
          if (centerCache.has(k)) return centerCache.get(k);
          const ti = terrainInfo(gcx * PCELL, gcz * PCELL);
          centerCache.set(k, ti);
          return ti;
        };
        // flatness + water-clearance check at pool center. Samples 4 rim points and 4 diagonals.
        const poolOkCache = new Map();
        const poolOk = (gcx, gcz, rimY) => {
          const k = gcx + ',' + gcz;
          if (poolOkCache.has(k)) return poolOkCache.get(k);
          let ok = true;
          const OFF = [[PR,0],[-PR,0],[0,PR],[0,-PR],[PR,PR],[-PR,-PR],[PR,-PR],[-PR,PR]];
          for (const [dx, dz] of OFF) {
            const ti = terrainInfo(gcx * PCELL + dx, gcz * PCELL + dz);
            if (Math.abs(ti.h - rimY) > 3) { ok = false; break; }        // hilly / mountainous
            if (ti.h <= WATER_LEVEL + 3) { ok = false; break; }          // beach / ocean nearby
          }
          poolOkCache.set(k, ok);
          return ok;
        };
        for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) {
          const wx = cx * 16 + x, wz = cz * 16 + z;
          const gcx = Math.round(wx / PCELL), gcz = Math.round(wz / PCELL);
          const ddx = wx - gcx * PCELL, ddz = wz - gcz * PCELL;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > PR2) continue;
          const ci = centerInfo(gcx, gcz);
          const isDesertC = ci.fDesert > 0.5, isSnowC = ci.fSnow > 0.5;
          const chance = isSnowC ? 0.0002 : isDesertC ? 0.01 : 0.002;
          if (hash2(gcx * 41 + 7001, gcz * 43 + 7101) > chance) continue;
          const rimY = ci.h;
          if (rimY <= WATER_LEVEL + 3) continue;                         // no ocean/beach altitude
          if (rimY > 110) continue;                                      // no hills/mountains
          if (!poolOk(gcx, gcz, rimY)) continue;                         // reject if not flat / near water
          const t = 1 - d2 / PR2;
          const bowlDepth = Math.max(0, Math.floor(3 * t * t));
          const y0 = rimY - bowlDepth, y1 = rimY;
          for (let y = y0; y <= y1; y++) {
            if (y < 2 || y > 199) continue;
            const cur = data[idx(x, y, z)] & 255;
            if (cur !== B.WATER && cur !== B.BEDROCK) data[idx(x, y, z)] = B.LAVA;
          }
          if (rimY + 1 <= 199) {
            const above = data[idx(x, rimY + 1, z)] & 255;
            if (above !== B.WATER && above !== B.AIR) data[idx(x, rimY + 1, z)] = B.AIR;
          }
        }
        // rim: any side-neighbour of a lava cell that is air, grass, sand, red sand or dirt gets
        // replaced with stone — pool never touches grass or sand.
        const rimReplace = new Set([B.AIR, B.GRASS, B.SAND, B.RED_SAND, B.DIRT]);
        for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) for (let y = 60; y < 199; y++) {
          if ((data[idx(x, y, z)] & 255) !== B.LAVA) continue;
          for (const [ndx, ndz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = x + ndx, nz = z + ndz;
            if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
            const nb = data[idx(nx, y, nz)] & 255;
            if (rimReplace.has(nb)) data[idx(nx, y, nz)] = B.STONE;
          }
          // also convert the block directly ABOVE the pool's top rim if it's grass/sand (looks weird
          // touching lava). Only for the top-most lava cell of each column.
          if ((data[idx(x, y + 1, z)] & 255) === B.AIR || (data[idx(x, y + 1, z)] & 255) === B.WATER) {
            // this y is the surface: convert diagonal-top grass/sand within-chunk to stone
            for (const [ndx, ndz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
              const nx = x + ndx, nz = z + ndz;
              if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
              const above = data[idx(nx, y + 1, nz)] & 255;
              if (above === B.GRASS || above === B.SAND || above === B.RED_SAND)
                data[idx(nx, y + 1, nz)] = B.STONE;
            }
          }
        }
      }

      // ---- sulfur deposits ----
      // Two spawn modes:
      //   (a) under lava: 5-10 blocks below any lava cell, replace stone with a small cluster,
      //       tips (up on top of a block below air, down on ceiling above air) spawn frequently.
      //   (b) random single blocks: 0.05% per stone cell in y=30..80, peak density around y=48..50.
      //       Rare occasional tip on top/bottom.
      {
        // Sulfur block spawn rules:
        //   * must sit in stone
        //   * must have AIR directly above or below (cave-visible)
        //   * no lava or water in any of 6 neighbors (never touches liquids)
        // After the block is placed, try to grow a tip into the adjacent air on the exposed face.
        const inBounds = (nx, ny, nz) =>
          nx >= 0 && nx <= 15 && nz >= 0 && nz <= 15 && ny >= 0 && ny <= 199;
        const idAt = (nx, ny, nz) => inBounds(nx, ny, nz) ? (data[idx(nx, ny, nz)] & 255) : -1;
        const placeSulfur = (bx, by, bz, tipHash) => {
          if (bx < 0 || bx > 15 || bz < 0 || bz > 15 || by < 2 || by > 197) return;
          if ((data[idx(bx, by, bz)] & 255) !== B.STONE) return;
          const airTop = idAt(bx, by + 1, bz) === B.AIR;
          const airBot = idAt(bx, by - 1, bz) === B.AIR;
          if (!airTop && !airBot) return;                        // must be cave-exposed via top or bottom
          // reject if any neighbor is lava or water
          const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
          for (const [dx, dy, dz] of DIRS) {
            const nb = idAt(bx + dx, by + dy, bz + dz);
            if (nb === B.LAVA || nb === B.WATER) return;
          }
          data[idx(bx, by, bz)] = B.SULFUR_BLOCK;
          // try to grow a tip on each exposed face (50% chance each). tipHash provides variety.
          if (airTop && (tipHash === undefined || tipHash < 0.5))
            data[idx(bx, by + 1, bz)] = B.SULFUR_UP_TIP;
          if (airBot && (tipHash === undefined || tipHash >= 0.5))
            data[idx(bx, by - 1, bz)] = B.SULFUR_UP_TIP | (1 << 8);   // variant 1 = down orientation
        };
        // (a) under-lava clusters
        for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) {
          for (let y = 3; y < 190; y++) {
            if ((data[idx(x, y, z)] & 255) !== B.LAVA) continue;
            const wx = cx * 16 + x, wz = cz * 16 + z;
            const depth = 2 + Math.floor(hash3(wx * 29 + 12001, y * 7 + 3, wz * 31 + 12001) * 9);   // 2..10
            const cy = y - depth;
            if (cy < 3) continue;
            const clusterN = 3 + Math.floor(hash3(wx * 41 + 13001, y * 11 + 5, wz * 37 + 13001) * 4);
            for (let k = 0; k < clusterN; k++) {
              const ox = Math.floor(hash3(wx * 53 + k, cy + 7 * k, wz * 47 + k * 3) * 3) - 1;
              const oy = Math.floor(hash3(wx * 61 + k * 5, cy * 3 + k, wz * 59 + k) * 3) - 1;
              const oz = Math.floor(hash3(wx * 67 + k * 7, cy + k * 11, wz * 71 + k * 5) * 3) - 1;
              const tipH = hash3(wx * 79 + k, cy + k * 13, wz * 83 + k * 5);
              placeSulfur(x + ox, cy + oy, z + oz, tipH);
            }
            break;   // one cluster per column max
          }
        }
        // (b) rare single blocks y=30..80, peak 48..50
        for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) {
          const wx = cx * 16 + x, wz = cz * 16 + z;
          for (let y = 30; y <= 80; y++) {
            if ((data[idx(x, y, z)] & 255) !== B.STONE) continue;
            const d = (y - 49) / 10;
            const weight = Math.exp(-d * d);
            const chance = 0.0005 * (0.3 + 0.7 * weight);
            if (hash3(wx * 89 + 14001, y * 19 + 7, wz * 97 + 14001) < chance) {
              const tipH = hash3(wx * 103, y * 23, wz * 107);
              placeSulfur(x, y, z, tipH);
            }
          }
        }
      }

      // trees — evaluated over the margin so neighbours get the overlapping leaves
      const put = (x, y, z, id, force) => {
        if (x < 0 || x > 15 || z < 0 || z > 15 || y < 2 || y > 199) return;
        const i = idx(x, y, z);
        if (force || data[i] === B.AIR) data[i] = id;
      };
      // At most one tree per 5x5 world-grid cell, at a hash-jittered position 1..3 inside the
      // cell — trunks are therefore always >=3 blocks apart (no touching twin trees), while
      // remaining a pure function of world position so chunk borders agree.
      // widened margin (-8..+23) so wider big-tree branches from neighbouring cells reach into this chunk
      const minX = cx * 16 - 8, maxX = cx * 16 + 23, minZ = cz * 16 - 8, maxZ = cz * 16 + 23;
      for (let gcz = Math.floor(minZ / 5); gcz <= Math.floor(maxZ / 5); gcz++) {
        for (let gcx = Math.floor(minX / 5); gcx <= Math.floor(maxX / 5); gcx++) {
          const r = hash2(gcx, gcz);                           // the cell's dice roll
          const wx = gcx * 5 + 1 + (((r * 977) | 0) % 3);      // jittered trunk position
          const wz = gcz * 5 + 1 + (((r * 7919) | 0) % 3);
          if (wx < minX || wx > maxX || wz < minZ || wz > maxZ) continue;
          const tx = wx - cx * 16, tz = wz - cz * 16;
          // sample biome/height at the actual trunk world position — the H/TREE/DES arrays
          // only cover chunk+2 margin, but our widened tree loop reaches further.
          const ti = terrainInfo(wx, wz);
          const h = ti.h;
          if (h <= WATER_LEVEL + 1 || h > 146 || ti.fDesert > 0.5) continue;
          // no trees on or hanging over canyon lines — conservative buffer covering every canyon
          // type (crack/wide/long) so canopies always clear the rim
          if (fbm(wx * 0.0015 + 555, wz * 0.0015 - 333, 2) > 0.28 &&
              (Math.abs(fbm(wx * 0.008 + 911, wz * 0.008 - 477, 2)) < 0.15 ||
               Math.abs(fbm(wx * 0.0035 + 911, wz * 0.011 - 477, 2)) < 0.10 ||
               Math.abs(fbm(wx * 0.011 + 911, wz * 0.0035 - 477, 2)) < 0.10)) continue;
          const isPlains = ti.fPlains > 0.5;
          // snow: trees only inside the Snow Forest sub-biome mask; plain Snow stays treeless
          const isSnow = ti.fSnow > 0.5;
          if (isSnow && fbm(wx * 0.004 + 2222, wz * 0.004 + 888, 2) <= 0.25) continue;
          const forestNoise = fbm(wx * 0.01 + 700, wz * 0.01 - 300, 2) > 0.12;
          const treeF = 1 - ti.fPlains;
          // birch: dedicated "Birch Forest" regions (dense) + 1% scattered birches in ordinary
          // forests. Never in snow biomes, never the big/mega form.
          const birchRegion = !isPlains && !isSnow && fbm(wx * 0.004 + 1234, wz * 0.004 - 987, 2) > 0.35;
          const isBirch = birchRegion || (!isPlains && !isSnow && hash2(gcx * 211 + 5, gcz * 197 + 3) < 0.01);
          // plains/meadow: flat 0.1% chance. forest/other: original density-scaled odds. birch forest: dense.
          let baseProb = isPlains ? 0.001 : (forestNoise ? 0.55 : 0.08) * treeF;
          if (birchRegion) baseProb = Math.max(baseProb, 0.5);
          if (r > baseProb) continue;
          // flatness check
          let clear = true;
          for (let oz = -2; oz <= 2 && clear; oz++)
            for (let ox = -2; ox <= 2; ox++)
              if (heightAt(wx + ox, wz + oz) > h + 2) { clear = false; break; }
          if (!clear) continue;
          // big-tree roll (independent hash). plains: 50% of the 1%. others: ~3%.
          const rBig = hash2(gcx * 131 + 7, gcz * 173 + 19);
          const bigProb = isPlains ? 0.3 : 0.03;
          const isBig = rBig < bigProb && !isBirch;      // birch never grows the big form

          if (isBig) {
            // procedural big tree: tall trunk, 3-5 branches with leaf clusters, wide top canopy
            const trunkH = 9 + ((r * 1e6) | 0) % 4;            // 9..12
            put(tx, h, tz, B.DIRT, true);
            for (let y = h + 1; y <= h + trunkH; y++) put(tx, y, tz, B.LOG, true);
            // top canopy: 7x7 base spanning 3 layers, then 5x5, 3x3, tip
            for (let ly = h + trunkH - 2; ly <= h + trunkH + 1; ly++)
              for (let oz = -3; oz <= 3; oz++)
                for (let ox = -3; ox <= 3; ox++) {
                  const rad2 = ox * ox + oz * oz;
                  if (rad2 > 10) continue;                   // rounded footprint
                  if (rad2 >= 8 && hash2(wx + ox * 31, wz + oz * 17 + ly) < 0.55) continue;
                  put(tx + ox, ly, tz + oz, B.LEAVES, false);
                }
            const cap = h + trunkH + 2;
            for (let oz = -2; oz <= 2; oz++)
              for (let ox = -2; ox <= 2; ox++) {
                const rad2 = ox * ox + oz * oz;
                if (rad2 > 5) continue;
                if (rad2 >= 4 && hash2(wx + ox * 61, wz + oz * 41 + cap) < 0.55) continue;
                put(tx + ox, cap, tz + oz, B.LEAVES, false);
              }
            for (let oz = -1; oz <= 1; oz++)
              for (let ox = -1; ox <= 1; ox++)
                if (Math.abs(ox) + Math.abs(oz) < 2) put(tx + ox, cap + 1, tz + oz, B.LEAVES, false);
            put(tx, cap + 2, tz, B.LEAVES, false);
            // 5..8 branches, angled outward from mid-upper trunk with fatter leaf blobs
            const nBranches = 5 + ((r * 991) | 0) % 4;
            for (let b = 0; b < nBranches; b++) {
              const bh = h + Math.floor(trunkH * 0.45) + Math.floor(b * 0.8);
              const angle = hash2(wx + b * 53, wz + b * 89) * Math.PI * 2;
              const dx = Math.cos(angle), dz = Math.sin(angle);
              const len = 4 + ((r * (23 + b * 7)) | 0) % 2;  // 4..5
              // branch logs lie along their dominant horizontal axis (variant 1 = X, 2 = Z)
              const branchVar = Math.abs(dx) >= Math.abs(dz) ? 1 : 2;
              let bx = 0, bz2 = 0, by = bh;
              for (let s = 1; s <= len; s++) {
                bx = Math.round(dx * s);
                bz2 = Math.round(dz * s);
                by = bh + Math.floor(s * 0.45);
                put(tx + bx, by, tz + bz2, B.LOG | (branchVar << 8), true);
              }
              // wider leaf blob at branch tip (radius ~2) + a smaller blob mid-branch
              for (let ly = -2; ly <= 2; ly++)
                for (let oz = -2; oz <= 2; oz++)
                  for (let ox = -2; ox <= 2; ox++) {
                    const d = Math.abs(ox) + Math.abs(oz) + Math.abs(ly);
                    if (d > 4) continue;
                    if (d === 4 && hash2(wx + ox * 71 + b, wz + oz * 83 + ly) < 0.5) continue;
                    put(tx + bx + ox, by + ly + 1, tz + bz2 + oz, B.LEAVES, false);
                  }
              // mid-branch leaf tuft (halfway along the branch)
              const midS = Math.max(1, Math.floor(len * 0.55));
              const mx = Math.round(dx * midS), mz2 = Math.round(dz * midS);
              const my = bh + Math.floor(midS * 0.45);
              for (let ly = -1; ly <= 1; ly++)
                for (let oz = -1; oz <= 1; oz++)
                  for (let ox = -1; ox <= 1; ox++)
                    if (Math.abs(ox) + Math.abs(oz) + Math.abs(ly) < 3)
                      put(tx + mx + ox, my + ly + 1, tz + mz2 + oz, B.LEAVES, false);
            }
            continue;
          }

          // small tree (also used for all birches). birch trunks are taller (5..10).
          const LOG = isBirch ? B.BIRCH_LOG : B.LOG, LEAF = isBirch ? B.BIRCH_LEAVES : B.LEAVES;
          const th = isBirch ? 5 + ((r * 1e6) | 0) % 6           // birch 5..10
                             : 4 + ((r * 1e6) | 0) % 3;          // oak   4..6
          put(tx, h, tz, B.DIRT, true);
          for (let y = h + 1; y <= h + th; y++) put(tx, y, tz, LOG, true);
          for (let ly = h + th - 1; ly <= h + th; ly++)        // 5x5 canopy, ragged corners
            for (let oz = -2; oz <= 2; oz++)
              for (let ox = -2; ox <= 2; ox++) {
                if (ox === 0 && oz === 0) continue;
                if (Math.abs(ox) === 2 && Math.abs(oz) === 2 && hash2(wx + ox * 31, wz + oz * 17 + ly) < 0.5) continue;
                put(tx + ox, ly, tz + oz, LEAF, false);
              }
          const cap = h + th + 1;                              // 3x3 cap without corners
          for (let oz = -1; oz <= 1; oz++)
            for (let ox = -1; ox <= 1; ox++)
              if (Math.abs(ox) + Math.abs(oz) < 2) put(tx + ox, cap, tz + oz, LEAF, false);
          put(tx, cap + 1, tz, LEAF, false);                   // tip
        }
      }

      /* ---- red mushrooms: cave floors + shadowed ground under leaves ---- */
      for (let z = 0; z < CZ; z++) {
        for (let x = 0; x < CX; x++) {
          const gi = (x + 2) + (z + 2) * 20;
          const h = H[gi];
          // cave floors: stone floor with air directly above, below surface crust
          const caveTop = Math.min(h - 4, 94);
          for (let y = 3; y < caveTop; y++) {
            if ((data[idx(x, y, z)] & 255) === B.STONE &&
                (data[idx(x, y + 1, z)] & 255) === B.AIR &&
                hash3(cx * 1171 + x, y + 3000, cz * 937 + z) < 0.002)
              data[idx(x, y + 1, z)] = hash3(cx * 1171 + x, y + 4000, cz * 937 + z) < 0.5
                ? B.RED_MUSHROOM : B.BROWN_MUSHROOM;
          }
          // surface under leaves: air at h+1 with leaves within 2..5 blocks above
          if (h > WATER_LEVEL && h < 120) {
            const topBk = data[idx(x, h, z)] & 255;
            if ((topBk === B.GRASS || topBk === B.DIRT) &&
                (data[idx(x, h + 1, z)] & 255) === B.AIR) {
              let hasLeaves = false;
              for (let dy = 2; dy <= 5 && h + dy < 200; dy++) {
                if ((data[idx(x, h + dy, z)] & 255) === B.LEAVES) { hasLeaves = true; break; }
              }
              if (hasLeaves && hash3(cx * 1279 + x, h + 5000, cz * 1031 + z) < 0.0007)
                data[idx(x, h + 1, z)] = hash3(cx * 1279 + x, h + 6000, cz * 1031 + z) < 0.5
                  ? B.RED_MUSHROOM : B.BROWN_MUSHROOM;
            }
          }
        }
      }

      /* ---- melons: grass surfaces in forest/plains. Plains: 1.5% per attempt, up to 5 in a
         group (r=4). Forest: 0.5% per attempt, up to 3 in a group (r=2). ---- */
      for (let ai = 0; ai < 2; ai++) {
        const mx = (hash3(cx * 47 + 1100 + ai,       19, cz * 43 + 1100 + ai    ) * 16) | 0;
        const mz = (hash3(cx * 53 + 1100 + ai * 3,   23, cz * 59 + 1100 + ai    ) * 16) | 0;
        const gi = (mx + 2) + (mz + 2) * 20;
        const h = H[gi];
        if (h <= WATER_LEVEL + 1 || h > 146 || DES[gi] || SNO[gi]) continue;
        const isPlains = TREE[gi] < 0.5;              // TREE = 1 - fPlains; low = open plains
        const chance = isPlains ? 0.015 : 0.005;
        if (hash3(cx * 71 + 1100 + ai, 77, cz * 67 + 1100 + ai) >= chance) continue;
        const clusterN = isPlains ? 1 + ((hash3(cx + 1100 + ai, 81, cz + 1100 + ai) * 4) | 0)
                                  : 1 + ((hash3(cx + 1100 + ai, 83, cz + 1100 + ai) * 2) | 0);
        const radius = isPlains ? 4 : 2;
        for (let k = 0; k < clusterN; k++) {
          const offx = (((hash3(cx * 31 + ai + k * 7,  89, cz * 29 + ai + k * 5) * (radius * 2 + 1)) | 0) - radius);
          const offz = (((hash3(cx * 37 + ai + k * 11, 97, cz * 41 + ai + k * 3) * (radius * 2 + 1)) | 0) - radius);
          const lx = mx + offx, lz = mz + offz;
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
          const lgi = (lx + 2) + (lz + 2) * 20;
          const lh = H[lgi];
          if (lh <= WATER_LEVEL + 1 || lh > 146) continue;
          if ((data[idx(lx, lh, lz)] & 255) !== B.GRASS) continue;
          if ((data[idx(lx, lh + 1, lz)] & 255) !== B.AIR) continue;
          data[idx(lx, lh + 1, lz)] = B.MELON;
        }
      }

      /* ---- pumpkins: same patch behaviour as melons, own hashes so they scatter separately ---- */
      for (let ai = 0; ai < 2; ai++) {
        const mx = (hash3(cx * 47 + 2200 + ai,       19, cz * 43 + 2200 + ai    ) * 16) | 0;
        const mz = (hash3(cx * 53 + 2200 + ai * 3,   23, cz * 59 + 2200 + ai    ) * 16) | 0;
        const gi = (mx + 2) + (mz + 2) * 20;
        const h = H[gi];
        if (h <= WATER_LEVEL + 1 || h > 146 || DES[gi] || SNO[gi]) continue;
        const isPlains = TREE[gi] < 0.5;
        const chance = isPlains ? 0.012 : 0.004;
        if (hash3(cx * 71 + 2200 + ai, 77, cz * 67 + 2200 + ai) >= chance) continue;
        const clusterN = isPlains ? 1 + ((hash3(cx + 2200 + ai, 81, cz + 2200 + ai) * 4) | 0)
                                  : 1 + ((hash3(cx + 2200 + ai, 83, cz + 2200 + ai) * 2) | 0);
        const radius = isPlains ? 4 : 2;
        for (let k = 0; k < clusterN; k++) {
          const offx = (((hash3(cx * 31 + ai + k * 7,  89, cz * 29 + ai + k * 5) * (radius * 2 + 1)) | 0) - radius);
          const offz = (((hash3(cx * 37 + ai + k * 11, 97, cz * 41 + ai + k * 3) * (radius * 2 + 1)) | 0) - radius);
          const lx = mx + offx, lz = mz + offz;
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
          const lgi = (lx + 2) + (lz + 2) * 20;
          const lh = H[lgi];
          if (lh <= WATER_LEVEL + 1 || lh > 146) continue;
          if ((data[idx(lx, lh, lz)] & 255) !== B.GRASS) continue;
          if ((data[idx(lx, lh + 1, lz)] & 255) !== B.AIR) continue;
          data[idx(lx, lh + 1, lz)] = B.PUMPKIN;
        }
      }

      /* ---- wheat: dense billboards scattered across grassy plains/forest tops (big amount) ---- */
      for (let lz = 0; lz < CZ; lz++)
        for (let lx = 0; lx < CX; lx++) {
          const gi = (lx + 2) + (lz + 2) * 20;
          const h = H[gi];
          if (h < 100 || h > 198 || DES[gi] || SNO[gi]) continue;                       // y100..200
          if (TREE[gi] >= 0.5) continue;                                                // plains only
          if ((data[idx(lx, h, lz)] & 255) !== B.GRASS) continue;
          if ((data[idx(lx, h + 1, lz)] & 255) !== B.AIR) continue;
          if (hash3(cx * 91 + lx + 3300, 61, cz * 89 + lz + 3300) >= 0.0008) continue;  // ~0.08% (80% fewer)
          data[idx(lx, h + 1, lz)] = B.WHEAT;
        }

      /* ---- surface plants: short grass (small amount over all forest/plains, none in
         desert/snow) + poppy / blue orchid flowers (denser in plains/meadows) ---- */
      for (let lz = 0; lz < CZ; lz++)
        for (let lx = 0; lx < CX; lx++) {
          const gi = (lx + 2) + (lz + 2) * 20;
          const h = H[gi];
          if (h < 99 || h > 198 || DES[gi] || SNO[gi]) continue;                       // y100..200; none in desert/snow
          if ((data[idx(lx, h, lz)] & 255) !== B.GRASS) continue;
          if ((data[idx(lx, h + 1, lz)] & 255) !== B.AIR) continue;
          const isPlains = TREE[gi] < 0.5;
          // meadow = flower-rich sub-region of plains (own low-freq mask)
          const wx = cx * 16 + lx, wz = cz * 16 + lz;
          const meadow = isPlains && fbm(wx * 0.006 + 6006, wz * 0.006 - 3003, 2) > 0.32;
          const r = hash3(cx * 97 + lx + 5500, 71, cz * 83 + lz + 5500);
          // flowers cut ~95%: forest tiny, plains small, meadows the main place they gather
          const flowerCh = meadow ? 0.02 : isPlains ? 0.0015 : 0.0003;
          // short grass thins with altitude (full at y100, ~1/4 at y200) but never disappears
          const alt = Math.min(1, Math.max(0, (h - 100) / 100));
          const grassCh  = 0.22 * (1 - alt * 0.75);
          if (r < flowerCh) {
            data[idx(lx, h + 1, lz)] = hash3(cx * 31 + lx + 12, 19, cz * 29 + lz + 7) < 0.5 ? B.POPPY : B.ORCHID;
          } else if (r < flowerCh + grassCh) {
            data[idx(lx, h + 1, lz)] = B.TALLGRASS;
          }
        }

      /* ---- canyons: rare winding ravines. A low-freq region mask gates them (deserts get a
         much higher chance); inside a region, a ridge line |noise|≈0 cuts a V-shaped gorge up
         to ~32 deep. Normal-biome canyons are 50/50 filled with water (per 128-block cell);
         desert canyons are always dry. Runs after decoration so the cut clears trees/plants. */
      for (let z = 0; z < CZ; z++)
        for (let x = 0; x < CX; x++) {
          const gi = (x + 2) + (z + 2) * 20;
          const h = H[gi];
          if (h <= WATER_LEVEL || h > 141) continue;             // skip oceans and high peaks
          const wx = cx * 16 + x, wz = cz * 16 + z;
          const isDesert = DES[gi] === 1;
          const rg = fbm(wx * 0.0015 + 555, wz * 0.0015 - 333, 2);
          if (rg < (isDesert ? 0.10 : 0.30)) continue;           // region gate (deserts: far more)
          // canyon TYPE per 128-block region: 0 = crack (thin earth-crack, rare),
          // 1 = wide canyon (5-10+ across, flatter floor), 2 = long canyon (stretched along one axis)
          const rcx = Math.floor(wx / 128), rcz = Math.floor(wz / 128);
          const tr = hash2(rcx * 3 + 41, rcz * 5 - 17);
          const type = tr < 0.18 ? 0 : tr < 0.62 ? 1 : 2;
          let cn, lw, dMax;
          if (type === 0)      { cn = fbm(wx * 0.008 + 911, wz * 0.008 - 477, 2); lw = 0.03; dMax = 30; }
          else if (type === 1) { cn = fbm(wx * 0.008 + 911, wz * 0.008 - 477, 2); lw = 0.12; dMax = 36; }
          else {                                                 // long: anisotropic noise stretches the line
            const flip = hash2(rcx * 7 + 3, rcz * 9 - 5) < 0.5;
            cn = flip ? fbm(wx * 0.0035 + 911, wz * 0.011 - 477, 2)
                      : fbm(wx * 0.011 + 911, wz * 0.0035 - 477, 2);
            lw = 0.07; dMax = 32;
          }
          if (Math.abs(cn) > lw) continue;                       // not on this region's canyon line
          const prof = 1 - Math.abs(cn) / lw;                    // 1 at centre -> 0 at rim
          const depth = Math.floor(Math.pow(prof, type === 1 ? 1.4 : 2) * dMax);   // wide: flatter floor
          if (depth < 4) continue;
          const floorY = Math.max(22, h - depth);
          const watered = !isDesert &&
            hash2(Math.floor(wx / 128) * 7 + 13, Math.floor(wz / 128) * 11 - 7) < 0.2;
          const wFill = 90;                                      // water surface inside wet canyons
          for (let y = Math.min(h + 8, 199); y >= floorY; y--) { // +8 clears trunks/leaves above the cut
            const i = idx(x, y, z);
            if ((data[i] & 255) === B.BEDROCK) break;
            data[i] = (watered && y <= wFill) ? B.WATER : B.AIR;
          }
        }

      /* ---- cactus: sparse 1-wide columns, 1-4 tall, on open desert / red-sand tops.
         Neighbouring terrain must not rise above the base so a fresh cactus never
         touches a block on its sides (matches the placement rule). ---- */
      for (let z = 0; z < CZ; z++)
        for (let x = 0; x < CX; x++) {
          const gi = (x + 2) + (z + 2) * 20;
          if (!DES[gi]) continue;
          const wx = cx * 16 + x, wz = cz * 16 + z;
          const chance = RED[gi] ? 0.0005 : 0.001;             // desert 0.1%, red sand 0.05%
          if (hash3(wx, 7777, wz) >= chance) continue;
          const h = H[gi];
          const top = data[idx(x, h, z)] & 255;
          if (top !== B.SAND && top !== B.RED_SAND) continue;
          if ((data[idx(x, h + 1, z)] & 255) !== B.AIR) continue;
          if (heightAt(wx + 1, wz) > h || heightAt(wx - 1, wz) > h ||
              heightAt(wx, wz + 1) > h || heightAt(wx, wz - 1) > h) continue;
          const n = 1 + ((hash3(wx, 8888, wz) * 4) | 0);
          for (let k = 1; k <= n && h + k < 199; k++) data[idx(x, h + k, z)] = B.CACTUS;
        }

      /* ---- sugar cane: ground column must be exactly one block above water level so the sand
         base sits at the shoreline and a side neighbour is water. Cane base ends up at y=h+1
         with water at y=WATER_LEVEL directly beside the sand base — the classic beach look. ---- */
      for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) {
        const gi = (x + 2) + (z + 2) * 20;
        const h = H[gi];
        if (h !== WATER_LEVEL + 1) continue;                            // must be exactly at shore
        const top = data[idx(x, h, z)] & 255;
        if (top !== B.SAND && top !== B.GRASS && top !== B.DIRT && top !== B.RED_SAND) continue;
        if ((data[idx(x, h + 1, z)] & 255) !== B.AIR) continue;
        // water adjacent at exactly y = WATER_LEVEL (shoreline)
        let waterAdj = false;
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
          if ((data[idx(nx, WATER_LEVEL, nz)] & 255) === B.WATER) { waterAdj = true; break; }
        }
        if (!waterAdj) continue;
        const isBeach = (top === B.SAND || top === B.RED_SAND);
        const chance = isBeach ? 0.85 : 0.25;
        const wx = cx * 16 + x, wz = cz * 16 + z;
        if (hash3(wx * 11 + 3301, 4242, wz * 13 + 5501) >= chance) continue;
        const tall = 1 + Math.floor(hash3(wx, 9191, wz) * 3);           // 1..3
        // Start cane at h (replacing the top sand) so the base cell sits at water-surface elevation
        // and the plant reads as growing from the shoreline instead of on a raised ledge.
        for (let k = 0; k < tall && h + k < 199; k++) data[idx(x, h + k, z)] = B.SUGAR_CANE;
      }

      /* ---- saplings: very sparse spawn on grass in tree-rich (forest) zones. Almost all oak;
         birch is a rare drop within an already-rare roll. ---- */
      for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) {
        const gi = (x + 2) + (z + 2) * 20;
        if (TREE[gi] < 0.35) continue;
        const h = H[gi];
        if (h <= WATER_LEVEL) continue;
        if ((data[idx(x, h, z)] & 255) !== B.GRASS) continue;
        if ((data[idx(x, h + 1, z)] & 255) !== B.AIR) continue;
        const wx = cx * 16 + x, wz = cz * 16 + z;
        const r = hash3(wx * 19 + 4401, 8181, wz * 23 + 4501);
        if (r >= 0.00001) continue;                                     // 0.001%
        // pick oak vs birch on a separate hash so a single-value bias can't force birch every time
        const birchRoll = hash3(wx * 29 + 5501, 4747, wz * 31 + 6601);
        data[idx(x, h + 1, z)] = birchRoll < 0.1 ? B.BIRCH_SAPLING : B.OAK_SAPLING;
      }
      return data.buffer;
    }

    return { genChunk, heightAt, biomeAt };
  }

  /* ---------- greedy mesher ----------
     Six directional sweeps. For each slice a 2D mask stores the raw voxel value
     (ID + variant), so only faces with identical texture/variant merge. Corner tables per
     direction keep windings CCW-outward and side textures upright & unmirrored.            */

  // Does block `a` show a face toward neighbour `b`?
  function faceVisible(a, b, P) {
    if (a === 0) return false;
    if (b === 0) return true;
    const A = P[a & 255], Bp = P[b & 255];
    if (Bp.opaque) return false;              // hidden behind an opaque neighbour
    if (A.opaque) return true;                // opaque against transparent -> visible
    if ((a & 255) === (b & 255)) return false; // same type (incl. leaf|leaf): cull inner faces —
                                               // inside a bush only the outer shell renders, and
                                               // the cutout pass is double-sided so that shell
                                               // is visible from within (big-bush feeling)
    return true;                              // different transparents (water vs glass...)
  }

  //          dir:      +Y        -Y        +X        -X        +Z        -Z
  const DIR_FACE  = [    2,        3,        0,        1,        4,        5   ]; // faces[] index
  const DIR_SHADE = [   255,      140,      178,      178,      216,      216  ]; // baked light
  const mask = new Int32Array(16 * 200);      // reused across sweeps (max plane size)
  const maskL = new Uint8Array(16 * 200);     // parallel mask of per-face block-light level

  function meshChunk(dataBuf, sxnB, sxpB, sznB, szpB, lightBuf, lxnB, lxpB, lznB, lzpB) {
    const data = new Uint16Array(dataBuf);
    const sxn = new Uint16Array(sxnB), sxp = new Uint16Array(sxpB);
    const szn = new Uint16Array(sznB), szp = new Uint16Array(szpB);
    const light = new Uint8Array(lightBuf);   // this chunk's block-light (flood-filled main-thread)
    const lxn = new Uint8Array(lxnB), lxp = new Uint8Array(lxpB);
    const lzn = new Uint8Array(lznB), lzp = new Uint8Array(lzpB);
    const P = PROPS;

    // neighbour-aware voxel read (y out of world: below = stone so bottom faces cull, above = air)
    function gb(x, y, z) {
      if (y < 0) return B.STONE;
      if (y > 199) return 0;
      if (x < 0)  return sxn[z + y * 16];
      if (x > 15) return sxp[z + y * 16];
      if (z < 0)  return szn[x + y * 16];
      if (z > 15) return szp[x + y * 16];
      return data[x + (z << 4) + (y << 8)];
    }
    // neighbour-aware light read (a face's light = light of the transparent cell it faces).
    // Byte is PACKED: low nibble = block light (glow), high nibble = sky light.
    function gl(x, y, z) {
      if (y > 199) return 0xF0;               // open sky above the world
      if (y < 0) return 0;
      if (x < 0)  return lxn[z + y * 16];
      if (x > 15) return lxp[z + y * 16];
      if (z < 0)  return lzn[x + y * 16];
      if (z > 15) return lzp[x + y * 16];
      return light[x + (z << 4) + (y << 8)];
    }

    // one growable buffer set per render pass
    const passes = [null, null, null, null].map(() => ({ pos: [], uv: [], tile: [], shade: [], lite: [], index: [], v: 0 }));
    let minY = 200, maxY = 0;

    function quad(pass, c0, c1, c2, c3, u0, u1, u2, u3, tile, shade, lite) {
      const g = passes[pass], base = g.v;
      g.pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2], c3[0], c3[1], c3[2]);
      g.uv.push(u0[0], u0[1], u1[0], u1[1], u2[0], u2[1], u3[0], u3[1]);
      g.tile.push(tile, tile, tile, tile);
      g.shade.push(shade, shade, shade, shade);
      g.lite.push(lite, lite, lite, lite);
      g.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      g.v += 4;
      const lo = Math.min(c0[1], c2[1]), hi = Math.max(c0[1], c2[1]);
      if (lo < minY) minY = lo;
      if (hi > maxY) maxY = hi;
    }
    function quadV(pass, c0, c1, c2, c3, u0, u1, u2, u3, tile, s0, s1, s2, s3, lite) {
      const g = passes[pass], base = g.v;
      g.pos.push(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2], c3[0], c3[1], c3[2]);
      g.uv.push(u0[0], u0[1], u1[0], u1[1], u2[0], u2[1], u3[0], u3[1]);
      g.tile.push(tile, tile, tile, tile);
      g.shade.push(s0, s1, s2, s3);
      g.lite.push(lite, lite, lite, lite);
      g.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      g.v += 4;
      const lo = Math.min(c0[1], c2[1]), hi = Math.max(c0[1], c2[1]);
      if (lo < minY) minY = lo;
      if (hi > maxY) maxY = hi;
    }

    // sweep config per direction: normal axis d, sign s, mask axes (ua=u, va=v), plane dims
    const CFG = [
      { d: 1, s: +1, ua: 0, va: 2, us: 16, vs: 16  },   // +Y
      { d: 1, s: -1, ua: 0, va: 2, us: 16, vs: 16  },   // -Y
      { d: 0, s: +1, ua: 2, va: 1, us: 16, vs: 200 },   // +X
      { d: 0, s: -1, ua: 2, va: 1, us: 16, vs: 200 },   // -X
      { d: 2, s: +1, ua: 0, va: 1, us: 16, vs: 200 },   // +Z
      { d: 2, s: -1, ua: 0, va: 1, us: 16, vs: 200 },   // -Z
    ];
    const dims = [16, 200, 16];
    const pos = [0, 0, 0], npos = [0, 0, 0];

    // highest non-air layer in this chunk — everything above is open sky with no faces, so the
    // sweeps (and the per-model loops below) skip it. Huge win now the world is tall: a flat
    // chunk tops out ~y66 and never scans the 130+ empty layers above.
    let topY = 0;
    for (let y = dims[1] - 1; y >= 0; y--) {
      const base = y << 8; let has = false;
      for (let i = 0; i < 256; i++) if (data[base + i] !== 0) { has = true; break; }
      if (has) { topY = y; break; }
    }
    const yCap = Math.min(dims[1], topY + 2);   // +1 layer of air above the top block keeps top faces

    for (let dir = 0; dir < 6; dir++) {
      const { d, s, ua, va, us, vs } = CFG[dir];
      const faceIdx = DIR_FACE[dir], shade = DIR_SHADE[dir];
      const nMax = d === 1 ? Math.min(dims[d], yCap) : dims[d];   // cap the vertical extent
      const vsE  = va === 1 ? Math.min(vs, yCap) : vs;

      for (let n = 0; n < nMax; n++) {
        // ---- build visibility mask for this slice ----
        let any = false;
        for (let v = 0; v < vsE; v++) {
          for (let u = 0; u < us; u++) {
            pos[d] = n; pos[ua] = u; pos[va] = v;
            const a = data[pos[0] + (pos[2] << 4) + (pos[1] << 8)];
            let m = 0, ml = 0;
            if (a !== 0 && P[a & 255].model === 'cube' && (a & 255) !== B.WATER && (a & 255) !== B.LAVA) {   // non-cube models emit separately; water/lava handled by emitWater/emitLava
              npos[0] = pos[0]; npos[1] = pos[1]; npos[2] = pos[2]; npos[d] += s;
              if (faceVisible(a, gb(npos[0], npos[1], npos[2]), P)) {
                m = a; any = true;
                ml = gl(npos[0], npos[1], npos[2]);   // face lit by the transparent cell it faces
              }
            }
            mask[u + v * us] = m;
            maskL[u + v * us] = ml;
          }
        }
        if (!any) continue;

        // ---- greedy rectangle expansion (faces merge only when tile AND light match) ----
        for (let v = 0; v < vsE; v++) {
          for (let u = 0; u < us;) {
            const val = mask[u + v * us], lv = maskL[u + v * us];
            if (!val) { u++; continue; }
            let w = 1;
            while (u + w < us && mask[u + w + v * us] === val && maskL[u + w + v * us] === lv) w++;
            let h = 1;
            outer: while (v + h < vsE) {
              for (let k = 0; k < w; k++)
                if (mask[u + k + (v + h) * us] !== val || maskL[u + k + (v + h) * us] !== lv) break outer;
              h++;
            }
            emit(dir, n, u, v, w, h, val, lv);
            for (let dv = 0; dv < h; dv++)
              for (let k = 0; k < w; k++) mask[u + k + (v + dv) * us] = 0;
            u += w;
          }
        }
      }

      function emit(dir, n, u0, v0, w, h, val, lv) {
        const id = val & 255, prop = PROPS[id];
        // MODEL dispatch — only 'cube' exists today; non-cube models (slabs, stairs,
        // torches, doors + rotation variants) would branch here with their own emitters.
        if (prop.model !== 'cube') return;
        let tile = prop.faces[faceIdx];
        const varb = (val >> 8) & 255;
        // grass "snowy" variant: snow-covered sides (top stays grass, bottom stays dirt).
        // driven by the variant byte, set wherever a snow block sits on grass.
        if (id === B.GRASS && varb === V.GRASS_SNOWY && faceIdx !== 2 && faceIdx !== 3)
          tile = T.GRASS_SNOW_SIDE;
        // TNT lit-blink variant: swap every face to the white snow tile for a visible flash pulse
        if (id === B.TNT && (varb & 1)) tile = T.TNT_LIT;
        // lying log: ring texture on the faces along the log's axis (1 = X, 2 = Z)
        if (id === B.LOG && varb)
          tile = (varb === 1 ? (faceIdx === 0 || faceIdx === 1) : (faceIdx === 4 || faceIdx === 5))
            ? T.LOG_TOP : T.LOG;
        // rot:'side' blocks: front tile sits on the variant's facing; lit furnace swaps it
        if (id === B.FURNACE) {
          const front = SIDE_FACE[varb & 3];
          tile = (faceIdx === 2 || faceIdx === 3) ? T.FURNACE_TOP
               : faceIdx === front ? ((varb & V.FURNACE_ON) ? T.FURNACE_FRONT_ON : T.FURNACE_FRONT)
               : T.FURNACE_SIDE;
        }
        if (id === B.CRAFTING_BENCH) {
          const front = SIDE_FACE[varb & 3];
          tile = faceIdx === 2 ? T.CRAFT_TOP : faceIdx === 3 ? T.PLANKS
               : faceIdx === front ? T.CRAFT_FRONT : T.CRAFT_SIDE;
        }
        const pass = prop.pass;
        let wc = n + (s > 0 ? 1 : 0);        // face plane coordinate along axis d
        // water surface sits slightly below the block top (classic look)
        if (dir === 0 && id === B.WATER) wc -= 0.12;
        const u1 = u0 + w, v1 = v0 + h;
        switch (dir) {
          case 0: quad(pass, [u0,wc,v0],[u0,wc,v1],[u1,wc,v1],[u1,wc,v0], [0,0],[0,h],[w,h],[w,0], tile, shade, lv); break;
          case 1: quad(pass, [u0,wc,v0],[u1,wc,v0],[u1,wc,v1],[u0,wc,v1], [0,0],[w,0],[w,h],[0,h], tile, shade, lv); break;
          case 2: quad(pass, [wc,v0,u0],[wc,v1,u0],[wc,v1,u1],[wc,v0,u1], [w,0],[w,h],[0,h],[0,0], tile, shade, lv); break;
          case 3: quad(pass, [wc,v0,u0],[wc,v0,u1],[wc,v1,u1],[wc,v1,u0], [0,0],[w,0],[w,h],[0,h], tile, shade, lv); break;
          case 4: quad(pass, [u0,v0,wc],[u1,v0,wc],[u1,v1,wc],[u0,v1,wc], [0,0],[w,0],[w,h],[0,h], tile, shade, lv); break;
          case 5: quad(pass, [u0,v0,wc],[u0,v1,wc],[u1,v1,wc],[u1,v0,wc], [w,0],[w,h],[0,h],[0,0], tile, shade, lv); break;
        }
      }
    }

    // ---- non-cube models (slab): emitted per-block with bespoke geometry ----
    // Variant picks the occupied half/halves (see SLAB_VAR: singles, same-type doubles, mixed
    // doubles). Each face's UVs come from the box extents so half faces sample the matching half
    // of the texture. Faces flush with the cell border cull against opaque neighbours.
    // f = 6-tile faces array [+X,-X,+Y(top),-Y(bottom),+Z,-Z] so slabs get real top/bottom textures
    function emitBoxFaces(x, y, z, b, f) {
      const x0 = x+b[0], y0 = y+b[1], z0 = z+b[2], x1 = x+b[3], y1 = y+b[4], z1 = z+b[5];
      const op = (xx, yy, zz) => P[gb(xx, yy, zz) & 255].opaque;
      if (b[4] < 1 || !op(x, y+1, z))            // top
        quad(0, [x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],
             [b[0],b[2]],[b[0],b[5]],[b[3],b[5]],[b[3],b[2]], f[2], 255, gl(x, y+1, z));
      if (b[1] > 0 || !op(x, y-1, z))            // bottom
        quad(0, [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],
             [b[0],b[2]],[b[3],b[2]],[b[3],b[5]],[b[0],b[5]], f[3], 140, gl(x, y-1, z));
      if (b[3] < 1 || !op(x+1, y, z))            // +X
        quad(0, [x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1],
             [1-b[2],b[1]],[1-b[2],b[4]],[1-b[5],b[4]],[1-b[5],b[1]], f[0], 178, gl(x+1, y, z));
      if (b[0] > 0 || !op(x-1, y, z))            // -X
        quad(0, [x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],
             [b[2],b[1]],[b[5],b[1]],[b[5],b[4]],[b[2],b[4]], f[1], 178, gl(x-1, y, z));
      if (b[5] < 1 || !op(x, y, z+1))            // +Z
        quad(0, [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],
             [b[0],b[1]],[b[3],b[1]],[b[3],b[4]],[b[0],b[4]], f[4], 216, gl(x, y, z+1));
      if (b[2] > 0 || !op(x, y, z-1))            // -Z
        quad(0, [x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0],
             [1-b[0],b[1]],[1-b[0],b[4]],[1-b[3],b[4]],[1-b[3],b[1]], f[5], 216, gl(x, y, z-1));
    }
    for (let y = 0; y < yCap; y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const val = data[x + (z << 4) + (y << 8)], vid = val & 255;
          if (PROPS[vid].model === 'slab') {
            const va = (val >> 8) & 255;
            const boxes = PROPS[vid].boxesByVar[va] || PROPS[vid].boxesByVar[0];
            if (va >= 16) {                              // mixed double: box0 own tile, box1 partner tile
              const partner = SLAB_IDS[(va - 16) >> 3];
              emitBoxFaces(x, y, z, boxes[0], PROPS[vid].faces);
              if (boxes[1]) emitBoxFaces(x, y, z, boxes[1], (partner != null ? PROPS[partner] : PROPS[vid]).faces);
            } else
              for (let bi = 0; bi < boxes.length; bi++)
                emitBoxFaces(x, y, z, boxes[bi], PROPS[vid].faces);
          }
          else if (PROPS[vid].model === 'stairs')
            for (const bx of stairBoxesAt(gb, x, y, z, val))
              emitBoxFaces(x, y, z, bx, PROPS[vid].faces);
          else if (PROPS[vid].model === 'carpet') {
            const va = (val >> 8) & 255;
            const boxes = PROPS[vid].boxesByVar[va] || PROPS[vid].boxesByVar[0];
            for (let bi = 0; bi < boxes.length; bi++)
              emitBoxFaces(x, y, z, boxes[bi], PROPS[vid].faces);
          }
        }

    // ---- non-cube: cross/billboard (plants) ----
    // Two diagonal quads, each emitted front + back (double-sided)
    function emitCross(x, y, z, blockId, varb) {
      // sulfur tip: variant 1 = flipped/down orientation, swap tile to the down-tip texture
      let tile = PROPS[blockId].faces[0];
      if (blockId === B.SULFUR_UP_TIP && (varb & 1)) tile = T.SULFUR_DOWN_TIP;
      const lite = gl(x, y + 1, z);
      const sh = 210;
      quad(1,[x,y,z+1],[x+1,y,z],[x+1,y+1,z],[x,y+1,z+1], [0,0],[1,0],[1,1],[0,1],tile,sh,lite);
      quad(1,[x,y+1,z+1],[x+1,y+1,z],[x+1,y,z],[x,y,z+1], [0,1],[1,1],[1,0],[0,0],tile,sh,lite);
      quad(1,[x+1,y,z+1],[x,y,z],[x,y+1,z],[x+1,y+1,z+1], [0,0],[1,0],[1,1],[0,1],tile,sh,lite);
      quad(1,[x+1,y+1,z+1],[x,y+1,z],[x,y,z],[x+1,y,z+1], [0,1],[1,1],[1,0],[0,0],tile,sh,lite);
    }
    for (let y = 1; y < Math.min(199, yCap); y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const val = data[x + (z << 4) + (y << 8)];
          const bid = val & 255;
          if (PROPS[bid] && PROPS[bid].model === 'cross') emitCross(x, y, z, bid, (val >> 8) & 255);
        }

    // ---- non-cube: cactus — full-height column, side faces inset 1/16 (thin look) ----
    function emitCactus(x, y, z) {
      const f = PROPS[B.CACTUS].faces;           // [+X,-X,top,bottom,+Z,-Z]
      const e = 0.0625;
      const y0 = y, y1 = y + 1;
      if ((gb(x, y + 1, z) & 255) !== B.CACTUS)
        quad(1, [x,y1,z],[x,y1,z+1],[x+1,y1,z+1],[x+1,y1,z], [0,0],[0,1],[1,1],[1,0], f[2], 255, gl(x, y+1, z));
      if ((gb(x, y - 1, z) & 255) !== B.CACTUS && !P[gb(x, y-1, z) & 255].opaque)
        quad(1, [x,y0,z],[x+1,y0,z],[x+1,y0,z+1],[x,y0,z+1], [0,0],[1,0],[1,1],[0,1], f[3], 140, gl(x, y-1, z));
      const xp = x + 1 - e, xn = x + e, zp = z + 1 - e, zn = z + e;
      quad(1, [xp,y0,z],[xp,y1,z],[xp,y1,z+1],[xp,y0,z+1], [1,0],[1,1],[0,1],[0,0], f[0], 178, gl(x+1, y, z)); // +X
      quad(1, [xn,y0,z],[xn,y0,z+1],[xn,y1,z+1],[xn,y1,z], [0,0],[1,0],[1,1],[0,1], f[1], 178, gl(x-1, y, z)); // -X
      quad(1, [x,y0,zp],[x+1,y0,zp],[x+1,y1,zp],[x,y1,zp], [0,0],[1,0],[1,1],[0,1], f[4], 216, gl(x, y, z+1)); // +Z
      quad(1, [x,y0,zn],[x,y1,zn],[x+1,y1,zn],[x+1,y0,zn], [1,0],[1,1],[0,1],[0,0], f[5], 216, gl(x, y, z-1)); // -Z
    }
    for (let y = 0; y < Math.min(199, yCap); y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++)
          if ((data[x + (z << 4) + (y << 8)] & 255) === B.CACTUS) emitCactus(x, y, z);

    // ---- logs: inset column (like cactus) on the two axes perpendicular to the trunk axis;
    // reuses emitBoxFaces so end-cap faces still cull against opaque/same neighbours ----
    const LOG_BOX = [ [0.0625,0,0.0625, 0.9375,1,0.9375],     // var 0: Y-axis trunk (inset X,Z)
                      [0,0.0625,0.0625, 1,0.9375,0.9375],     // var 1: X-axis (inset Y,Z)
                      [0.0625,0.0625,0, 0.9375,0.9375,1] ];    // var 2: Z-axis (inset X,Y)
    // side faces always draw (inset — visible through the gap); the two end-caps along the trunk
    // axis cull only against a same-id log (continuous trunk) or an opaque neighbour.
    function emitLog(x, y, z, val) {
      const id = val & 255, va = (val >> 8) & 3, b = LOG_BOX[va] || LOG_BOX[0];
      const F = PROPS[id].faces, side = F[0], top = F[2];
      const rf = va === 1 ? [top, top, side, side, side, side]      // X-axis: caps on ±X
               : va === 2 ? [side, side, side, side, top, top]      // Z-axis: caps on ±Z
               :            [side, side, top, top, side, side];     // Y-axis: caps on ±Y
      const x0 = x+b[0], y0 = y+b[1], z0 = z+b[2], x1 = x+b[3], y1 = y+b[4], z1 = z+b[5];
      const capped = (nx, ny, nz) => { const n = gb(nx, ny, nz) & 255; return n === id || P[n].opaque; };
      if (!(va === 0 && capped(x, y+1, z)))         // +Y
        quad(0, [x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0], [b[0],b[2]],[b[0],b[5]],[b[3],b[5]],[b[3],b[2]], rf[2], 255, gl(x, y+1, z));
      if (!(va === 0 && capped(x, y-1, z)))         // -Y
        quad(0, [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], [b[0],b[2]],[b[3],b[2]],[b[3],b[5]],[b[0],b[5]], rf[3], 140, gl(x, y-1, z));
      if (!(va === 1 && capped(x+1, y, z)))         // +X
        quad(0, [x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1], [1-b[2],b[1]],[1-b[2],b[4]],[1-b[5],b[4]],[1-b[5],b[1]], rf[0], 178, gl(x+1, y, z));
      if (!(va === 1 && capped(x-1, y, z)))         // -X
        quad(0, [x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0], [b[2],b[1]],[b[5],b[1]],[b[5],b[4]],[b[2],b[4]], rf[1], 178, gl(x-1, y, z));
      if (!(va === 2 && capped(x, y, z+1)))         // +Z
        quad(0, [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], [b[0],b[1]],[b[3],b[1]],[b[3],b[4]],[b[0],b[4]], rf[4], 216, gl(x, y, z+1));
      if (!(va === 2 && capped(x, y, z-1)))         // -Z
        quad(0, [x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0], [1-b[0],b[1]],[1-b[0],b[4]],[1-b[3],b[4]],[1-b[3],b[1]], rf[5], 216, gl(x, y, z-1));
    }
    for (let y = 0; y < yCap; y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const val = data[x + (z << 4) + (y << 8)];
          if (PROPS[val & 255].model === 'log') emitLog(x, y, z, val);
        }

    // ---- per-block water: level-based top height, no greedy merge ----
    // variant byte = level: 0 = source (full), 1-7 = flowing ((8-level)/8 height)
    function emitWater(x, y, z, val) {
      const level = (val >> 8) & 7;
      const frac  = (8 - level) / 9;          // source≈0.889, level7≈0.111
      const x0 = x, x1 = x + 1, y0 = y, z0 = z, z1 = z + 1;
      const tile = T.WATER;
      // depth darkness comes from sky-light attenuation through water (09-light-sky.js),
      // not from tinting the surface quad — dl is a passthrough kept for the call sites
      const dl = (v) => v;
      // top: shade 255=source (waves), 240=flowing (no waves)
      if ((gb(x, y + 1, z) & 255) !== B.WATER)
        quad(2, [x0,y+frac,z0],[x0,y+frac,z1],[x1,y+frac,z1],[x1,y+frac,z0], [0,0],[0,1],[1,1],[1,0], tile, level === 0 ? 255 : 240, dl(gl(x, y + 1, z)));
      // bottom: only if below is not water/opaque
      const belowId = gb(x, y - 1, z) & 255;
      if (belowId !== B.WATER && !(P[belowId] && P[belowId].opaque))
        quad(2, [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], [0,0],[1,0],[1,1],[0,1], tile, 140, dl(gl(x, y - 1, z)));
      // shade 253 marks "waving surface vertex" → only source blocks wave; flowing stays static
      const topS = level === 0 ? 253 : 0;    // 0 = fall through to base shade below
      // +X: vertex order [BL,TL,TR,BR] → top=v1,v2
      const bxpRaw = gb(x + 1, y, z); const bxpId = bxpRaw & 255;
      if (bxpId !== B.WATER) {
        if (!(P[bxpId] && P[bxpId].opaque))
          quadV(2, [x1,y0,z0],[x1,y+frac,z0],[x1,y+frac,z1],[x1,y0,z1], [1,0],[1,frac],[0,frac],[0,0], tile, 178,topS||178,topS||178,178, dl(gl(x + 1, y, z)));
      } else { const nf = (8 - ((bxpRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(2, [x1,y+nf,z0],[x1,y+frac,z0],[x1,y+frac,z1],[x1,y+nf,z1], [1,nf],[1,frac],[0,frac],[0,nf], tile, 178,topS||178,topS||178,178, dl(gl(x + 1, y, z)));
      }
      // -X: vertex order [BL,BR,TR,TL] → top=v2,v3
      const bxnRaw = gb(x - 1, y, z); const bxnId = bxnRaw & 255;
      if (bxnId !== B.WATER) {
        if (!(P[bxnId] && P[bxnId].opaque))
          quadV(2, [x0,y0,z0],[x0,y0,z1],[x0,y+frac,z1],[x0,y+frac,z0], [0,0],[1,0],[1,frac],[0,frac], tile, 178,178,topS||178,topS||178, dl(gl(x - 1, y, z)));
      } else { const nf = (8 - ((bxnRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(2, [x0,y+nf,z0],[x0,y+nf,z1],[x0,y+frac,z1],[x0,y+frac,z0], [0,nf],[1,nf],[1,frac],[0,frac], tile, 178,178,topS||178,topS||178, dl(gl(x - 1, y, z)));
      }
      // +Z: vertex order [BL,BR,TR,TL] → top=v2,v3
      const bzpRaw = gb(x, y, z + 1); const bzpId = bzpRaw & 255;
      if (bzpId !== B.WATER) {
        if (!(P[bzpId] && P[bzpId].opaque))
          quadV(2, [x0,y0,z1],[x1,y0,z1],[x1,y+frac,z1],[x0,y+frac,z1], [0,0],[1,0],[1,frac],[0,frac], tile, 216,216,topS||216,topS||216, dl(gl(x, y, z + 1)));
      } else { const nf = (8 - ((bzpRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(2, [x0,y+nf,z1],[x1,y+nf,z1],[x1,y+frac,z1],[x0,y+frac,z1], [0,nf],[1,nf],[1,frac],[0,frac], tile, 216,216,topS||216,topS||216, dl(gl(x, y, z + 1)));
      }
      // -Z: vertex order [BL,TL,TR,BR] → top=v1,v2
      const bznRaw = gb(x, y, z - 1); const bznId = bznRaw & 255;
      if (bznId !== B.WATER) {
        if (!(P[bznId] && P[bznId].opaque))
          quadV(2, [x0,y0,z0],[x0,y+frac,z0],[x1,y+frac,z0],[x1,y0,z0], [1,0],[1,frac],[0,frac],[0,0], tile, 216,topS||216,topS||216,216, dl(gl(x, y, z - 1)));
      } else { const nf = (8 - ((bznRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(2, [x0,y+nf,z0],[x0,y+frac,z0],[x1,y+frac,z0],[x1,y+nf,z0], [1,nf],[1,frac],[0,frac],[0,nf], tile, 216,topS||216,topS||216,216, dl(gl(x, y, z - 1)));
      }
    }
    // ---- per-block lava: same as water (pass 3, opaque, slower waves) ----
    function emitLava(x, y, z, val) {
      const level = (val >> 8) & 7;
      const frac  = (8 - level) / 9;
      const x0 = x, x1 = x + 1, y0 = y, z0 = z, z1 = z + 1;
      const tile = T.LAVA;
      const lite = 255;   // emissive: always full brightness
      if ((gb(x, y + 1, z) & 255) !== B.LAVA)
        quad(3, [x0,y+frac,z0],[x0,y+frac,z1],[x1,y+frac,z1],[x1,y+frac,z0], [0,0],[0,1],[1,1],[1,0], tile, level === 0 ? 255 : 240, lite);
      const belowId = gb(x, y - 1, z) & 255;
      if (belowId !== B.LAVA && !(P[belowId] && P[belowId].opaque))
        quad(3, [x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], [0,0],[1,0],[1,1],[0,1], tile, 140, lite);
      const topS = level === 0 ? 253 : 0;
      const bxpRaw = gb(x + 1, y, z); const bxpId = bxpRaw & 255;
      if (bxpId !== B.LAVA) {
        if (!(P[bxpId] && P[bxpId].opaque))
          quadV(3, [x1,y0,z0],[x1,y+frac,z0],[x1,y+frac,z1],[x1,y0,z1], [1,0],[1,frac],[0,frac],[0,0], tile, 178,topS||178,topS||178,178, lite);
      } else { const nf = (8 - ((bxpRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(3, [x1,y+nf,z0],[x1,y+frac,z0],[x1,y+frac,z1],[x1,y+nf,z1], [1,nf],[1,frac],[0,frac],[0,nf], tile, 178,topS||178,topS||178,178, lite);
      }
      const bxnRaw = gb(x - 1, y, z); const bxnId = bxnRaw & 255;
      if (bxnId !== B.LAVA) {
        if (!(P[bxnId] && P[bxnId].opaque))
          quadV(3, [x0,y0,z0],[x0,y0,z1],[x0,y+frac,z1],[x0,y+frac,z0], [0,0],[1,0],[1,frac],[0,frac], tile, 178,178,topS||178,topS||178, lite);
      } else { const nf = (8 - ((bxnRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(3, [x0,y+nf,z0],[x0,y+nf,z1],[x0,y+frac,z1],[x0,y+frac,z0], [0,nf],[1,nf],[1,frac],[0,frac], tile, 178,178,topS||178,topS||178, lite);
      }
      const bzpRaw = gb(x, y, z + 1); const bzpId = bzpRaw & 255;
      if (bzpId !== B.LAVA) {
        if (!(P[bzpId] && P[bzpId].opaque))
          quadV(3, [x0,y0,z1],[x1,y0,z1],[x1,y+frac,z1],[x0,y+frac,z1], [0,0],[1,0],[1,frac],[0,frac], tile, 216,216,topS||216,topS||216, lite);
      } else { const nf = (8 - ((bzpRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(3, [x0,y+nf,z1],[x1,y+nf,z1],[x1,y+frac,z1],[x0,y+frac,z1], [0,nf],[1,nf],[1,frac],[0,nf], tile, 216,216,topS||216,topS||216, lite);
      }
      const bznRaw = gb(x, y, z - 1); const bznId = bznRaw & 255;
      if (bznId !== B.LAVA) {
        if (!(P[bznId] && P[bznId].opaque))
          quadV(3, [x0,y0,z0],[x0,y+frac,z0],[x1,y+frac,z0],[x1,y0,z0], [1,0],[1,frac],[0,frac],[0,0], tile, 216,topS||216,topS||216,216, lite);
      } else { const nf = (8 - ((bznRaw >> 8) & 7)) / 9;
        if (frac > nf + 0.01)
          quadV(3, [x0,y+nf,z0],[x0,y+frac,z0],[x1,y+frac,z0],[x1,y+nf,z0], [1,nf],[1,frac],[0,frac],[0,nf], tile, 216,topS||216,topS||216,216, lite);
      }
    }

    for (let y = 0; y < yCap; y++)
      for (let z = 0; z < 16; z++)
        for (let x = 0; x < 16; x++) {
          const val = data[x + (z << 4) + (y << 8)];
          if ((val & 255) === B.WATER) emitWater(x, y, z, val);
          else if ((val & 255) === B.LAVA) emitLava(x, y, z, val);
        }

    // pack into typed arrays (transferable)
    const out = passes.map(g => g.v === 0 ? null : ({
      pos:   new Float32Array(g.pos),
      uv:    new Float32Array(g.uv),
      tile:  new Uint8Array(g.tile),
      shade: new Uint8Array(g.shade),
      lite:  new Uint8Array(g.lite),
      index: new Uint32Array(g.index),
    }));
    return { passes: out, minY: Math.min(minY, maxY), maxY: Math.max(maxY, 2) };
  }

  return { B, T, V, PROPS, SLAB_IDS, stairBoxesAt, makeGen, meshChunk, idx };
}

/* ---------- worker entry point (stringified into the blob together with VOXEL_CORE) ---------- */
function WORKER_MAIN() {
  let gen = null;
  self.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.type === 'init') {
        gen = CORE.makeGen(m.seed);
      } else if (m.type === 'gen') {
        const buf = gen.genChunk(m.cx, m.cz);
        self.postMessage({ type: 'gen', cx: m.cx, cz: m.cz, data: buf }, [buf]);
      } else if (m.type === 'mesh') {
        const r = CORE.meshChunk(m.data, m.sxn, m.sxp, m.szn, m.szp, m.light, m.lxn, m.lxp, m.lzn, m.lzp);
        const transfers = [];
        for (const p of r.passes) if (p) transfers.push(p.pos.buffer, p.uv.buffer, p.tile.buffer, p.shade.buffer, p.lite.buffer, p.index.buffer);
        self.postMessage({ type: 'mesh', cx: m.cx, cz: m.cz, rev: m.rev, passes: r.passes, minY: r.minY, maxY: r.maxY }, transfers);
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.stack || err) });
    }
  };
}

const CORE = VOXEL_CORE();
const { B, V, PROPS, SLAB_IDS } = CORE;

// Items (IDs >= 256) — separate registry from blocks
const ITEM = { STICK: 256, COAL: 257, COAL_CHUNK: 258, RAW_IRON: 259, DIAMOND: 260, APPLE: 261,
               FLINT: 262, CLAY_BALL: 263, SNOWBALL: 264, BOWL: 265, MUSHROOM_STEW: 266, GLASS_SHARD: 267,
               IRON_INGOT: 268, IRON_NUGGET: 269, MELON_SLICE: 270,
               IRON_SHOVEL: 271, IRON_PICKAXE: 272, IRON_HATCHET: 273,
               WOODEN_SHOVEL: 274, WOODEN_PICKAXE: 275, WOODEN_HATCHET: 276,
               STONE_SHOVEL: 277, STONE_PICKAXE: 278, STONE_HATCHET: 279,
               DIAMOND_SHOVEL: 280, DIAMOND_PICKAXE: 281, DIAMOND_HATCHET: 282,
               BUCKET: 283, WATER_BUCKET: 284, WHEAT: 285, PUMPKIN_PIE: 286,
               WOODEN_HOE: 287, STONE_HOE: 288, IRON_HOE: 289, DIAMOND_HOE: 290,
               LAVA_BUCKET: 291, SULFUR: 292, CHARCOAL: 293, GUNPOWDER: 294, SUGAR_CANE: 295,
               SUGAR: 296, PAPER: 297, GOLDEN_PICKAXE: 298, GOLDEN_HATCHET: 299, GOLDEN_SHOVEL: 300,
               GOLDEN_HOE: 301, FLOUR: 302, BOOK: 303, RAW_COPPER: 304, COPPER_INGOT: 305, COPPER_NUGGET: 306,
               RAW_TIN: 307, TIN_INGOT: 308, TIN_NUGGET: 309, RAW_GOLD: 310, GOLD_INGOT: 311, GOLD_NUGGET: 312,
               GLOW_DUST: 313, BRICK: 314, GOLDEN_APPLE:315, BREAD:316 };
const ITEM_PROPS = {
  [ITEM.STICK]:         { name: 'Stick',         stack: 99, icon: 'stick'         },
  [ITEM.FLINT]:         { name: 'Flint',         stack: 99, icon: 'flint'         },
  [ITEM.CLAY_BALL]:     { name: 'Clay ball',     stack: 99, icon: 'clay_ball'     },
  [ITEM.BOWL]:          { name: 'Bowl',          stack: 30, icon: 'bowl'          },
  [ITEM.GLASS_SHARD]:   { name: 'Glass shard',   stack: 99, icon: 'glass_shard'   },
  [ITEM.SULFUR]:        { name: 'Sulfur',        stack: 99, icon: 'sulfur'        },
  [ITEM.CHARCOAL]:      { name: 'Charcoal',      stack: 99, icon: 'charcoal'      },
  [ITEM.GUNPOWDER]:     { name: 'Gunpowder',     stack: 99, icon: 'gunpowder'     },
  [ITEM.SUGAR]:         { name: 'Sugar',         stack: 99, icon: 'sugar'         },
  [ITEM.PAPER]:         { name: 'Paper',         stack: 99, icon: 'paper'         },
  [ITEM.FLOUR]:         { name: 'Flour',         stack: 99, icon: 'flour'         },
  [ITEM.BRICK]:         { name: 'Brick',         stack: 99, icon: 'brick'         },
  [ITEM.GLOW_DUST]:     { name: 'Glow dust',     stack: 99, icon: 'glow_dust'     },

// ores
  [ITEM.COAL]:          { name: 'Coal',          stack: 99, icon: 'coal'          },
  [ITEM.COAL_CHUNK]:    { name: 'Coal chunk',    stack: 99, icon: 'coal_chunk'    },
  [ITEM.RAW_IRON]:      { name: 'Raw iron',      stack: 99, icon: 'raw_iron'      },
  [ITEM.IRON_INGOT]:    { name: 'Iron ingot',    stack: 99, icon: 'iron_ingot'    },
  [ITEM.IRON_NUGGET]:   { name: 'Iron nugget',   stack: 99, icon: 'iron_nugget'   },
  [ITEM.RAW_COPPER]:    { name: 'Raw copper',    stack: 99, icon: 'raw_copper'    },
  [ITEM.COPPER_INGOT]:  { name: 'Copper ingot',  stack: 99, icon: 'copper_ingot'  },
  [ITEM.COPPER_NUGGET]: { name: 'Copper nugget', stack: 99, icon: 'copper_nugget' },
  [ITEM.RAW_TIN]:       { name: 'Raw tin',       stack: 99, icon: 'raw_tin'       },
  [ITEM.TIN_INGOT]:     { name: 'Tin ingot',     stack: 99, icon: 'tin_ingot'     },
  [ITEM.TIN_NUGGET]:    { name: 'Tin nugget',    stack: 99, icon: 'tin_nugget'    },
  [ITEM.RAW_IRON]:      { name: 'Raw iron',      stack: 99, icon: 'raw_iron'      },
  [ITEM.IRON_INGOT]:    { name: 'Iron ingot',    stack: 99, icon: 'iron_ingot'    },
  [ITEM.IRON_NUGGET]:   { name: 'Iron nugget',   stack: 99, icon: 'iron_nugget'   },
  [ITEM.RAW_GOLD]:      { name: 'Raw gold',      stack: 99, icon: 'raw_gold'      },
  [ITEM.GOLD_INGOT]:    { name: 'Gold ingot',    stack: 99, icon: 'gold_ingot'    },
  [ITEM.GOLD_NUGGET]:   { name: 'Gold nugget',   stack: 99, icon: 'gold_nugget'   },
  [ITEM.DIAMOND]:       { name: 'Diamond',       stack: 99, icon: 'diamond'       },
  // tools: stack 1, own durability (breaks at 0), toolSpeed = mining-time divisor on matching
  // blocks. tier: 0 = bare hand, 1 wooden, 2 stone, 3 iron, 4 steel, 5 diamond — gates drops (MINE_REQ).
  [ITEM.WOODEN_SHOVEL]:  { name: 'Wooden shovel',   stack: 1, icon: 'wooden_shovel',  tool: 'shovel',  tier: 1, toolSpeed: 2,   durability: 40 },
  [ITEM.WOODEN_PICKAXE]: { name: 'Wooden pickaxe',  stack: 1, icon: 'wooden_pickaxe', tool: 'pick',    tier: 1, toolSpeed: 2,   durability: 40 },
  [ITEM.WOODEN_HATCHET]: { name: 'Wooden hatchet',  stack: 1, icon: 'wooden_hatchet', tool: 'hatchet', tier: 1, toolSpeed: 2,   durability: 40 },
  [ITEM.WOODEN_HOE]:     { name: 'Wooden hoe',      stack: 1, icon: 'wooden_hoe',     tool: 'hoe',     tier: 1, toolSpeed: 2,   durability: 40 },
  [ITEM.STONE_SHOVEL]:   { name: 'Stone shovel',    stack: 1, icon: 'stone_shovel',   tool: 'shovel',  tier: 2, toolSpeed: 4,   durability: 100 },
  [ITEM.STONE_PICKAXE]:  { name: 'Stone pickaxe',   stack: 1, icon: 'stone_pickaxe',  tool: 'pick',    tier: 2, toolSpeed: 4,   durability: 100 },
  [ITEM.STONE_HATCHET]:  { name: 'Stone hatchet',   stack: 1, icon: 'stone_hatchet',  tool: 'hatchet', tier: 2, toolSpeed: 4,   durability: 100 },
  [ITEM.STONE_HOE]:      { name: 'Stone hoe',       stack: 1, icon: 'stone_hoe',      tool: 'hoe',     tier: 2, toolSpeed: 4,   durability: 100 },
  [ITEM.IRON_SHOVEL]:    { name: 'Iron shovel',     stack: 1, icon: 'iron_shovel',    tool: 'shovel',  tier: 3, toolSpeed: 6,   durability: 300 },
  [ITEM.IRON_PICKAXE]:   { name: 'Iron pickaxe',    stack: 1, icon: 'iron_pickaxe',   tool: 'pick',    tier: 3, toolSpeed: 6,   durability: 300 },
  [ITEM.IRON_HATCHET]:   { name: 'Iron hatchet',    stack: 1, icon: 'iron_hatchet',   tool: 'hatchet', tier: 3, toolSpeed: 6,   durability: 300 },
  [ITEM.IRON_HOE]:       { name: 'Iron hoe',        stack: 1, icon: 'iron_hoe',       tool: 'hoe',     tier: 3, toolSpeed: 6,   durability: 300 },
  [ITEM.GOLDEN_SHOVEL]:  { name: 'Golden shovel',   stack: 1, icon: 'golden_shovel',  tool: 'shovel',  tier: 3, toolSpeed: 14,  durability: 60 },
  [ITEM.GOLDEN_PICKAXE]: { name: 'Golden pickaxe',  stack: 1, icon: 'golden_pickaxe', tool: 'pick',    tier: 3, toolSpeed: 14,  durability: 60 },
  [ITEM.GOLDEN_HATCHET]: { name: 'Golden hatchet',  stack: 1, icon: 'golden_hatchet', tool: 'hatchet', tier: 3, toolSpeed: 14,  durability: 60 },
  [ITEM.GOLDEN_HOE]:     { name: 'Golden hoe',      stack: 1, icon: 'golden_hoe',     tool: 'hoe',     tier: 3, toolSpeed: 14,  durability: 60 },
  [ITEM.DIAMOND_SHOVEL]: { name: 'Diamond shovel',  stack: 1, icon: 'diamond_shovel', tool: 'shovel',  tier: 5, toolSpeed: 10,  durability: 1000 },
  [ITEM.DIAMOND_PICKAXE]:{ name: 'Diamond pickaxe', stack: 1, icon: 'diamond_pickaxe',tool: 'pick',    tier: 5, toolSpeed: 10,  durability: 1000 },
  [ITEM.DIAMOND_HATCHET]:{ name: 'Diamond hatchet', stack: 1, icon: 'diamond_hatchet',tool: 'hatchet', tier: 5, toolSpeed: 10,  durability: 1000 },
  [ITEM.DIAMOND_HOE]:    { name: 'Diamond hoe',     stack: 1, icon: 'diamond_hoe',    tool: 'hoe',     tier: 5, toolSpeed: 10,  durability: 1000 },
// Useable
  [ITEM.BUCKET]:        { name: 'Bucket',        stack: 20, icon: 'bucket' },
  [ITEM.WATER_BUCKET]:  { name: 'Water Bucket',  stack: 1,  icon: 'water_bucket' },
  [ITEM.LAVA_BUCKET]:   { name: 'Lava Bucket',   stack: 1,  icon: 'lava_bucket'  },
  [ITEM.SNOWBALL]:      { name: 'Snowball',      stack: 30, icon: 'snowball', throwable: true },
 //plants
  [ITEM.SUGAR_CANE]:    { name: 'Sugar cane',    stack: 99, icon: 'sugarcane' },
  [ITEM.WHEAT]:         { name: 'Wheat',         stack: 99, icon: 'wheat' },
// Consumables
  [ITEM.APPLE]:         { name: 'Apple',          stack: 99, icon: 'apple',         foodSatFull: 3, food: 5,  foodSat: 8,  eatTime: 1.4 },
  [ITEM.MELON_SLICE]:   { name: 'Melon slice',    stack: 40, icon: 'melon_slice',   foodSatFull: 1, food: 1,  foodSat: 2,  eatTime: 1.0 },
  [ITEM.PUMPKIN_PIE]:   { name: 'Pumpkin Pie',    stack: 10, icon: 'pumpkin_pie',   foodSatFull: 6, food: 10, foodSat: 12, eatTime: 4 },
  [ITEM.MUSHROOM_STEW]: { name: 'Mushroom stew',  stack: 20, icon: 'mushroom_stew', foodSatFull: 5, food: 8,  foodSat: 10, eatTime: 2.2, foodReturn: 265 },
  [ITEM.BREAD]:         { name: 'Bread',          stack: 99, icon: 'bread',         foodSatFull: 4, food: 7,  foodSat: 6,  eatTime: 1.7 },
  [ITEM.GOLDEN_APPLE]:  { name: 'Golden apple',   stack: 30, icon: 'golden_apple',  foodSatFull: 8, food: 5,  foodSat: 15,  eatTime: 2.0 },
};

// blocks that only DROP when broken with the right tool type at (or above) a tier.
// Not listed = always drops. Block still breaks either way, just yields nothing.
const MINE_REQ = {
  [B.STONE]:       { tool: 'pick', tier: 1 },
  [B.COBBLE]:      { tool: 'pick', tier: 1 },
  [B.STONE_BRICK]: { tool: 'pick', tier: 1 },
  [B.BRICKS]:      { tool: 'pick', tier: 1 },
  [B.FURNACE]:     { tool: 'pick', tier: 1 },
  [B.COAL_ORE]:    { tool: 'pick', tier: 1 },
  [B.COPPER_ORE]:  { tool: 'pick', tier: 1 },
  [B.IRON_ORE]:    { tool: 'pick', tier: 2 },
  [B.TIN_ORE]:     { tool: 'pick', tier: 2 },
  [B.GOLD_ORE]:    { tool: 'pick', tier: 3 },
  [B.DIAMOND_ORE]: { tool: 'pick', tier: 3 },
  [B.SNOW]:        { tool: 'shovel', tier: 1 },
  [B.SULFUR_BLOCK]:    { tool: 'pick', tier: 2 },
  [B.SULFUR_DOWN_TIP]: { tool: 'pick', tier: 2 },
  [B.SULFUR_UP_TIP]:   { tool: 'pick', tier: 2 },
  [B.MARBLE]:      { tool: 'pick', tier: 1 },
  [B.GRANITE]:     { tool: 'pick', tier: 1 },
  [B.LIMESTONE]:   { tool: 'pick', tier: 1 },
};
// does the held item satisfy the block's drop requirement? (hand = tier 0, no tool type)
function mineDropAllowed(heldId, blockId) {
  const req = MINE_REQ[blockId];
  if (!req) return true;
  const p = heldId != null && heldId >= 256 ? ITEM_PROPS[heldId] : null;
  return !!(p && p.tool === req.tool && (p.tier || 0) >= req.tier);
}

// which blocks each tool class speeds up (material families, incl. their slab/stair forms)
const TOOL_BLOCKS = {
  shovel: new Set([B.SAND, B.RED_SAND, B.DIRT, B.GRASS, B.SNOW, B.SNOW_CARPET, B.CLAY, B.GRAVEL,]),
  pick:   new Set([B.STONE, B.COBBLE, B.COAL_ORE, B.IRON_ORE, B.DIAMOND_ORE, B.BRICKS, B.STONE_BRICK,
                   B.FURNACE, B.COBBLESLAB, B.BRICKSSLAB, B.BRICKSSTAIRS, B.STONE_BRICKSLAB, B.STONESLAB, B.GRASS, B.GLASSSLAB,
                   B.MARBLE, B.GRANITE, B.LIMESTONE,
                   B.SULFUR_BLOCK, B.SULFUR_DOWN_TIP, B.SULFUR_UP_TIP, B.TIN_ORE, B.COPPER_ORE, B.GOLD_ORE]),
  hatchet: new Set([B.LOG, B.PLANKS, B.BIRCH_LOG, B.BIRCH_PLANKS, B.MELON, B.PUMPKIN, B.CRAFTING_BENCH, B.DOOR, B.STAIRS, B.OAKSLAB, B.CACTUS, B.CACTUSSLAB]),
  hoe:    new Set([B.LEAVES, B.BIRCH_LEAVES, B.HAY]),
};
// mining-time divisor for held item vs block: 1.5 when the right tool, 1 otherwise
function toolFactor(heldId, blockId) {
  const p = heldId != null && heldId >= 256 ? ITEM_PROPS[heldId] : null;
  return (p && p.tool && TOOL_BLOCKS[p.tool] && TOOL_BLOCKS[p.tool].has(blockId)) ? p.toolSpeed : 1;
}

// Block drop table: block ID -> drop block ID (null = nothing, undefined = drop self)
const BLOCK_DROP = {
  [B.GRASS]: B.DIRT,
  [B.STONE]: B.COBBLE,
};

// Returns [{id, count}, ...] (empty array = no drops). isNatural=true uses lower leaf-decay probability.
function blockDrop(blockId, isNatural = false) {
  if (blockId === B.LEAVES || blockId === B.BIRCH_LEAVES) {
    const drops = [];
    const stickChance = isNatural ? 0.009 : 0.004;
    if (Math.random() < stickChance)
      drops.push({ id: ITEM.STICK, count: Math.floor(Math.random() * 3) + 1 });
    const appleChance = isNatural ? 0.002 : 0.0005;
    if (Math.random() < appleChance)
      drops.push({ id: ITEM.APPLE, count: 1 });
    // saplings from decayed/mined leaves: 2% natural, 0.1% player-broken. Matches the leaf type.
    const sapChance = isNatural ? 0.02 : 0.001;
    if (Math.random() < sapChance)
      drops.push({ id: blockId === B.BIRCH_LEAVES ? B.BIRCH_SAPLING : B.OAK_SAPLING, count: 1 });
    return drops;
  }
  if (blockId === B.COAL_ORE)    return [
    { id: ITEM.COAL,       count: 2 + Math.floor(Math.random() * 3) },
    { id: ITEM.COAL_CHUNK, count: 3 + Math.floor(Math.random() * 5) },
  ];
  if (blockId === B.IRON_ORE)    return [{ id: ITEM.RAW_IRON, count: 1 + Math.floor(Math.random() * 4) }];
  if (blockId === B.COPPER_ORE)    return [{ id: ITEM.RAW_COPPER, count: 1 + Math.floor(Math.random() * 6) }];
  if (blockId === B.TIN_ORE)    return [{ id: ITEM.RAW_TIN, count: 1 + Math.floor(Math.random() * 5) }];
  if (blockId === B.GOLD_ORE)    return [{ id: ITEM.RAW_GOLD, count: 1 + Math.floor(Math.random() * 3) }];
  if (blockId === B.DIAMOND_ORE) return [{ id: ITEM.DIAMOND,  count: 1 + Math.floor(Math.random() * 2) }];
  if (blockId === B.GRAVEL) {
    if (Math.random() < 0.05) return [{ id: ITEM.FLINT, count: 1 }];   
    return [{ id: B.GRAVEL, count: 1 }];
  }
  if (blockId === B.MELON) return [{ id: ITEM.MELON_SLICE, count: 2 + Math.floor(Math.random() * 5) }];
  if (blockId === B.WHEAT) return [{ id: ITEM.WHEAT, count: 1 + Math.floor(Math.random() * 2) }];
  if (blockId === B.TALLGRASS || blockId === B.TALL_LOWER || blockId === B.TALL_UPPER) return [];   // grass drops nothing
  if (blockId === B.GLASS) return [{ id: ITEM.GLASS_SHARD, count: 2 + Math.floor(Math.random() * 3) }];
  if (blockId === B.CLAY)  return [{ id: ITEM.CLAY_BALL, count: 4 }];
  if (blockId === B.SNOW)  return [{ id: ITEM.SNOWBALL,  count: 2 + Math.floor(Math.random() * 3) }];
  if (blockId === B.SNOW_CARPET) return [{ id: B.SNOW_CARPET, count: 1 }];   // full carpet regardless of layers
  if (blockId === B.SUGAR_CANE) return [{ id: ITEM.SUGAR_CANE, count: 1 }];
  if (blockId === B.OAK_SAPLING || blockId === B.BIRCH_SAPLING) return [{ id: blockId, count: 1 }];
  if (blockId === B.SULFUR_DOWN_TIP || blockId === B.SULFUR_UP_TIP) {
    // legacy DOWN_TIP still drops sulfur so terrain-generated tips work; both variants of the
    // canonical SULFUR_UP_TIP block also drop sulfur only (never the tip back)
    const n = Math.floor(Math.random() * 3);   // 0..2
    return n > 0 ? [{ id: ITEM.SULFUR, count: n }] : [];
  }
  const override = BLOCK_DROP[blockId];
  if (override === undefined) return [{ id: blockId, count: 1 }];
  if (override === null)      return [];
  return [{ id: override, count: 1 }];
}
