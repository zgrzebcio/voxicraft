'use strict';
/* voxiCraft — shared shader (VSH/FSH), uniforms, three materials */

/* ================================================================================================
   MATERIALS — one shared shader for all three passes. The `tile` vertex attribute selects
   the atlas cell; UVs are in tile units and wrapped with fract() in the fragment shader,
   with explicit textureGrad derivatives so mip selection stays continuous across the wrap.
   ================================================================================================ */
THREE.ColorManagement.enabled = false;   // raw sRGB passthrough — pixels match the source art

const SKY = new THREE.Color(0x8fc8ee);
const sharedUniforms = {
  map:        { value: null },
  fogColor:   { value: SKY.clone() },
  fogNear:    { value: 80 },
  fogFar:     { value: 150 },
  // day/night lighting + shadow mapping (defaults sum to 1.0 so block icons render neutral)
  uShadowMat:  { value: new THREE.Matrix4() },
  tShadS:      { value: null },              // depth map: solid blocks (full shadows)
  tShadL:      { value: null },              // depth map: leaves/glass (soft, low intensity)
  uAmbient:    { value: 0.30 },
  uDirect:     { value: 0.70 },
  uLeafShadow: { value: 0.45 },              // how much direct light a leaf shadow removes
  uShadowOn:   { value: 0 },
  uLightColor: { value: new THREE.Color(1, 1, 1) },
  uGlowColor:  { value: new THREE.Color(1.0, 0.82, 0.45) },   // warm glowstone block-light tint
  uTime:       { value: 0 },
};
const GLOW_LEVEL = 14;   // glowstone emission (light reaches this many blocks through open air)

const VSH = /* glsl */`
  in float tile;
  in float shade;
  in float blockLight;
  uniform mat4 uShadowMat;
  out vec2 vUv;
  flat out float vTile;
  out float vShade;
  out float vDepth;
  out float vBlock;
  out vec3 vSC;
  void main() {
    vUv = uv; vTile = tile; vShade = shade;
    vBlock = blockLight;                      // flood-filled block-light level (0..15) for this face
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vSC = (uShadowMat * wp).xyz;             // position in the shadow map's [0,1] space
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const FSH = /* glsl */`
  uniform sampler2D map;
  uniform vec3 fogColor;
  uniform float fogNear, fogFar;
  uniform highp sampler2DShadow tShadS;
  uniform highp sampler2DShadow tShadL;
  uniform float uAmbient, uDirect, uLeafShadow, uShadowOn;
  uniform vec3 uLightColor;
  uniform vec3 uGlowColor;
  uniform float uTime;
  in vec2 vUv;
  flat in float vTile;
  in float vShade;
  in float vDepth;
  in float vBlock;
  in vec3 vSC;
  out vec4 fragColor;
  // soft 5-tap PCF: spreads the shadow edge across a few texels so the small per-update
  // sub-texel shifts of the moving sun read as a smooth gradient crawl, never a hard flicker
  // (and gives chunky, low-detail soft shadows that suit the voxel look)
  float pcf(highp sampler2DShadow s, vec2 uv, float d) {
    const float t = 1.7 / 1024.0;
    return 0.2 * (texture(s, vec3(uv, d))
      + texture(s, vec3(uv + vec2( t,  t), d)) + texture(s, vec3(uv + vec2(-t,  t), d))
      + texture(s, vec3(uv + vec2( t, -t), d)) + texture(s, vec3(uv + vec2(-t, -t), d)));
  }
  void main() {
    // atlas is a COLS×COLS grid; each 1/COLS cell samples its centre 0.5/COLS window
    // (the surrounding 0.25/COLS ring is a wrapped mip gutter). flipY canvas layout.
    const float COLS = ${ATLAS_COLS}.0, CELL = 1.0 / ${ATLAS_COLS}.0;
    float col = mod(vTile, COLS);
    float row = floor(vTile / COLS + 0.001);
    vec2 off = vec2(col * CELL + CELL * 0.25, 1.0 - (row + 0.75) * CELL);
    vec2 sc  = vec2(CELL * 0.5);
    vec2 wUV = int(vTile + 0.5) == 11
      ? fract(vUv + vec2(uTime * 0.04, uTime * 0.025))
      : fract(vUv);
    vec4 tex = textureGrad(map, off + wUV * sc, dFdx(vUv) * sc, dFdy(vUv) * sc);
    if (tex.a < 0.02) discard;
    // sun/moon shadows: soft PCF compare against the two depth maps; outside the shadow
    // window (far from the player) everything counts as lit
    float sS = 1.0, sL = 1.0;
    if (uShadowOn > 0.5 && vSC.x > 0.01 && vSC.x < 0.99 && vSC.y > 0.01 && vSC.y < 0.99 && vSC.z < 0.999) {
      float d = vSC.z - 0.0003;   // constant bias; slope acne handled by polygonOffset on the maps
      sS = pcf(tShadS, vSC.xy, d);
      sL = pcf(tShadL, vSC.xy, d);
    }
    float direct = uDirect * sS * (1.0 - uLeafShadow * (1.0 - sL));
    // packed light byte: low nibble = flood-filled block light (glow), high nibble = sky light.
    // Sky scales the sun's contribution so caves go genuinely dark; glow is sun-independent
    // and still lights caves & night. Curves kept gentle so level-14 faces aren't blown out.
    float skyN = floor(vBlock / 16.0 + 0.001);
    float bl = (vBlock - skyN * 16.0) / 15.0;
    float sky = skyN / 15.0;
    // quadratic falloff, but off a higher floor: unlit faces now bottom out at 24% of daylight
    // instead of 12%, so shadowed sides and cave mouths stay readable rather than near-black
    float skyF = 0.24 + 0.76 * sky * sky;
    // part-linear curve: light-source edges (low levels) stay visibly bright instead of
    // quadratic-fading to black; peak slightly above the old 1.15
    vec3 block = uGlowColor * (bl * 0.45 + bl * bl * 0.85);
    vec3 lit = tex.rgb * vShade * (uLightColor * (uAmbient + direct) * skyF + block);
    float fog = smoothstep(fogNear, fogFar, vDepth);
    fragColor = vec4(mix(lit, fogColor, fog), tex.a);
  }`;

// Water-specific vertex shader: sinusoidal Y-wave on top faces (shade ≈ 1.0)
const VSH_WATER = /* glsl */`
  in float tile;
  in float shade;
  in float blockLight;
  uniform mat4 uShadowMat;
  uniform float uTime;
  out vec2 vUv;
  flat out float vTile;
  out float vShade;
  out float vDepth;
  out float vBlock;
  out vec3 vSC;
  void main() {
    vUv = uv; vTile = tile; vShade = shade;
    vBlock = blockLight;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // Waving surface vertices are marked with shade 253/255 by emitWater; every vertex of one
    // waving cell carries the SAME light byte, so top quad and side-quad top edge stay welded.
    if (shade > 0.985) {
      /* EVERY term here must be a pure function of world position and time — never of per-cell
         data such as blockLight. Adjacent water cells share their edge vertices but are drawn as
         separate quads, so a per-cell amplitude makes the two sides of a shared edge displace by
         different amounts and rips the surface open into thin transparent slits. (Depth-scaled
         amplitude did exactly that; depth still drives the surface COLOUR, which is per-cell and
         harmless.) A low-frequency swell field varies wave height across the ocean instead: it is
         smooth in world space, so both sides of any shared edge always agree. */
      float swell = 0.65 + 0.35 * sin(wp.x * 0.035 + 1.7) * cos(wp.z * 0.028 - 0.9);
      float amp = 0.085 * swell;
      // three octaves at low spatial frequency: long rolling swells rather than fast ripples,
      // with a diagonal cross-wave so the pattern never looks like a plain grid
      wp.y += sin(wp.x * 0.55 + uTime * 1.5) * amp
            + cos(wp.z * 0.42 + uTime * 1.15) * amp * 0.75
            + sin((wp.x + wp.z) * 0.9 + uTime * 2.4) * amp * 0.35;
    }
    vSC = (uShadowMat * wp).xyz;
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

function makeMat(opts) {
  const { vertexShader: vs, ...rest } = opts;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: sharedUniforms,
    vertexShader: vs || VSH,
    fragmentShader: FSH,
    ...rest,
  });
}
const matOpaque = makeMat({});
const matCutout = makeMat({ transparent: true, depthWrite: true, side: THREE.DoubleSide }); // leaves + glass
                                              // double-sided: standing inside a bush you see the
                                              // canopy shell around you instead of x-raying out
const matWater  = makeMat({ transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexShader: VSH_WATER }); // water with wave
// Lava: opaque fluid with slow surface wave; always emissive (lite=255 hardcoded in emitLava)
const VSH_LAVA = /* glsl */`
  in float tile;
  in float shade;
  in float blockLight;
  uniform mat4 uShadowMat;
  uniform float uTime;
  out vec2 vUv;
  flat out float vTile;
  out float vShade;
  out float vDepth;
  out float vBlock;
  out vec3 vSC;
  void main() {
    vUv = uv; vTile = tile; vShade = shade;
    vBlock = blockLight;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    if (shade > 0.985) {
      wp.y += sin(wp.x * 0.55 + uTime * 0.45) * 0.045
            + cos(wp.z * 0.45 + uTime * 0.35) * 0.03;
    }
    vSC = (uShadowMat * wp).xyz;
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const matLava = makeMat({ vertexShader: VSH_LAVA });
const MATERIALS = [matOpaque, matCutout, matWater, matLava];

