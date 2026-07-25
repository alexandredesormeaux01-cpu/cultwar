        float blurredA = aSum / wSum;
        float cover = smoothstep(0.16, 0.40, blurredA);
        if (cover < 0.01) discard;

        vec3 baseColor = cSum / max(aSum, 0.001);
        float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = mix(vec3(luma), baseColor, 1.3);
        baseColor = mix(baseColor, vec3(1.0), 0.10);

        // Profil de hauteur (dôme de gel) — volume sans ombre portée
        float height = pow(smoothstep(0.18, 0.88, blurredA), 0.72);
        float rim = smoothstep(0.18, 0.36, blurredA) * (1.0 - smoothstep(0.40, 0.68, blurredA));

        float hL = paintSampleA(map, distortedUv - vec2(px * 2.5, 0.0));
        float hR = paintSampleA(map, distortedUv + vec2(px * 2.5, 0.0));
        float hD = paintSampleA(map, distortedUv - vec2(0.0, px * 2.5));
        float hU = paintSampleA(map, distortedUv + vec2(0.0, px * 2.5));
        vec3 nrm = normalize(vec3((hL - hR) * 4.5, (hD - hU) * 4.5, 0.22 + height * 0.55));

        vec3 lightDir = normalize(vec3(0.55, 0.75, 1.0));
        float ndl = max(0.0, dot(nrm, lightDir));
        float wrap = ndl * 0.55 + 0.45;
        float ao = mix(0.72, 1.0, height);
        float spec = pow(ndl, 18.0) * (0.20 + 0.55 * height);
        float fresnel = pow(1.0 - max(0.0, nrm.z), 2.2);

        float cellScale = 110.0;
        float ve = paintVoronoiEdge(distortedUv * cellScale);
        float vein = 1.0 - smoothstep(0.010, 0.040, ve);
        float veinCore = 1.0 - smoothstep(0.0, 0.018, ve);
        float veS = paintVoronoiEdge(distortedUv * cellScale + vec2(0.22, 0.28));
        float veinShadow = (1.0 - smoothstep(0.010, 0.055, veS)) * (1.0 - vein);

        float caustic = sin(distortedUv.x * 90.0 + distortedUv.y * 68.0 + t * 0.55)
                      * sin(distortedUv.x * 55.0 - distortedUv.y * 75.0 - t * 0.35);
        caustic = caustic * 0.5 + 0.5;

        vec3 col = baseColor * wrap * ao;
        col *= 0.82 + 0.18 * height;
        col *= 1.0 - rim * 0.08;
        col = mix(col, baseColor * 1.1, height * 0.25);
        col *= 1.0 - veinShadow * 0.10;
        col = mix(col, vec3(1.0), vein * 0.24 + veinCore * 0.12);
        col += baseColor * caustic * 0.035 * height;
        col += vec3(spec * 0.35);
        col += vec3(fresnel * rim * 0.18);
        col += vec3(veinCore * 0.06);

        diffuseColor.rgb = col;
        diffuseColor.a *= cover * (0.58 + 0.32 * height + 0.06 * veinCore);
      #endif
    `);
};
paintMat.customProgramCacheKey = () => 'paint-water-volume-v7';
const paintMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(PAINT_SPAN, PAINT_SPAN).rotateX(-Math.PI / 2),
  paintMat
);
paintMesh.position.y = 0.04;
paintMesh.renderOrder = 1;
scene.add(paintMesh);

let paintDirty = false, paintUploadT = 0;