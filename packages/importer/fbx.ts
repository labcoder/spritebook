/**
 * FBX ingestion (D-020): three.js FBXLoader (MIT, pure JS — no Autodesk SDK,
 * no native binaries) parsed in-process and bridged DIRECTLY into a
 * glTF-Transform Document (three's GLTFExporter needs a DOM; we don't).
 * ufbx-wasm remains the target once a maintained npm binding exists — none
 * does as of 2026-07-13 (verified; see D-020).
 *
 * Scope: static + skinned meshes (position/normal/uv, 4-influence skins,
 * bone hierarchy, inverse bind matrices). Textures/materials are out of scope
 * at the border — identity texturing is a later pipeline stage.
 */
import { Document } from '@gltf-transform/core';
import type { Node } from '@gltf-transform/core';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ImportError, toImportError } from './errors.ts';

export const FBX_CONVERTER = `three-fbxloader@${THREE.REVISION}`;

export function parseFbx(bytes: Uint8Array, path: string): THREE.Group {
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new FBXLoader().parse(buffer as ArrayBuffer, '');
  } catch (err) {
    throw toImportError(err, `${path}: FBX parse failed (${FBX_CONVERTER})`);
  }
}

/** Convert a parsed three.js FBX scene into a fresh glTF-Transform Document. */
export function threeSceneToDocument(scene: THREE.Group, path: string): Document {
  const doc = new Document();
  const buffer = doc.createBuffer('bin');
  const gltfScene = doc.createScene('scene');
  const nodeFor = new Map<THREE.Object3D, Node>();

  // pass 1: mirror the object tree (bones become plain nodes = glTF joints)
  scene.updateMatrixWorld(true);
  const mirror = (obj: THREE.Object3D, parent?: Node) => {
    const node = doc.createNode(obj.name || obj.type);
    node.setTranslation(obj.position.toArray() as [number, number, number]);
    node.setRotation(obj.quaternion.toArray() as [number, number, number, number]);
    node.setScale(obj.scale.toArray() as [number, number, number]);
    if (parent) parent.addChild(node);
    else gltfScene.addChild(node);
    nodeFor.set(obj, node);
    for (const child of obj.children) mirror(child, node);
  };
  for (const child of scene.children) mirror(child);

  // pass 2: geometry + skins
  scene.traverse((obj: THREE.Object3D) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const node = nodeFor.get(obj);
    if (!node) return;
    const geometry = obj.geometry as THREE.BufferGeometry;
    const prim = doc.createPrimitive();
    const attr = (three: string, gltf: string, itemSize: number) => {
      const a = geometry.getAttribute(three) as THREE.BufferAttribute | undefined;
      if (!a) return;
      if (a.itemSize !== itemSize) {
        throw new ImportError(
          `${path}: mesh "${obj.name}" attribute ${three} has itemSize ${a.itemSize}, expected ${itemSize}`,
        );
      }
      const accessor = doc.createAccessor(`${obj.name}-${gltf}`)
        .setType(itemSize === 2 ? 'VEC2' : itemSize === 3 ? 'VEC3' : 'VEC4')
        .setBuffer(buffer);
      if (gltf === 'JOINTS_0') {
        accessor.setArray(Uint16Array.from(a.array as ArrayLike<number>));
      } else {
        accessor.setArray(Float32Array.from(a.array as ArrayLike<number>));
      }
      prim.setAttribute(gltf, accessor);
    };
    attr('position', 'POSITION', 3);
    attr('normal', 'NORMAL', 3);
    attr('uv', 'TEXCOORD_0', 2);
    if (geometry.getIndex()) {
      const idx = geometry.getIndex()!;
      prim.setIndices(
        doc.createAccessor(`${obj.name}-indices`)
          .setType('SCALAR')
          .setArray(Uint32Array.from(idx.array as ArrayLike<number>))
          .setBuffer(buffer),
      );
    }
    const mesh = doc.createMesh(obj.name || 'mesh').addPrimitive(prim);
    node.setMesh(mesh);

    if (obj instanceof THREE.SkinnedMesh) {
      attr('skinIndex', 'JOINTS_0', 4);
      attr('skinWeight', 'WEIGHTS_0', 4);
      const skeleton = obj.skeleton;
      if (!skeleton || skeleton.bones.length === 0) {
        throw new ImportError(`${path}: skinned mesh "${obj.name}" has no skeleton`);
      }
      const ibm = new Float32Array(skeleton.bones.length * 16);
      skeleton.boneInverses.forEach((m: THREE.Matrix4, i: number) => ibm.set(m.elements, i * 16));
      const skin = doc.createSkin(`${obj.name}-skin`)
        .setInverseBindMatrices(
          doc.createAccessor(`${obj.name}-ibm`).setType('MAT4').setArray(ibm).setBuffer(buffer),
        );
      for (const bone of skeleton.bones) {
        const joint = nodeFor.get(bone);
        if (!joint) {
          throw new ImportError(
            `${path}: skinned mesh "${obj.name}" references bone "${bone.name}" outside the scene`,
          );
        }
        skin.addJoint(joint);
      }
      node.setSkin(skin);
    }
  });

  const meshCount = doc.getRoot().listMeshes().length;
  if (meshCount === 0) {
    throw new ImportError(`${path}: FBX contained no meshes after conversion`);
  }
  return doc;
}
