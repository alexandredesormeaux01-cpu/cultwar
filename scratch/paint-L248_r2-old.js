    .replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec2 uv = vMapUv;
        float t = uTime;
        float px = ${(1.2 / 192).toFixed(6)};

        // Couverture = alpha réelle (pas de flou qui crée un halo hors tuile)
        vec4 tex = texture2D(map, uv);
        float a = tex.a;
        if (a < 0.05) discard;
        float aa = fwidth(a) * 1.5;
        float cover = smoothstep(0.05, 0.05 + max(aa, 0.12), a);

        vec3 baseColor = tex.rgb;
        float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = mix(vec3(luma), baseColor, 1.35);
        baseColor = mix(baseColor, vec3(1.0), 0.12);

        // Volume / dôme
        float height = pow(smoothstep(0.08, 0.95, a), 0.7);
        float rim = smoothstep(0.08, 0.28, a) * (1.0 - smoothstep(0.35, 0.7, a));

        float hL = texture2D(map, uv - vec2(px * 2.0, 0.0)).a;
        float hR = texture2D(map, uv + vec2(px * 2.0, 0.0)).a;
        float hD = texture2D(map, uv - vec2(0.0, px * 2.0)).a;
        float hU = texture2D(map, uv + vec2(0.0, px * 2.0)).a;
        vec3 nrm = normalize(vec3((hL - hR) * 4.0, (hD - hU) * 4.0, 0.25 + height * 0.5));

        vec3 lightDir = normalize(vec3(0.55, 0.75, 1.0));
        float ndl = max(0.0, dot(nrm, lightDir));
        float wrap = ndl * 0.55 + 0.45;
        float ao = mix(0.72, 1.0, height);
        float spec = pow(ndl, 20.0) * (0.22 + 0.55 * height);
        float fresnel = pow(1.0 - max(0.0, nrm.z), 2.2);

        // Nervures eau (Voronoi)
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
        col *= 0.80 + 0.20 * height;
        col *= 1.0 - rim * 0.10;
        col = mix(col, baseColor * 1.12, height * 0.28);
        col *= 1.0 - veinShadow * 0.14;
        col = mix(col, vec3(1.0), vein * 0.28 + veinCore * 0.16);
        col += baseColor * caustic * 0.05 * height;
        col += vec3(spec * 0.42);
        col += vec3(fresnel * rim * 0.22);
        col += vec3(veinCore * 0.08);

        diffuseColor.rgb = col;
        diffuseColor.a *= cover * (0.68 + 0.22 * height + 0.08 * veinCore);
      #endif
    `);
};
paintMat.customProgramCacheKey = () => 'paint-water-gel-v12';
paintMat.needsUpdate = true;