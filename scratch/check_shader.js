// Mock browser environment or just load Three.js via node
// Since node_modules/three/build/three.module.js is ES module, we can import it.
import * as THREE from 'three';

const mat = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
// To get the shader source, we can compile a dummy renderer or check THREE.ShaderLib.basic.fragmentShader.
const shader = THREE.ShaderLib.basic;
console.log('--- BASIC FRAGMENT SHADER ---');
console.log(shader.fragmentShader);
