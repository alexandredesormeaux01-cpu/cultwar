const paintMat = new THREE.MeshBasicMaterial({
  map: paintTex,
  transparent: true,
  opacity: 0.88,
  depthWrite: false,
  blending: THREE.NormalBlending,
});