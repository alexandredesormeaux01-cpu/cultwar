paintMat.onBeforeCompile = (shader) => {
  paintMat.userData.shader = shader;
  shader.uniforms.uTime = monkTimeU;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uTime;

vec2 paintHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

float paintVoronoiEdge(vec2 uv) {
  vec2 n = floor(uv);
  vec2 f = fract(uv);
  float md = 8.0;
  float md2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = paintHash2(n + g);
      o = 0.5 + 0.5 * sin(uTime * 0.12 + 6.2831 * o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md2 = md; md = d; }
      else if (d < md2) { md2 = d; }
    }
  }
  return sqrt(md2) - sqrt(md);
}
`)
    .replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec2 uv = vMapUv;
        float t = uTime;
        float px = ${(1.0 / 192).toFixed(6)};

        // Pas de flou 3x3 : il inventait un halo bleu hors des tuiles
        vec4 tex = texture2D(map, uv);
        float a = tex.a;
        if (a < 0.04) discard;

        // Anti-alias léger sans expansion
        float aa = fwidth(a) * 1.25;
        float cover = smoothstep(0.04, 0.04 + max(aa, 0.08), a);

        vec3 baseColor = tex.rgb;
        float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = mix(vec3(luma), baseColor, 1.25);
        baseColor = mix(baseColor, vec3(1.0), 0.08);

        float height = pow(cover, 0.65);

        float cellScale = 110.0;
        float ve = paintVoronoiEdge(uv * cellScale);
        float vein = 1.0 - smoothstep(0.010, 0.040, ve);
        float veinCore = 1.0 - smoothstep(0.0, 0.018, ve);
        float veS = paintVoronoiEdge(uv * cellScale + vec2(0.22, 0.28));
        float veinShadow = (1.0 - smoothstep(0.010, 0.055, veS)) * (1.0 - vein);

        float caustic = sin(uv.x * 90.0 + uv.y * 68.0 + t * 0.55)
                      * sin(uv.x * 55.0 - uv.y * 75.0 - t * 0.35);
        caustic = caustic * 0.5 + 0.5;

        vec3 col = baseColor * (0.84 + 0.16 * height);
        col *= 1.0 - veinShadow * 0.10;
        col = mix(col, vec3(1.0), vein * 0.22 + veinCore * 0.12);
        col += baseColor * caustic * 0.04 * height;
        col += vec3(veinCore * 0.06);

        diffuseColor.rgb = col;
        diffuseColor.a *= cover * (0.62 + 0.28 * height);
      #endif
    `);
};
paintMat.customProgramCacheKey = () => 'paint-water-tight-v11';
paintMat.needsUpdate = true;