import * as THREE from 'three/webgpu';

/** WebGPU promotes integer joint buffers; detach normalized interleaved attributes first. */
export function prepareViewportAttributes(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const geometry = (object as THREE.Mesh).geometry;
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (!attribute.normalized) continue;
      const values = new Float32Array(attribute.count * attribute.itemSize);
      for (let vertex = 0; vertex < attribute.count; vertex++) {
        for (let component = 0; component < attribute.itemSize; component++) {
          values[vertex * attribute.itemSize + component] = attribute.getComponent(
            vertex,
            component,
          );
        }
      }
      geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, attribute.itemSize));
    }
  });
}
