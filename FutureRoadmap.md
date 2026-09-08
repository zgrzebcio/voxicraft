legends: B = big update, M= medium update, S = small update

1. B: ~~procedural caves, and darker underground~~. v0.05
2. M: ~~different mined drops~~. v0.052
3. M: ~~first item as stick drop from leaves 2% 1-3, make leaves breaks if is not close connect between other leaves any log then drop is increase to 7%~~ v0.06
4. B: ~~Hands to player with function holding block item and light source make light but 50% weaker than placed~~. v0.07
5. M: ~~new item as first consumable apple drop 1 from leaves 0.2% when break by player but 1% on break disappear~~. v0.732
6. M: ~~caves ore with own chance and amount~~. v0.054
7. S: ~~mined ore own drops~~ v0.055
8. B: ~~saving system with load system on world and inventory~~. v0.04
9. S: ~~new item as snowball as throwable, clay and flint~~. v0.081
10. M: ~~new gravel block and sand with falling physics~~. v0.08
11. M: ~~new block as are mushrooms as first plant billboard block~~. v0.082
12. S: ~~brown mushroom.~~ v0.083
13. S: s~~aturation stats~~. v0.084
14. M: ~~update water texture and water filling~~. v0.09
15. M: ~~oxygen stats, with better swim, 0.093~~. v0.092
16. S: ~~update vital icons heart oxygen hunger~~. v0.095
17. M: ~~water deep biome and dark water lightning~~. v0.096
18. B: ~~crafting system, with vertical crafting list be basic list and advanced with new and first interactable block as crafting bench~~. v0.1
19. B: ~~furnace block and smelting system with first block animation~~. v0.2
20. M: ~~torch block with own model light source~~ 10. v0.13
21. M: ~~cactus block with new red sand desert biome~~.  v0.22
22. S: ~~better respawn and dying mechanic~~. v0.23
23. B: ~~block rotation~~. v0.3
24. M: ~~first interaction and changing rotating block different by as oak doors~~. v0.31
25. S: ~~planks and cobblestone stairs~~, ~~and cobblestone slab.~~ v0.032
26. S: ~~Sneak mechanic~~. v0.33
27. M: ~~connecting slab, and stone brick block with slabs~~. v0.36
28. S: ~~connecting stair to rotate,~~ ~~more stairs like stone brick~~. v0.37
29. B: ~~tools with own durability, stack up only 1~~. v0.4
30. S: ~~crafting category update~~ v0.41
31. M: ~~tools tiers use to faster mine specific blocks~~. v0.42
32. S: ~~simple background music~~. 0.421
33. M: ~~increase leaves decay by adding random tick speed with grass spread to dirt~~ v0.44
34. S: ~~bucket to fill with water and placing water~~. v0.43
35. S: ~~pumpkin, wheat and more food~~ v0.45
36. M: ~~new wood variant birch with new biome~~ 0.46
37. M: ~~hoe, hay block~~. 0.47
38. B: ~~canyons, Caves block update~~ v0.5
39. M: ~~fix canyon and more cave entrance~~ v0.51
40. M: ~~Lake better rivers, and small ponds.~~ v0.52
41. M: ~~grass and popy and sunflower, orchid flowers.~~ 0.53
42. M: ~~new biome and blocks~~ v0.54
43. M: ~~more caves ore tin/copper/gold~~ v0.55
44. M: ~~lava pools on top and in caves~~. v0.56
45. M: ~~snow carpet in snow biome with new snow biome~~. 0.57
46. M: ~~sulfur~~, ~~gunpowder and TNT with explosion~~. v0.58
47. M: ~~sapling, sugarcane and growing system~~. 0.59
48. M: ~~obsidian block with fluid connecting to create obsidian and stone~~. 0.595
49. B: ~~first mob as player so with own inventory and are neutral as enemy~~. v0.6
50. S: ~~make creative inventory scrollable with more space~~. v0.605
51. M: ~~weapon like sword with damage system~~. v0.61
52. S: ~~make crafting variant~~ v0.615
53. M: ~~new mob: sheep with mutton and wool block and shears tool and string~~. v0.62
54. M: ~~bed with sleep through night~~. 0.63
55. M: ~~chest and inventory transferring and item manage~~. v0.64
56. S: ~~tooltip in inventory and sorting~~. v0.645
57. M: ~~armor system, and defense cloth and iron armor~~. v0.65
58. S: ~~simple sound effect~~ v0.655.
59. M: ~~belt with accessories~~. v0.66
60. S: ~~flat terrain mostly for testing~~. v0.665
61. M: ~~dynamic tree and leaf carpet~~. v0.67
62. S: ~~more tree type spruce and dynamic cactus~~ v0.675
63. M: ~~Structure system.~~ v0.68
64. M: ~~increase performance by structure chunk and lightning~~ v0.685
65. M: ~~fiber, cloth and pickable grass~~. v0.695
66. B: ~~leveling system~~. v0.7
67. S: ~~xp popup fixed a lot bugs~~. v0.705
68. M: ~~update spawning system~~. 0.71
69. M: ~~hostile mobs like zombie with animations~~. v0.715
70. M: ~~split screen with profile~~ v0.72
71. S: ~~more split screen future and a lot bug fixed~~ v0.725
72. M: ~~cow, leather, beef, saddle and crafting leather armor~~. v0.73
73. S: horse and taming and riding them.  0.735
74. M: bow arrow and skeleton drop bone and arrow v0.74
75. S: shield with protect from in front incoming damage v0.745
76. M: backpack system and item input display and how got and where or from or lose how. v0.75
   # ALSO: raise ATLAS_COLS 10 -> 16 here (100 -> 256 tile slots). Currently 92/100 used.
   # 16 = 2048px sheet, ~21MB with mipmaps. 20 would be 2560px / ~35MB — too heavy for phones.
   # Nothing before 0.75 needs atlas tiles (horse/skeleton are entity sheets, arrow/bone/shield
   # are item textures), so this is the last quiet slot before the block-heavy updates.
   # The atlas cache key already carries ATLAS_COLS x tile count, so stale sheets self-invalidate.
77. S: update inventory by adding sorting and transferring and pulling and quick transfer. v0.755
78. M: updating crafting system by add queue and time to craft. v0.76
   # absorbs 79 below — queue, craft time, blueprints and rarity are all one crafting pass
79. S: crafting blueprint and weapon rarity v0.765
   # MERGED into 78. Nothing dropped, just delivered together. Frees the 0.765 slot for:
   # M: skill tree — spend levels. v0.765
   # Placed here because levels have existed since 0.7 with nothing to spend them on (21 versions
   # of dead currency if it waits for 0.915), and by 0.765 there is enough to hang nodes on:
   # sword, bow, shield, five tool tiers, two armour sets, hunger, XP from ores/mobs/crafting.
   # Also lands right after the 0.755 inventory UI pass, so the panel work batches with it.
80. M: mortale and pestle with powder ores and bronze v0.77
81. S: pig, chicken. v0.775
82. M: add chisel and make different type blocks, slab, stairs, pane, fences, hollow logs. v0.78 
   # Shape lives in the VARIANT byte, not a new block id (the Aloumeria hammer model). The voxel
   # packs the id in the low byte — 103 sites do `& 255` — so there are only 255 block ids ever,
   # and slab/stair/pane/fence/hollow across ~6 woods and ~8 stones would eat ~70 of them.
   # As variants it costs 0 new ids and 0 new atlas tiles: shapes reuse the parent's texture,
   # and blockDrop / mineDropAllowed keep working off the one material entry.
   # Re-enables the slabs and stairs disabled in 0.7295 — flip DISABLED_BLOCKS in 13-actions.js.
   # Shape 0 = the plain block, so every block in an old save is already a valid shape-0 block.
   # Old saves are blocked from loading at this version anyway, which settles the migration.
83. S: updating furnace recipes v0.785
84. M: spider cobweb and glow vines, a lot missing item adding 0.79
   # skill node ships here with the spider: "spider don't see you in night"
   # also the slot for emerald + ingot blocks + the rest of the missing items
85. S: more billboard and blocks 0.795
86. B: Particles system v0.8
   # Give it a hard pool cap and a per-frame budget from day one — phones are the constraint,
   # and it has to emit per viewport in split screen (see the layer notes in 06-renderer.js).
87. S: fishes: cod, pike, salmon, marrow v0.805
   # -> M, and add BOATS + FISHING ROD here. Both vanished from the list in the last edit
   # (0.99 is multiplayer now), and both are still in the utilities line at the bottom.
   # Their natural home is next to the fish anyway.
88. M: weather and season system. v0.81
89. S: cloud with dark version v0.815
90. M: drinking and temperature system. v0.82
91. S: heatstroke and sandstorm weather. v0.825
92. M: rain weather and snowing with snow carpet block v0.83
93. S: ice block new mores biomes winter season. v0.835
94. M: desert biome update with palm tree. v0.84
95. S: hellhound spawning in desert v0.845
96. M: jungle biome with jungle tree and cocoa beam. v0.85
97. S: bear territorial , fat, quality oil v0.855
98. M: bamboo biome  with bamboo trees. v0.86
99. S: panda bear version but neutral.  v0.865
100. M: swamp biome with mangrove trees. v0.87
101. S: add kelp underwater 0.875
102. M: cherry update with cherry tree. v0.88
103. S: compass map spyglass with them functions 0.885
104. M: farming system with seed and more plants. v0.89
105. S: growing visual system v0.895
106. B: electric update add new ore and generator with full electric system v0.9
107. S: steel with infuser machine v0.905
108. M: volcano biome with a lot new block like blackstone, quartz ore with black quartz item 0.91
109. S: small and simple skill trees 0.915
   # RE-AIMED (the base tree moved to 0.765): this becomes skill tree part 2 — the COMBAT
   # category (melee damage, bow damage / draw speed, knockback resist, armour durability save)
   # plus the machine and electric nodes, added once there is machine content to branch into.
110. M: electric furnace and fabricator machine with electric crafting, polymer and carbon fiber items v0.92
111. S: resin, rubber, extractor tool and extractor machine v0.925
112. M: bio fuel with bio generator and solar generator and wind generator v0.93
113. S: electric cables and batteries v0.935
114. M: crusher and ore powder v0.94
115. S: electric mortal and pestle v0.945
116. M: Pipe for fluid and item transfer v0.95
117. S: fluid tank and item barrel v0.955
118. M: oil fluid and fluid pump v0.96
119. S: machine upgrades v0.965
120. M: potion system update v0.97
121. S: tool upgrades station v0.975
122. M: adding more flower and dyes and paint system v0.98
123. S: adding missing items and blocks v0.985
124. M: multiplayer 0.99
   # Replication is done HERE, in this one update — not drip-fed into earlier systems.
   # Split screen already built half of it: per-player context slots, per-player HUD and
   # inventory, a profile-keyed roster that persists per world, N players ticking in sequence.
   # That layer is reusable. What this update adds is a transport plus making world mutation
   # replicable — `setBlock` is already the single choke point for blocks, so entity and
   # machine state are the parts to keep tidy as they are built between now and here.
125. S: visual update like grass, water blending between biome v0.995
126. B: sound effect with polishing fully performance and textures 1.0 FULL GAME! as beta version
127. B: Achievements update 1.1
128. B: animal update — breeding, gender, growing sizes, per-animal stats. v1.5
   # more textures per animal, male/female, babies that grow, and stats that differ per
   # individual: health, move speed, jump boost on a horse, production or drop rate on farm
   # animals. Its own big update rather than a node bolted onto husbandry.
   # Already in place: the cow proves per-individual appearance works — `variant` is rolled at
   # spawn, persisted, and _cowTexture caches sheets by name, so more sheets is trivial. Model
   # scale for baby/adult is one line on m.root.
   # The one thing to restructure: serializeEntities writes a POSITIONAL array, currently 12
   # fields ([x,y,z,yaw,hp,name,inv,hx,hz,kind,woolly,variant]). Gender + age + several stats
   # per animal takes that past readable — switch it to an object at the same time.
   # Also: speed is a per-KIND constant today (COW_SPEED, SHEEP_SPEED, read in _updateGrazer).
   # Per-individual stats means moving it onto the entity, like `hp` already is.
   # 1.1 -> 1.5 is unplanned space for now.













Final to beta version:

* 100 different item:

  1. 30\~ resources: stick, coal, diamond, emerald, feather, flint, clay, energetic, fiber, cloth, leather, quartz, black quartz, gunpowder,
glow dust, bone, string, polymer, fat, bio fuel, quality oil, iron, copper, tin, bronze, gold, steel, sugar, paper, wood bark, sulfur, carbon fiber.
* 6 ingot: iron, copper, tin, bronze, gold, steel.
* 6 chunks/raw: coal, iron, copper, tin, gold, quartz.
* 6 nugget: iron, copper, tin, bronze, gold, steel.
* 6 powder: iron, copper, tin, bronze, gold, steel.

  2. 10 usable: bucket, battery, saddle, glass bottle, egg, snowball, bowl, exp bottle, fire charge.
  3. 9 utilities: compass, clock, spyglass, note map, shears, fishing rod, belt, backpack, boat.
  4. 11 dyes: red, blue, yellow, green, black, white, orange, pink, gray, purple, brown.



* 100 different block:
* 20 different plants: grass, mushroom, poppy, wheat, carrot, potato, sugar cane, bamboo, kelp, cocoa beans, vines, fern, bush, dry bush, saplings, daisy, sunflower, orchid, black rose,
* 30 different consumable: apple, golden apple, mushroom soup, pork, steak, mutton, chicken, bread, cookie, pumpkin pie, apple pie, carrot, bake potato, vegetables cake, berry,

&#x20;sweet cake, tomato, burger, melon, salmon, cod, pike, rotten flesh, dried kelp,



* 10 different mobs: cow, pig, chicken, skeleton, zombie, horse, bear with panda version, hellhound, sheep, spider
* 6 types of weapon and tool variants(sword, pickaxe, hatchet, shovel, hoe ,bow)-(flint ,stone ,iron ,bronze/steel ,diamond, advanced/electric)
* armor: leather(cold protection), cloth(hot protection), iron, bronze, diamond, advanced/electric



skill: (v0.765, more in future)

Survival:
* health boost
* hunger depletion speed
* water depletion speed

Crafting:
* chance to not loose durability on newest tools
* chance to craft more ammo
* faster crafting
* less slow penalty (while crafting player be move slower)

Husbandry:
* chance to horse or other future tamable animal are faster tame
* killing animal drop more loot
* spider don't see you in night
* food and potion effect work longer
* your plot grow faster

Exploring:
* loot chest are chance to give more item in
* more loot from ores
* get less damage from hazard source (fall, cactus, fire, lava, explosion, temperature)
* temperature resist

# ---- notes on the list above ----
# POINT BUDGET is the thing to settle first. xpToNext is 40 x 3^lvl, so levels cost
# 40 / 120 / 360 / 1080 / 3240 — reaching level 5 is 4840 XP when an ore is 14-70 and a mob is 25.
# At one point per level a player realistically ends a long playthrough with 4-6 points, against
# 16 nodes here. Two ways to read that, both fine, but pick one before building the UI:
#   (a) keep the x3 curve — the tree is a CHOICE, not a checklist. Then every node has to be
#       worth a whole level, and single-rank. That fits the harsh design and needs no change.
#   (b) flatten to x2, or give 2-3 points per level, if the tree should fill up over time.
# Under (a) the nodes must be roughly EQUAL in value, and right now they are not:
# "health boost" against "chance to craft more ammo" is not a fair trade for the same point.
#
# RULE: a node ships WITH the update that adds its function. The tree starts small at 0.765 with
# only the live nodes and grows every time a system lands — no greyed-out rows waiting for 0.82.
# Nodes waiting on their system: water depletion (thirst, 0.82) . temperature resist (0.82)
#   plot growth (farming, 0.89) . potion duration (0.97) . spider stealth (0.79)
#   craft more ammo (arrows, 0.74, so live by 0.765)
#
# DECIDED:
# - COMBAT category -> part 2 (0.915), not the base tree.
# - Mining stays split as it is: Crafting = what you MAKE, Exploring = what you FIND. So the
#   durability node is Crafting and the ore node is Exploring. Coherent, no change.
# - "durability on NEW crafted tools, not old ones" -> the bonus is baked into the item when it
#   is crafted, not read live from the tree. That needs a flag on the slot next to `dur`
#   (mkSlot in 13-actions.js), and it must survive a save like `dur` does. Nice side effect:
#   the tool you made before the skill stays honest, and a lucky tool is a real object.
# - "spider don't see you in night" ships in 0.79 with the spider, as its own node.
# - temperature resist from the tree adds into the SAME player stat armour feeds, through the
#   _equipSum pipeline in 31-armor.js (coldResist / heatResist). Two sources, one number.
#
# TWO MORE PER CATEGORY — one live at 0.765, one for later.
# Survival
#   now:    hold breath longer (the 15s air drain + MAX_AIR in updateVitals). A third HP node
#           would overlap health boost; oxygen is a separate axis and already fully built.
#   later:  dark adaptation — see further underground. Fits the darker-caves pillar (item 1).
# Crafting
#   now:    furnace efficiency — fuel lasts longer or smelts finish faster (SMELT_TIME /
#           FUEL_SMELTS in 26-furnace.js). Live today, and clearly "things you make".
#   later:  tool upgrade station costs less material / better upgrade odds (0.975).
# Husbandry
#   now:    tended animals and plants recover faster — sheep fleece regrow (SHEEP_REGROW) and
#           berry bush stages (BERRY_STAGE_LIFE). Two existing timers, one node.
#   later:  faster breeding / better odds — ships with the animal update at 1.5 (item 128),
#           which is where breeding, gender, growth and per-animal stats all land together.
# Exploring
#   now:    move faster. playerMoveSpeedMul (31-armor.js) already sums additive contributions,
#           so this is one more source in a pipeline that exists — same shape as temperature.
#   later:  the compass points to the nearest structure (0.885). Structures already exist, so
#           this is only the pointing.
#
# HOOKS that already exist, so these nodes are cheap:
#   hazard damage    -> armorDamageMultiplier (31-armor.js)
#   loot chest bonus -> rollLootInto (34-structures.js)
#   animal loot      -> _entDropLoot (28-entities.js)
#   durability save  -> the single tool-wear site in the mining path (22-main-loop.js)
#   hunger rate      -> updateVitals (19-vitals.js)

