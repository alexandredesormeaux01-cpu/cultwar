import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

GLTFLoader.prototype.load = function(url, onLoad) {
  setTimeout(() => onLoad({ scene: new THREE.Group() }), 0);
};
THREE.FileLoader.prototype.load = function(url, onLoad) {
  setTimeout(() => onLoad(new ArrayBuffer(0)), 0);
};

// Mocking document and window objects
const mockElement = {
  classList: {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  },
  style: {},
  addEventListener: () => {},
  appendChild: () => {},
  removeChild: () => {},
  querySelectorAll: () => [],
  querySelector: () => null,
  getContext: () => new Proxy({
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    getShaderPrecisionFormat: () => ({ rangeMin: 1, rangeMax: 1, precision: 1 }),
  }, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (prop === 'getParameter') return () => 'WebGL 2.0';
      const val = () => {};
      console.log('Proxy get query:', prop, '-> returns dummy');
      return val;
    }
  }),
  setAttribute: () => {},
  removeAttribute: () => {},
  cloneNode: () => mockElement,
};

globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'http://localhost/' },
  performance: { now: () => Date.now() },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};

globalThis.document = {
  getElementById: () => mockElement,
  createElement: () => mockElement,
  createElementNS: () => mockElement,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: mockElement,
  querySelectorAll: () => [],
  querySelector: () => null,
};

Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
globalThis.localStorage = globalThis.window.localStorage;
globalThis.addEventListener = globalThis.window.addEventListener;
globalThis.removeEventListener = globalThis.window.removeEventListener;
globalThis.performance = globalThis.window.performance;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1024;
globalThis.innerHeight = 768;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.AudioContext = class {
  createOscillator() { return { connect: () => {}, start: () => {}, stop: () => {}, frequency: { setValueAtTime: () => {} } }; }
  createGain() { return { connect: () => {}, gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} } }; }
  createBiquadFilter() { return { connect: () => {}, type: '', frequency: { setValueAtTime: () => {} } }; }
  destination = {};
  currentTime = 0;
};
globalThis.HTMLCanvasElement = class {};
globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
globalThis.requestAnimationFrame = () => {};
const NativeRequest = globalThis.Request || class {};
globalThis.Request = class extends NativeRequest {
  constructor(input, init) {
    if (typeof input === 'string' && input.startsWith('/')) {
      input = 'http://localhost' + input;
    }
    super(input, init);
  }
};
globalThis.fetch = () => Promise.resolve({
  ok: true,
  status: 200,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  json: () => Promise.resolve({}),
  text: () => Promise.resolve(''),
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const mainMocked = mainSrc.replaceAll('import.meta.env.DEV', 'true');
fs.writeFileSync(path.join(__dirname, '../src/main_mocked.js'), mainMocked);

try {
  console.log('Importing mocked main.js...');
  await import(pathToFileURL(path.join(__dirname, '../src/main_mocked.js')).href);
  console.log('Import successful! No load-time errors found.');
  
  if (globalThis.window.__play) {
    console.log('Simulating game start via window.__play()...');
    globalThis.window.__play();
    console.log('Game started successfully! No startup errors found.');
  } else {
    console.error('window.__play is not defined!');
  }
} catch (err) {
  console.error('CRASH DURING RUNTIME:', err);
  process.exit(1);
} finally {
  try {
    fs.unlinkSync(path.join(__dirname, '../src/main_mocked.js'));
  } catch (e) {}
}
