/* ============================================================================
   Vertex Animation Texture (VAT) — animation squelettique pour la foule instanciée
   ----------------------------------------------------------------------------
   Un InstancedMesh ne sait pas jouer d'animation squelettique par instance (le
   squelette est partagé). La parade AAA : on « cuit » les poses du modèle riggé
   dans une texture — une colonne par sommet, une ligne par frame — puis le vertex
   shader rejoue l'animation en échantillonnant cette texture, par instance, avec
   sa propre phase et son allure (marche/course selon la vitesse au sol).

   Résultat : les VRAIES animations Walking/Running du .glb, sur des centaines de
   villageois, toujours en un seul appel GPU. Le poids du .glb n'a plus d'impact
   au runtime — seule compte la taille de la texture cuite (≈ sommets × frames).
   ========================================================================== */
import * as THREE from 'three';
import { toonMaterial, patchToonOutline } from './biomes.js';

/* Cuit les clips d'un glTF riggé dans deux DataTextures (positions + normales).
   @returns null si le modèle n'a ni squelette ni animation, sinon
   { posTex, normTex, vCount, framesPer, clipCount, geometry, height } */
export function bakeVAT(gltf, opts = {}) {
  const {
    clipNames = ['Walking', 'Running'],
    framesPer = 14,
    targetHeight = 1.05,   // hauteur finale du villageois (pieds à y=0)
    scale = 1,             // grossissement supplémentaire (ex. chevalier)
  } = opts;

  let skinned = null;
  gltf.scene.traverse((c) => { if (c.isSkinnedMesh) skinned = c; });
  if (!skinned || !gltf.animations || !gltf.animations.length) return null;

  let clips = (clipNames || [])
    .map((n) => THREE.AnimationClip.findByName(gltf.animations, n))
    .filter(Boolean);
  /* Fallback : n'importe quels clips du GLB (noms hors Walking/Running). */
  if (!clips.length) clips = gltf.animations.slice(0, 2);
  if (!clips.length) return null;
  if (clips.length === 1) clips = [clips[0], clips[0]];

  const mixer = new THREE.AnimationMixer(gltf.scene);
  const v = new THREE.Vector3();

  /* --- 1) Normalisation cohérente ---
     On calcule un scale + recentrage depuis une frame de référence (Walking f0)
     et on l'applique IDENTIQUEMENT à toutes les frames, sinon le modèle
     grossirait/glisserait d'une frame à l'autre. */
  const poseAt = (clip, t) => {
    mixer.stopAllAction();
    const act = mixer.clipAction(clip);
    act.reset(); act.play(); act.time = t;
    mixer.update(0);
    gltf.scene.updateMatrixWorld(true);
    if (skinned.skeleton) skinned.skeleton.update();
  };
  poseAt(clips[0], 0);
  const box = new THREE.Box3();
  for (let i = 0; i < skinned.geometry.attributes.position.count; i++) {
    skinned.getVertexPosition(i, v);
    v.applyMatrix4(skinned.matrixWorld);
    box.expandByPoint(v);
  }
  const vCount = skinned.geometry.attributes.position.count;
  const h = Math.max(0.001, box.max.y - box.min.y);
  const s = (targetHeight / h) * scale;
  const cx = (box.min.x + box.max.x) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  const minY = box.min.y;
  const norm = (p) => { p.x = (p.x - cx) * s; p.y = (p.y - minY) * s; p.z = (p.z - cz) * s; };

  /* --- 2) Cuisson frame par frame --- */
  const clipCount = clips.length;
  const totalFrames = clipCount * framesPer;
  const posData = new Float32Array(vCount * totalFrames * 4);
  const normData = new Float32Array(vCount * totalFrames * 4);

  // géométrie temporaire pour recalculer les normales de chaque frame
  const src = skinned.geometry;
  const tmpGeo = new THREE.BufferGeometry();
  const tmpPos = new THREE.BufferAttribute(new Float32Array(vCount * 3), 3);
  tmpGeo.setAttribute('position', tmpPos);
  if (src.index) tmpGeo.setIndex(src.index.clone());

  let refPos = null;   // positions normalisées de la frame de référence (attribut de repli)

  for (let ci = 0; ci < clipCount; ci++) {
    const clip = clips[ci];
    for (let f = 0; f < framesPer; f++) {
      poseAt(clip, (f / framesPer) * clip.duration);
      for (let i = 0; i < vCount; i++) {
        skinned.getVertexPosition(i, v);
        v.applyMatrix4(skinned.matrixWorld);
        norm(v);
        tmpPos.setXYZ(i, v.x, v.y, v.z);
      }
      tmpGeo.computeVertexNormals();
      const na = tmpGeo.attributes.normal;
      const row = ci * framesPer + f;
      const base = row * vCount * 4;
      for (let i = 0; i < vCount; i++) {
        const o = base + i * 4;
        posData[o]     = tmpPos.getX(i);
        posData[o + 1] = tmpPos.getY(i);
        posData[o + 2] = tmpPos.getZ(i);
        posData[o + 3] = 1;
        normData[o]     = na.getX(i);
        normData[o + 1] = na.getY(i);
        normData[o + 2] = na.getZ(i);
        normData[o + 3] = 0;
      }
      if (ci === 0 && f === 0) refPos = tmpPos.array.slice();
    }
  }

  /* HalfFloat : les GPU Android ne garantissent pas le vertex texture fetch en
     RGBA32F — la lecture renvoie 0 et tous les sommets s'effondrent (invisible). */
  const halfPos = new Uint16Array(posData.length);
  const halfNorm = new Uint16Array(normData.length);
  for (let i = 0; i < posData.length; i++) halfPos[i] = THREE.DataUtils.toHalfFloat(posData[i]);
  for (let i = 0; i < normData.length; i++) halfNorm[i] = THREE.DataUtils.toHalfFloat(normData[i]);

  const posTex = new THREE.DataTexture(halfPos, vCount, totalFrames, THREE.RGBAFormat, THREE.HalfFloatType);
  const normTex = new THREE.DataTexture(halfNorm, vCount, totalFrames, THREE.RGBAFormat, THREE.HalfFloatType);
  for (const t of [posTex, normTex]) {
    t.minFilter = THREE.NearestFilter;   // pas d'interpolation GPU : les colonnes
    t.magFilter = THREE.NearestFilter;   // (sommets) sont indépendantes ; on lerp
    t.generateMipmaps = false;           // les frames à la main dans le shader.
    t.needsUpdate = true;
  }

  /* --- 3) Géométrie du crowd : ref pose + uv + aVertexIndex --- */
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(refPos, 3));
  const refNorm = new THREE.BufferAttribute(new Float32Array(vCount * 3), 3);
  geometry.setAttribute('normal', refNorm);   // remplacé par le shader, mais requis
  if (src.attributes.uv) geometry.setAttribute('uv', src.attributes.uv.clone());
  if (src.index) geometry.setIndex(src.index.clone());
  const vidx = new Float32Array(vCount);
  for (let i = 0; i < vCount; i++) vidx[i] = i;
  geometry.setAttribute('aVertexIndex', new THREE.BufferAttribute(vidx, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return { posTex, normTex, vCount, framesPer, clipCount, geometry, height: targetHeight * scale };
}

/** Injecte le sampling VAT dans un vertex shader Three.js (toon ou basic). */
function patchVATVertex(shader, vat, timeU, thickness = 0) {
  shader.uniforms.uTime = timeU;
  shader.uniforms.uPosTex = { value: vat.posTex };
  shader.uniforms.uNormTex = { value: vat.normTex };
  shader.uniforms.uVATSize = { value: new THREE.Vector2(vat.vCount, vat.framesPer * vat.clipCount) };
  shader.uniforms.uFramesPer = { value: vat.framesPer };

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', [
      '#include <common>',
      'uniform float uTime;',
      'uniform sampler2D uPosTex;',
      'uniform sampler2D uNormTex;',
      'uniform vec2 uVATSize;',
      'uniform float uFramesPer;',
      'attribute float aVertexIndex;',
      'attribute vec2 aAnim;',
    ].join('\n'))
    .replace('#include <beginnormal_vertex>', [
      'float _spd = aAnim.y;',
      'float _clip = step(2.2, _spd);',
      'float _runBoost = clamp((_spd - 3.5) * 0.22, 0.0, 1.0);',
      'float _fps  = mix(13.0, 20.0, _clip);',
      'float _mv   = step(0.12, _spd);',
      'float _lf = mod(uTime * _fps * _mv + aAnim.x * uFramesPer, uFramesPer);',
      'float _f0 = floor(_lf);',
      'float _f1 = mod(_f0 + 1.0, uFramesPer);',
      'float _ft = _lf - _f0;',
      'float _rb = _clip * uFramesPer;',
      'float _u  = (aVertexIndex + 0.5) / uVATSize.x;',
      'float _iy = 1.0 / uVATSize.y;',
      'vec3 _n0 = texture2D(uNormTex, vec2(_u, (_rb + _f0 + 0.5) * _iy)).xyz;',
      'vec3 _n1 = texture2D(uNormTex, vec2(_u, (_rb + _f1 + 0.5) * _iy)).xyz;',
      'vec3 objectNormal = normalize(mix(_n0, _n1, _ft));',
      '#ifdef USE_TANGENT',
      '  vec3 objectTangent = vec3( tangent.xyz );',
      '#endif',
    ].join('\n'))
    .replace('#include <begin_vertex>', [
      'vec3 _p0 = texture2D(uPosTex, vec2(_u, (_rb + _f0 + 0.5) * _iy)).xyz;',
      'vec3 _p1 = texture2D(uPosTex, vec2(_u, (_rb + _f1 + 0.5) * _iy)).xyz;',
      'vec3 transformed = mix(_p0, _p1, _ft);',
      'float _upper = smoothstep(0.15, 0.75, transformed.y);',
      'float _lean  = 0.0;',
      'float _lc = cos(_lean), _ls = sin(_lean);',
      'transformed = vec3(transformed.x, _lc * transformed.y - _ls * transformed.z, _ls * transformed.y + _lc * transformed.z);',
      'objectNormal = vec3(objectNormal.x, _lc * objectNormal.y - _ls * objectNormal.z, _ls * objectNormal.y + _lc * objectNormal.z);',
      thickness > 0
        ? `transformed += normalize(objectNormal) * ${thickness.toFixed(4)};`
        : '',
    ].join('\n'));
}

/** Matériau toon qui rejoue le VAT dans le vertex shader.
   @param tex     texture couleur du modèle (map d'origine)
   @param vat     retour de bakeVAT
   @param timeU   uniforme de temps partagé { value } (avancé par la boucle)
   @param key     clé unique par variante (force une compilation séparée du shader) */
export function makeVATMaterial(tex, vat, timeU, key = 'vat', opts = {}) {
  const { wildHalo = false, golden = false } = opts;
  const mat = toonMaterial({ map: tex || null });
  mat.customProgramCacheKey = () => 'vat-' + key + (wildHalo ? '-halo' : '') + (golden ? '-gold' : '');
  mat.onBeforeCompile = (shader) => {
    patchVATVertex(shader, vat, timeU, 0);
    patchToonOutline(shader);
    /* Teinte d'Or céleste éclatant pour tous les esprits élémentaires neutres */
    if (golden || wildHalo) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <opaque_fragment>', [
          '{',
          '  vec3 vN = normalize(vNormal);',
          '  vec3 vV = normalize(vViewPosition);',
          '  float rim = pow(1.0 - max(dot(vN, vV), 0.0), 1.8);',
          '  float pulse = 0.75 + 0.25 * sin(uTime * 3.2);',
          '  vec3 gold = vec3(1.0, 0.76, 0.15);',
          '  outgoingLight = mix(outgoingLight, gold, 0.85) + gold * rim * pulse * 1.8;',
          '}',
          '#include <opaque_fragment>',
        ].join('\n'));
    }
  };
  return mat;
}

/** Contour cartoon animé (même VAT) — même pipeline vertex que le mesh principal. */
export function makeVATOutlineMaterial(vat, timeU, key = 'vat-out', thickness = 0.028) {
  // MeshToonMaterial : le patch VAT y est prouvé (même chemin que makeVATMaterial).
  const mat = toonMaterial({ color: 0x080a12 });
  mat.side = THREE.BackSide;
  mat.fog = false;
  // depthWrite ON : sinon la peinture (transparent, depthWrite off) se compose
  // par-dessus le contour et le rend translucide / quasi invisible.
  mat.depthWrite = true;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 1;
  mat.customProgramCacheKey = () => 'vat-out-toon-' + key + '-' + thickness.toFixed(3);
  mat.onBeforeCompile = (shader) => {
    mat.userData.shader = shader;
    patchVATVertex(shader, vat, timeU, thickness);
    // Noir plat opaque — garde le préambule WebGL2 de Three, remplace seulement main()
    shader.fragmentShader = shader.fragmentShader.replace(
      /void\s+main\s*\(\s*\)\s*\{[\s\S]*\}\s*$/,
      'void main() { gl_FragColor = vec4(0.031, 0.039, 0.071, 1.0); }\n',
    );
  };
  return mat;
}
