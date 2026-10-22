import { test } from 'node:test';
import { assert, assertEquals } from '@std/assert';
import * as THREE from 'three/webgpu';
import { SkeletonOverlay } from './src/viewport/skeleton.ts';
import { applyViewportSize } from './src/viewport/size.ts';

test('a sibling armature renders bones and joint markers, with selectable issue colors', () => {
  const scene = new THREE.Group();
  const mesh = new THREE.SkinnedMesh();
  const hip = new THREE.Bone(), knee = new THREE.Bone();
  hip.name = 'pelvis';
  knee.name = 'calf_l';
  knee.position.y = -0.5;
  hip.add(knee);
  scene.add(mesh, hip);
  scene.updateMatrixWorld(true);
  const overlay = new SkeletonOverlay(scene);
  try {
    assertEquals(overlay.helper.geometry.getAttribute('position').count, 2);
    assertEquals(overlay.markers.geometry.getAttribute('position').count, 2);
    overlay.update();
    assertEquals(overlay.markers.geometry.getAttribute('position').getY(1), -0.5);
    overlay.setFlags(['calf_l']);
    const colors = overlay.markers.geometry.getAttribute('color');
    assert(colors.getY(0) !== colors.getY(1));
    overlay.setSelection('calf_l');
    assertEquals(colors.getX(1), 1);
    assertEquals(colors.getY(1), 1);
    overlay.setThroughMesh(false);
    assertEquals((overlay.helper.material as THREE.Material).depthTest, true);
  } finally {
    overlay.dispose();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
});

test('unchanged and hidden viewport sizes do not clear the drawing buffer', () => {
  const calls: number[][] = [];
  const renderer = { setDrawingBufferSize: (...size: number[]) => calls.push(size) };
  const camera = new THREE.PerspectiveCamera();
  const size = applyViewportSize(renderer, camera, { width: 800, height: 400, ratio: 1 });
  assertEquals(camera.aspect, 2);
  assertEquals(
    applyViewportSize(renderer, camera, { width: 800, height: 400, ratio: 1 }, size),
    size,
  );
  assertEquals(applyViewportSize(renderer, camera, { width: 0, height: 0, ratio: 1 }, size), size);
  applyViewportSize(renderer, camera, { width: 400, height: 400, ratio: 2 }, size);
  assertEquals(calls, [[800, 400, 1], [400, 400, 2]]);
  assertEquals(camera.aspect, 1);
});
