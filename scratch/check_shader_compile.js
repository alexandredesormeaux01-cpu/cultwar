import * as THREE from 'three';

const shader = {
  fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  uniforms: THREE.ShaderLib.basic.uniforms
};

const monkTimeU = { value: 0 };

shader.fragmentShader = shader.fragmentShader
  .replace('#include <common>', '#include <common>\nuniform float uTime;')
  .replace('#include <map_fragment>', `
    #ifdef USE_MAP
      // Distorsion UV pour créer un effet de bordure liquide et ondulante
      vec2 uv = vMapUv;
      float t = uTime * 1.0;
      
      float dx = sin(uv.y * 30.0 + t) * 0.0035 + cos(uv.x * 18.0 - t * 0.6) * 0.002;
      float dy = cos(uv.x * 30.0 + t * 0.8) * 0.0035 + sin(uv.y * 20.0 - t) * 0.002;
      vec2 distortedUv = uv + vec2(dx, dy);
      
      vec4 sampledDiffuseColor = texture2D( map, distortedUv );
      
      // Effet de vagues de lumière internes (shimmer) pour animer la surface du fluide
      if (sampledDiffuseColor.a > 0.05) {
        float wave1 = sin(distortedUv.x * 60.0 + distortedUv.y * 40.0 + t * 2.0);
        float wave2 = cos(distortedUv.x * 30.0 - distortedUv.y * 50.0 - t * 1.4);
        float wave = (wave1 + wave2) * 0.5;
        
        // Reflets brillants
        float shimmer = smoothstep(0.3, 0.85, wave);
        sampledDiffuseColor.rgb += vec3(shimmer * 0.08);
        
        // Légère pulsation d'éclat
        sampledDiffuseColor.rgb *= 1.0 + sin(t * 1.3 + distortedUv.x * 8.0) * 0.04;
      }
      
      diffuseColor *= sampledDiffuseColor;
    #endif
  `);

console.log(shader.fragmentShader);
