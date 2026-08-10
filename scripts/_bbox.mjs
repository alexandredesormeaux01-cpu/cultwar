import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
await MeshoptDecoder.ready;
const doc = await io.read('public/assets/models/portal_frame.glb');
const mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9];
function walk(node, m){
  const t=node.getWorldMatrix ? node.getWorldMatrix() : null;
  const mesh=node.getMesh && node.getMesh();
  if(mesh){
    for(const prim of mesh.listPrimitives()){
      const pos=prim.getAttribute('POSITION');
      const v=[0,0,0];
      for(let i=0;i<pos.getCount();i++){
        pos.getElement(i,v);
        // matrice monde 4x4 colonne-major
        const x=t[0]*v[0]+t[4]*v[1]+t[8]*v[2]+t[12];
        const y=t[1]*v[0]+t[5]*v[1]+t[9]*v[2]+t[13];
        const z=t[2]*v[0]+t[6]*v[1]+t[10]*v[2]+t[14];
        mn[0]=Math.min(mn[0],x); mx[0]=Math.max(mx[0],x);
        mn[1]=Math.min(mn[1],y); mx[1]=Math.max(mx[1],y);
        mn[2]=Math.min(mn[2],z); mx[2]=Math.max(mx[2],z);
      }
    }
  }
  for(const c of node.listChildren()) walk(c);
}
for(const sc of doc.getRoot().listScenes()) for(const n of sc.listChildren()) walk(n);
const size=mx.map((v,i)=>+(v-mn[i]).toFixed(3));
console.log('bbox MONDE (apres transformations de noeuds) :');
console.log('  min :', mn.map(v=>+v.toFixed(3)).join(', '));
console.log('  max :', mx.map(v=>+v.toFixed(3)).join(', '));
console.log('  taille X Y Z :', size.join(' x '));
const up = size[1] >= size[2] ? 'Y (deja bon)' : 'Z (a redresser)';
console.log('  axe le plus grand en vertical probable :', up);
