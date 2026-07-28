import * as THREE from 'three';
import { FUEL_MAX } from './sim/constants.js';

const ORB_COUNT = 50;
const ORB_RADIUS = 0.55;
const ORB_COLLECT_R = 3.8;
const ORB_COLLECT_R2 = ORB_COLLECT_R * ORB_COLLECT_R;
const ORB_FLOAT_Y = 1.6;
const ORB_FUEL = 10;
const ORB_RESPAWN_T = 8;

const _tmpM = new THREE.Matrix4();
const _tmpV = new THREE.Vector3();

let orbMesh = null;
let orbs = [];
let scene = null;

const orbVert = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    vec3 p = position;
    float phase = float(gl_InstanceID) * 1.37;
    float wave = sin(p.y * 4.0 + uTime * 2.5 + phase) * 0.14
               + sin(p.x * 3.0 + uTime * 1.8 + phase) * 0.10
               + sin(p.z * 3.5 + uTime * 3.1 + phase) * 0.08;
    p += normal * wave;
    vec4 worldPos = instanceMatrix * vec4(p, 1.0);
    vNormal = mat3(instanceMatrix) * normal;
    vPos = (viewMatrix * worldPos).xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const orbFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vPos;
  void main() {
    vec3 lightDir = normalize(vec3(0.4, 1.0, 0.3));
    float diff = max(dot(normalize(vNormal), lightDir), 0.0);
    float rim = 1.0 - max(dot(normalize(vNormal), normalize(-vPos)), 0.0);
    rim = pow(rim, 2.5) * 0.7;
    float pulse = 0.85 + 0.15 * sin(uTime * 3.0);
    vec3 col = uColor * (0.45 + diff * 0.55) * pulse + vec3(1.0) * rim;
    gl_FragColor = vec4(col, 0.85);
  }
`;

function makeOrbMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x44bbff) },
    },
    vertexShader: orbVert,
    fragmentShader: orbFrag,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function initPaintOrbs(sc) {
  scene = sc;
  const geo = new THREE.SphereGeometry(ORB_RADIUS, 16, 12);
  orbMesh = new THREE.InstancedMesh(geo, makeOrbMaterial(), ORB_COUNT);
  orbMesh.frustumCulled = false;
  orbMesh.renderOrder = 5;
  scene.add(orbMesh);
  orbs = [];
}

export function spawnPaintOrbs(islandRandomPoint, count = ORB_COUNT) {
  orbs.length = 0;
  for (let i = 0; i < count; i++) {
    const pt = islandRandomPoint(6, Infinity);
    orbs.push({
      x: pt.x, z: pt.z,
      y: ORB_FLOAT_Y,
      alive: true,
      respawnT: 0,
      phase: Math.random() * Math.PI * 2,
      spawnX: pt.x, spawnZ: pt.z,
    });
  }
  updateOrbMatrices(0);
}

function updateOrbMatrices(t) {
  if (!orbMesh) return;
  for (let i = 0; i < ORB_COUNT; i++) {
    if (i >= orbs.length || !orbs[i].alive) {
      _tmpM.makeScale(0, 0, 0);
      orbMesh.setMatrixAt(i, _tmpM);
      continue;
    }
    const o = orbs[i];
    const bob = Math.sin(t * 1.6 + o.phase) * 0.35;
    const spin = t * 0.8 + o.phase;
    _tmpM.makeRotationY(spin);
    _tmpM.setPosition(o.x, o.y + bob, o.z);
    orbMesh.setMatrixAt(i, _tmpM);
  }
  orbMesh.instanceMatrix.needsUpdate = true;
}

export function updatePaintOrbs(dt, t, factions, islandRandomPoint, onCollect) {
  if (!orbMesh) return;
  orbMesh.material.uniforms.uTime.value = t;

  for (let i = 0; i < orbs.length; i++) {
    const o = orbs[i];
    if (!o.alive) {
      o.respawnT -= dt;
      if (o.respawnT <= 0) {
        const pt = islandRandomPoint(6, Infinity);
        o.x = pt.x; o.z = pt.z;
        o.spawnX = pt.x; o.spawnZ = pt.z;
        o.y = ORB_FLOAT_Y;
        o.phase = Math.random() * Math.PI * 2;
        o.alive = true;
      }
      continue;
    }

    for (const f of factions) {
      if (!f.alive) continue;
      const dx = f.leader.x - o.x, dz = f.leader.z - o.z;
      if (dx * dx + dz * dz < ORB_COLLECT_R2) {
        o.alive = false;
        o.respawnT = ORB_RESPAWN_T;
        if (onCollect) onCollect(f);
        f.fuel = Math.min(FUEL_MAX, (f.fuel || 0) + ORB_FUEL);
        break;
      }
    }
  }

  updateOrbMatrices(t);
}

export function resetPaintOrbs() {
  orbs.length = 0;
  if (orbMesh) {
    for (let i = 0; i < ORB_COUNT; i++) {
      _tmpM.makeScale(0, 0, 0);
      orbMesh.setMatrixAt(i, _tmpM);
    }
    orbMesh.instanceMatrix.needsUpdate = true;
  }
}
