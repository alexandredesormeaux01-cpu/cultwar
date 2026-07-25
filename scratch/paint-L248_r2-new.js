    .replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec2 uv = vMapUv;
        float t = uTime;
        float px = ${(1.2 / 192).toFixed(6)};

        vec4 tex = texture2D(map, uv);
        float a = tex.a;
        if (a < 0.04) discard;
        float aa = fwidth(a) * 1.8;
        float cover = smoothstep(0.04, 0.04 + max(aa, 0.16), a);

        vec3 baseColor = tex.rgb;
        float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = mix(vec3(luma), baseColor, 1.28);
        baseColor = mix(baseColor, vec3(1.0), 0.10);

        // Volume doux — pas de halo sombre sur le contour
        float height = pow(smoothstep(0.06, 0.92, a), 0.75);
        float rim = smoothstep(0.06, 0.32, a) * (1.0 - smoothstep(0.38, 0.78, a));

        float hL = texture2D(map, uv - vec2(px * 2.0, 0.0)).a;
        float hR = texture2D(map, uv + vec2(px * 2.0, 0.0)).a;
        float hD = texture2D(map, uv - vec2(0.0, px * 2.0)).a;
        float hU = texture2D(map, uv + vec2(0.0, px * 2.0)).a;
        vec3 nrm = normalize(vec3((hL - hR) * 3.2, (hD - hU) * 3.2, 0.32 + height * 0.45));

        vec3 lightDir = normalize(vec3(0.55, 0.75, 1.0));
        float ndl = max(0.0, dot(nrm, lightDir));
        float wrap = ndl * 0.40 + 0.60;
        float ao = mix(0.90, 1.0, height);
        float spec = pow(ndl, 18.0) * (0.16 + 0.40 * height);

        float cellScale = 110.0;
        float ve = paintVoronoiEdge(uv * cellScale);
        float vein = 1.0 - smoothstep(0.010, 0.040, ve);
        float veinCore = 1.0 - smoothstep(0.0, 0.018, ve);
        float veS = paintVoronoiEdge(uv * cellScale + vec2(0.22, 0.28));
        float veinShadow = (1.0 - smoothstep(0.010, 0.055, veS)) * (1.0 - vein);

        float caustic = sin(uv.x * 90.0 + uv.y * 68.0 + t * 0.55)
                      * sin(uv.x * 55.0 - uv.y * 75.0 - t * 0.35);
        caustic = caustic * 0.5 + 0.5;

        vec3 col = baseColor * wrap * ao;
        col *= 0.88 + 0.12 * height;
        col = mix(col, baseColor * 1.08, height * 0.22);
        // Liseré clair (gel), pas de foncé
        col = mix(col, mix(baseColor, vec3(1.0), 0.45), rim * 0.28);
        col *= 1.0 - veinShadow * 0.08;
        col = mix(col, vec3(1.0), vein * 0.26 + veinCore * 0.14);
        col += baseColor * caustic * 0.045 * height;
        col += vec3(spec * 0.32);
        col += vec3(veinCore * 0.07);

        diffuseColor.rgb = col;
        diffuseColor.a *= cover * (0.70 + 0.20 * height + 0.06 * veinCore);
      #endif
    `);
};
paintMat.customProgramCacheKey = () => 'paint-water-gel-v13';
paintMat.needsUpdate = true;