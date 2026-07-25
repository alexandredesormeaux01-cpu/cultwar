        vec4 tex = texture2D(map, uv);
        float a = tex.a;
        // Seuil plus haut : coupe le fringe semi-transparent (encoches / trait sombre)
        if (a < 0.20) discard;
        float aa = fwidth(a) * 1.4;
        float cover = smoothstep(0.20, 0.20 + max(aa, 0.12), a);

        vec3 baseColor = tex.rgb;
        float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = mix(vec3(luma), baseColor, 1.28);
        baseColor = mix(baseColor, vec3(1.0), 0.10);

        float height = pow(smoothstep(0.22, 0.95, a), 0.8);
        float rim = smoothstep(0.22, 0.40, a) * (1.0 - smoothstep(0.45, 0.82, a));

        float hL = texture2D(map, uv - vec2(px * 2.0, 0.0)).a;
        float hR = texture2D(map, uv + vec2(px * 2.0, 0.0)).a;
        float hD = texture2D(map, uv - vec2(0.0, px * 2.0)).a;
        float hU = texture2D(map, uv + vec2(0.0, px * 2.0)).a;
        vec3 nrm = normalize(vec3((hL - hR) * 2.6, (hD - hU) * 2.6, 0.38 + height * 0.4));

        vec3 lightDir = normalize(vec3(0.55, 0.75, 1.0));
        float ndl = max(0.0, dot(nrm, lightDir));
        float wrap = ndl * 0.32 + 0.68;
        float ao = mix(0.94, 1.0, height);
        float spec = pow(ndl, 16.0) * (0.12 + 0.32 * height);

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
        col *= 0.92 + 0.08 * height;
        col = mix(col, baseColor * 1.06, height * 0.18);
        col = mix(col, mix(baseColor, vec3(1.0), 0.35), rim * 0.16);
        col *= 1.0 - veinShadow * 0.06;
        col = mix(col, vec3(1.0), vein * 0.24 + veinCore * 0.12);
        col += baseColor * caustic * 0.04 * height;
        col += vec3(spec * 0.28);
        col += vec3(veinCore * 0.06);

        diffuseColor.rgb = col;
        diffuseColor.a *= cover * (0.78 + 0.16 * height + 0.04 * veinCore);
      #endif
    `);
};
paintMat.customProgramCacheKey = () => 'paint-water-gel-v14';
paintMat.needsUpdate = true;