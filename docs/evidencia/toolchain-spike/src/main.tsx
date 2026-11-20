import { createRoot } from 'react-dom/client';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Edges, Line, Html } from '@react-three/drei';
import * as THREE from 'three';
const tex = new THREE.CanvasTexture(document.createElement('canvas'));
function Scene() {
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 2]} />
      <mesh position={[0, 0.9, 0]}>
        <boxGeometry args={[0.8, 1.8, 0.32]} />
        <meshStandardMaterial map={tex} color="#f5f5f4" />
        <Edges color="#334155" />
      </mesh>
      <Line points={[[0, 0, 0], [0.8, 0, 0]]} color="black" lineWidth={2} />
      <Html center><div style={{ fontFamily: 'system-ui, sans-serif' }}>800 mm</div></Html>
      <gridHelper args={[4, 40]} />
      <OrbitControls makeDefault />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Canvas><Scene /></Canvas>);
