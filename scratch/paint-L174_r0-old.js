        float blurredA = aSum / wSum;
        float cover = smoothstep(0.16, 0.40, blurredA);

        // Ombre de contact très légère
        vec2 shOff = vec2(0.003, 0.004);
        float aShadow = paintSampleA(map, distortedUv + shOff);
        float drop = smoothstep(0.18, 0.48, aShadow) * (1.0 - smoothstep(0.16, 0.42, blurredA));

        if (cover < 0.01 && drop < 0.02) discard;

        vec3 baseColor = cSum / max(aSum, 0.001);
        float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = mix(vec3(luma), baseColor, 1.3);
        baseColor = mix(baseColor, vec3(1.0), 0.10);

        // Profil de hauteur (dôme de gel)
        float height = pow(smoothstep(0.18, 0.88, blurredA), 0.72);
        float rim = smoothstep(0.18, 0.36, blurredA) * (1.0 - smoothstep(0.40, 0.68, blurredA));

        // Normale de volume depuis la pente d'alpha
        float hL = paintSampleA(map, distortedUv - vec2(px * 2.5, 0.0));
        float hR = paintSampleA(map, distortedUv + vec2(px * 2.5, 0.0));
        float hD = paintSampleA(map, distortedUv - vec2(0.0, px * 2.5));
        float hU = paintSampleA(map, distortedUv + vec2(0.0, px * 2.5));
        vec3 nrm = normalize(vec3((hL - hR) * 4.5, (hD - hU) * 4.5, 0.22 + height * 0.55));

        vec3 lightDir = normalize(vec3(0.55, 0.75, 1.0));
        float ndl = max(0.0, dot(nrm, lightDir));
        float wrap = ndl * 0.65 + 0.35;
        float ao = mix(0.55, 1.0, height);
        float spec = pow(ndl, 18.0) * (0.25 + 0.75 * height);
        float fresnel = pow(1.0 - max(0.0, nrm.z), 2.2);

        // Nervures fines
        float cellScale = 110.0;
        float ve = paintVoronoiEdge(distortedUv * cellScale);
        float vein = 1.0 - smoothstep(0.010, 0.040, ve);
        float veinCore = 1.0 - smoothstep(0.0, 0.018, ve);
        float veS = paintVoronoiEdge(distortedUv * cellScale + vec2(0.22, 0.28));
        float veinShadow = (1.0 - smoothstep(0.010, 0.055, veS)) * (1.0 - vein);

        float caustic = sin(distortedUv.x * 90.0 + distortedUv.y * 68.0 + t * 0.55)
                      * sin(distortedUv.x * 55.0 - distortedUv.y * 75.0 - t * 0.35);
        caustic = caustic * 0.5 + 0.5;

        // Corps du gel volumique
        vec3 col = baseColor * wrap * ao;
        col *= 0.78 + 0.22 * height;
        col *= 1.0 - rim * 0.10;                 // flancs à peine plus sombres
        col = mix(col, baseColor * 1.12, height * 0.28);
        col *= 1.0 - veinShadow * 0.12;
        col = mix(col, vec3(1.0), vein * 0.26 + veinCore * 0.14);
        col += baseColor * caustic * 0.04 * height;
        col += vec3(spec * 0.45);
        col += vec3(fresnel * rim * 0.22);
        col += vec3(veinCore * 0.07);

        // Composer ombre de contact + gel
        vec3 shadowCol = vec3(0.12, 0.10, 0.08);
        float shadowA = drop * 0.08;
        float gelA = cover * (0.55 + 0.35 * height + 0.08 * veinCore);
        float outA = max(gelA, shadowA);
        vec3 outRgb = mix(shadowCol, col, clamp(gelA / max(outA, 0.001), 0.0, 1.0));

        diffuseColor.rgb = outRgb;
        diffuseColor.a *= outA;
      #endif
    `);
};
paintMat.customProgramCacheKey = () => 'paint-water-volume-v6';
const paintMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(PAINT_SPAN, PAINT_SPAN).rotateX(-Math.PI / 2),
  paintMat
);
paintMesh.position.y = 0.12;
paintMesh.renderOrder = 1;
scene.add(paintMesh);

/* Ombre au sol : très discrète, juste pour ancrer un peu. */
const paintFloorMat = new THREE.MeshBasicMaterial({
  map: paintTex,
  transparent: true,
  opacity: 0.06,
  depthWrite: false,
  color: 0x2a2018,
});
paintFloorMat.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
    #ifdef USE_MAP
      float px = ${(2.5 / 192).toFixed(6)};
      float a = texture2D(map, vMapUv).a;
      a += texture2D(map, vMapUv + vec2(px, 0.0)).a;
      a += texture2D(map, vMapUv - vec2(px, 0.0)).a;
      a += texture2D(map, vMapUv + vec2(0.0, px)).a;
      a += texture2D(map, vMapUv - vec2(0.0, px)).a;
      a *= 0.2;
      a = smoothstep(0.15, 0.42, a) * 0.55;
      diffuseColor = vec4(0.0, 0.0, 0.0, a);
    #endif
  `);
};
paintFloorMat.customProgramCacheKey = () => 'paint-floor-shadow-v3';
const paintFloorMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(PAINT_SPAN, PAINT_SPAN).rotateX(-Math.PI / 2),
  paintFloorMat
);
paintFloorMesh.position.set(0.12, 0.02, 0.14);
paintFloorMesh.renderOrder = 0;
scene.add(paintFloorMesh);

let paintDirty = false, paintUploadT = 0;