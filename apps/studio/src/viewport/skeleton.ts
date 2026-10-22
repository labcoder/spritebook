import * as THREE from 'three/webgpu';

const NORMAL = new THREE.Color(0xa9beff);
const FLAGGED = new THREE.Color(0xffba68);
const SELECTED = new THREE.Color(0xffffff);

/** Skin joints can be siblings of the mesh. Always inspect the loaded scene. */
export class SkeletonOverlay {
  readonly group = new THREE.Group();
  readonly helper: THREE.SkeletonHelper;
  readonly bones: THREE.Bone[] = [];
  readonly markers: THREE.Points;
  #flags = new Set<string>();
  #selected: string | null = null;
  #position = new THREE.Vector3();

  constructor(root: THREE.Object3D) {
    root.traverse((node) => {
      if ((node as THREE.Bone).isBone) this.bones.push(node as THREE.Bone);
    });
    this.helper = new THREE.SkeletonHelper(root);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(this.bones.length * 3), 3),
    );
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(new Float32Array(this.bones.length * 3), 3),
    );
    this.markers = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 6,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.markers.frustumCulled = false;
    this.group.add(this.helper, this.markers);
    this.group.renderOrder = 1000;
    this.helper.renderOrder = 1000;
    this.markers.renderOrder = 1001;
    this.setSelection(null);
  }

  setThroughMesh(through: boolean): void {
    (this.helper.material as THREE.LineBasicMaterial).depthTest = !through;
    (this.markers.material as THREE.PointsMaterial).depthTest = !through;
  }

  setFlags(names: readonly string[]): void {
    this.#flags = new Set(names);
    this.setSelection(this.#selected);
  }

  setSelection(name: string | null): void {
    this.#selected = name;
    const colorFor = (bone: THREE.Bone) =>
      bone.name === name ? SELECTED : this.#flags.has(bone.name) ? FLAGGED : NORMAL;
    const colors = this.markers.geometry.getAttribute('color');
    this.bones.forEach((bone, i) => {
      const color = colorFor(bone);
      colors.setXYZ(i, color.r, color.g, color.b);
    });
    colors.needsUpdate = true;
    const lines = this.helper.geometry.getAttribute('color');
    let segment = 0;
    for (const bone of this.helper.bones) {
      if (!(bone.parent as THREE.Bone | null)?.isBone) continue;
      const color = colorFor(bone);
      lines.setXYZ(segment++, color.r, color.g, color.b);
      lines.setXYZ(segment++, color.r, color.g, color.b);
    }
    lines.needsUpdate = true;
  }

  update(): void {
    if (!this.group.visible) return;
    const positions = this.markers.geometry.getAttribute('position');
    this.bones.forEach((bone, i) => {
      bone.getWorldPosition(this.#position);
      positions.setXYZ(i, this.#position.x, this.#position.y, this.#position.z);
    });
    positions.needsUpdate = true;
  }

  dispose(): void {
    this.helper.dispose();
    this.markers.geometry.dispose();
    (this.markers.material as THREE.PointsMaterial).dispose();
  }
}
