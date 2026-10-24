import { test } from 'node:test';
import { assert, assertEquals } from '@std/assert';
import * as THREE from 'three/webgpu';
import { SkeletonOverlay } from './src/viewport/skeleton.ts';
import { applyViewportSize } from './src/viewport/size.ts';
import { prepareViewportAttributes } from './src/viewport/attributes.ts';

test('normalized colors retain their values when WebGPU promotes shared integer joint buffers', () => {
  const data = new THREE.InterleavedBuffer(new Uint8Array([255, 128, 0, 255, 1, 2, 3, 4]), 8);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('color', new THREE.InterleavedBufferAttribute(data, 4, 0, true));
  const joints = new THREE.InterleavedBufferAttribute(data, 4, 4, false);
  geometry.setAttribute('skinIndex', joints);
  const mesh = new THREE.Mesh(geometry);
  try {
    prepareViewportAttributes(mesh);
    const colors = geometry.getAttribute('color');
    assertEquals(colors.normalized, false);
    assert(colors.array instanceof Float32Array);
    assertEquals(colors.getX(0), 1);
    assert(Math.abs(colors.getY(0) - 128 / 255) < 1e-7);
    assertEquals(colors.getZ(0), 0);
    assertEquals(colors.getW(0), 1);
    assertEquals(geometry.getAttribute('skinIndex'), joints);
    assertEquals([joints.getX(0), joints.getY(0), joints.getZ(0), joints.getW(0)], [1, 2, 3, 4]);
    assertEquals(Array.from(data.array), [255, 128, 0, 255, 1, 2, 3, 4]);
  } finally {
    geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
});

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

test('orthographic resize preserves vertical world scale and adjusts horizontal span', () => {
  const camera = new THREE.OrthographicCamera(-1, 1, 2, -2, .01, 10);
  applyViewportSize({ setDrawingBufferSize() {} }, camera, { width: 800, height: 400, ratio: 1 });
  assertEquals([camera.left, camera.right, camera.top, camera.bottom], [-4, 4, 2, -2]);
});
