const paintMat = new THREE.MeshBasicMaterial({
  map: paintTex,
  transparent: true,
  opacity: 0.90,
  depthWrite: false,
  blending: THREE.NormalBlending,
});