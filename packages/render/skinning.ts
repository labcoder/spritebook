/**
 * Load a canonical glb (importer-border output) into GPU-ready vertex streams +
 * a skeleton, and evaluate joint matrices per frame. Promoted from the P0-T2
 * spike and hardened: reads real bind-pose local matrices, upconverts JOINTS_0
 * to u32 (the frozen vertex layout), CONCATENATES every mesh and every primitive
 * (the importer preserves multi-primitive characters — body/clothes/hair — and a
 * character is almost always multi-material), and synthesizes a trivial 1-joint
 * skin for static meshes so the skinning pipeline is the only draw path.
 *
 * Geometry is placed by its NODE, because in glTF that is the only thing that
 * says where a mesh is: a rigid mesh's rest world transform is baked into its
 * vertices and it rigid-binds to the nearest joint above it, so a prop hung on
 * a socket bakes in the hand and rides it through a clip, and the importer's
 * height normalization (which lives on the root node's matrix, never on the
 * vertices) reaches the frame instead of being silently dropped.
 *
 * Texturing (Track A close-out): TEXCOORD_0 and each primitive's base color
 * texture ride along — per-primitive index RANGES carry which texture a draw
 * binds, untextured materials become a 1x1 of their baseColorFactor, and
 * no-material primitives keep the legacy clay constant as a 1x1, so pre-texture
 * fixtures render exactly as before.
 *
 * The per-frame pose is a DETERMINISTIC function of the frame index (no wall
 * clock) — a whole-body root turntable about +Y — so it exercises the full skin
 * chain while keeping the feet grounded, and the double-render canary stays
 * meaningful. Real ClipBinding sampling replaces `evalJointMatrices` when the
 * anim package lands.
 */
import {
  type Document,
  type Material,
  type Mesh,
  type Node,
  NodeIO,
  type Texture,
} from '@gltf-transform/core';
import { decode as decodePng } from 'fast-png';
import { BLEND_AS_CUTOUT_AT, type ModelBounds } from './contracts.ts';
import { type Mat4, mat4Identity, mat4Multiply, mat4RotationY } from './math.ts';

/**
 * A base color source. The two kinds are uploaded as different GPU formats on
 * purpose: an IMAGE is authored in sRGB and decodes to linear in hardware, but
 * a FACTOR is already a linear number and must not make the round trip — 8-bit
 * sRGB cannot represent it (0.55 encodes to byte 196, which decodes to
 * 0.552011, a ~0.4% error on every untextured material in the product).
 */
export type RenderTexture =
  | { kind: 'image'; rgba: Uint8Array; width: number; height: number }
  | { kind: 'factor'; linear: [number, number, number, number] };

/**
 * A material as the GPU needs it. The unit of binding is the MATERIAL, not the
 * texture, because glTF base color is `factor × texture` and two materials may
 * share one texture with different factors — so the factor cannot be folded
 * into the deduped texels (contracts.ts, THE MATERIAL CONTRACT).
 */
export interface RenderMaterial {
  /** index into SkinnedAsset.textures */
  texture: number;
  /** linear baseColorFactor, multiplied with the sampled texel */
  factor: [number, number, number, number];
  /** MASK discards below `alphaCutoff`; OPAQUE ignores alpha entirely */
  alphaMode: 'OPAQUE' | 'MASK';
  alphaCutoff: number;
}

/** One draw range of the concatenated index buffer, bound to one material. */
export interface PrimitiveRange {
  firstIndex: number;
  indexCount: number;
  /** index into SkinnedAsset.materials */
  material: number;
}

export interface SkinnedAsset {
  positions: Float32Array; // vec3 per vertex
  normals: Float32Array; // vec3 per vertex
  joints: Uint32Array; // 4 joint indices per vertex (upconverted)
  weights: Float32Array; // 4 weights per vertex
  uvs: Float32Array; // vec2 per vertex (zeros when a primitive has no TEXCOORD_0)
  indices: Uint32Array; // triangle list
  /** per-primitive index ranges — the renderer binds ranges[i].material per draw */
  ranges: PrimitiveRange[];
  /** deduped base color images; an untextured material gets a 1x1 white one */
  textures: RenderTexture[];
  /** deduped materials, one bind group each */
  materials: RenderMaterial[];
  jointCount: number;
  /** joint node names, in skin joint order (poses files map onto these BY NAME) */
  jointNames: string[];
  /** bind-pose LOCAL matrix per joint (column-major, 16 floats each) */
  bindLocals: Float32Array;
  /** parent joint index, -1 for roots; parents always precede children */
  jointParents: Int32Array;
  /** inverse bind matrix per joint (16 floats each) */
  inverseBind: Float32Array;
  /** bind-pose bounds (canonical frame: feet on Y=0, scaled to declared height) */
  bounds: ModelBounds;
}

function toU32(src: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

function concatF32(parts: Float32Array[]): Float32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function concatU32(parts: Uint32Array[]): Uint32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The legacy clay constant, now the NO-MATERIAL fallback (was hardcoded in the FS). */
const CLAY_LINEAR: [number, number, number, number] = [0.55, 0.32, 0.18, 1];

function factorTexture(linearRgba: [number, number, number, number]): RenderTexture {
  return { kind: 'factor', linear: linearRgba };
}

/** Decode a glTF PNG image to 8-bit RGBA (any channel count / 16-bit in). */
function decodeToRgba(png: Uint8Array, label: string): RenderTexture {
  const img = decodePng(png);
  const n = img.width * img.height;
  const ch = img.channels;
  const rgba = new Uint8Array(n * 4);
  const to8 = img.depth === 16 ? (v: number) => v >> 8 : (v: number) => v;
  for (let i = 0; i < n; i++) {
    const s = i * ch;
    const d = i * 4;
    if (ch >= 3) {
      rgba[d] = to8(img.data[s]);
      rgba[d + 1] = to8(img.data[s + 1]);
      rgba[d + 2] = to8(img.data[s + 2]);
      rgba[d + 3] = ch === 4 ? to8(img.data[s + 3]) : 255;
    } else {
      const g = to8(img.data[s]);
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = ch === 2 ? to8(img.data[s + 1]) : 255;
    }
  }
  if (rgba.length !== n * 4) throw new Error(`${label}: texture decode size mismatch`);
  return { kind: 'image', rgba, width: img.width, height: img.height };
}

/** Column-major identity test — the fast path that keeps today's bytes exact. */
function isIdentityMat4(m: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) {
    if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
  }
  return true;
}

/**
 * Refuse a transform whose upper-3x3 is not a SIMILARITY (uniform scale times
 * a rotation; mirrors allowed). shaders.wgsl transforms normals by the
 * upper-3x3 and the FS renormalizes, which is exact for a similarity and
 * silently wrong for a shear or a non-uniform scale — the kind of wrong that
 * shows up as mis-lit pixels nobody can trace back. Mirrors pass on purpose:
 * for M3 = s·Q the inverse-transpose is (1/s)·Q, identical in direction after
 * renormalizing, even when det Q = -1. (Only winding flips, and the pipeline
 * runs cullMode 'none' — enabling backface culling would change that.)
 */
function assertSimilarity(m: ArrayLike<number>, nodeName: string, label: string): void {
  // column-major: columns 0,1,2 are the basis vectors
  const col = (c: number): [number, number, number] => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const [x, y, z] = [col(0), col(1), col(2)];
  const len = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);
  const dot = (a: [number, number, number], b: [number, number, number]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [lx, ly, lz] = [len(x), len(y), len(z)];
  const scale = (lx + ly + lz) / 3;
  if (scale === 0) {
    throw new Error(`${label}: node "${nodeName}" has a degenerate (zero-scale) transform`);
  }
  const tol = 1e-4 * scale;
  const uneven = Math.abs(lx - ly) > tol || Math.abs(ly - lz) > tol || Math.abs(lx - lz) > tol;
  const skewed = Math.abs(dot(x, y)) > tol * scale ||
    Math.abs(dot(y, z)) > tol * scale ||
    Math.abs(dot(x, z)) > tol * scale;
  if (uneven || skewed) {
    throw new Error(
      `${label}: node "${nodeName}" has a ${
        uneven ? 'non-uniform scale' : 'skewed'
      } transform (axis lengths ${lx.toFixed(4)}, ${ly.toFixed(4)}, ${lz.toFixed(4)}) — the ` +
        'renderer transforms normals by the upper-3x3, which is only correct for a uniform ' +
        'scale times a rotation. Bake the transform into the mesh, or make the scale uniform.',
    );
  }
}

/**
 * Where a mesh sits in the scene. glTF places geometry through NODES, so the
 * node is the only thing that can say where a mesh is — and until this existed
 * the renderer never asked, which is why a socketed prop baked at the origin
 * and why an unskinned canonical mesh lost the importer's height normalization
 * (it lives on the root node's matrix, never on the vertices).
 */
interface MeshPlacement {
  node: Node;
  /** the node binds a skin: glTF says its OWN transform must be ignored */
  skinned: boolean;
  /** rest world matrix to bake into POSITION/NORMAL; null = identity or skinned */
  world: Float32Array | null;
  /** joint a rigid mesh rigid-binds to (nearest ancestor joint; 0 when none) */
  joint: number;
}

/**
 * The nearest joint at or above `node`. Starts AT the node: a node may legally
 * be both a joint and carry an unskinned mesh, and since `jointWorld · IBM = I`
 * at rest its own transform is not double-applied.
 */
function nearestAncestorJoint(node: Node, jointIndex: Map<Node, number>): number {
  for (let n: Node | null = node; n; n = n.getParentNode()) {
    const i = jointIndex.get(n);
    if (i !== undefined) return i;
  }
  return 0; // no joint above it: ride joint 0 (the root, or the static identity joint)
}

/**
 * The one node that draws each mesh, in `listMeshes()` order — the SAME order
 * the vertex streams concatenate in, which is what `packages/rig/apply.ts` and
 * `packages/rig/fit.ts` pin their flat vertex indices against.
 */
function placeMeshes(
  meshes: Mesh[],
  jointIndex: Map<Node, number>,
  label: string,
): Map<Mesh, MeshPlacement> {
  const out = new Map<Mesh, MeshPlacement>();
  for (const mesh of meshes) {
    const nodes = mesh.listParents().filter((p): p is Node => p.propertyType === 'Node');
    if (nodes.length === 0) {
      throw new Error(
        `${label}: mesh "${mesh.getName()}" is not referenced by any node — a mesh can only ` +
          'be placed in the scene through a node, so there is nowhere to draw it',
      );
    }
    if (nodes.length > 1) {
      throw new Error(
        `${label}: mesh "${mesh.getName()}" is drawn by ${nodes.length} nodes ` +
          `(${nodes.map((n) => `"${n.getName()}"`).join(', ')}) — instancing is not supported, ` +
          'because one flat vertex stream cannot hold two placements of the same buffer. ' +
          'Duplicate the mesh, one per node.',
      );
    }
    const node = nodes[0];
    const skinned = node.getSkin() !== null;
    // A skinned mesh node's own transform is ignored per the glTF spec (the
    // skin's joints place it); an identity transform needs no work, and
    // leaving `world` null there is what keeps the byte-exact fast path.
    let world: Float32Array | null = null;
    if (!skinned) {
      const m = node.getWorldMatrix();
      if (!isIdentityMat4(m)) {
        assertSimilarity(m, node.getName(), label);
        world = Float32Array.from(m);
      }
    }
    out.set(mesh, {
      node,
      skinned,
      world,
      joint: skinned ? 0 : nearestAncestorJoint(node, jointIndex),
    });
  }
  return out;
}

/** `m · p` as a POINT (translation applied), into a fresh array. */
function transformedPositions(src: Float32Array, m: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

/**
 * `m` as a DIRECTION (upper-3x3, no translation), renormalized. Exact for the
 * similarity transforms assertSimilarity admits — see shaders.wgsl, which does
 * the same thing with the skin matrix.
 */
function transformedNormals(src: Float32Array, m: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    const nx = m[0] * x + m[4] * y + m[8] * z;
    const ny = m[1] * x + m[5] * y + m[9] * z;
    const nz = m[2] * x + m[6] * y + m[10] * z;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      out[i] = nx / len;
      out[i + 1] = ny / len;
      out[i + 2] = nz / len;
    }
  }
  return out;
}

function boundsOf(positions: Float32Array): ModelBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

export async function loadSkinnedAsset(path: string): Promise<SkinnedAsset> {
  const doc = await new NodeIO().readBinary(await Deno.readFile(path));
  return documentToAsset(doc, path);
}

/**
 * Build a render asset from a glTF-Transform Document. Split out from the file
 * reader so the concatenation path is unit-testable without a binary fixture.
 * Every primitive of every mesh is folded into one vertex/index stream (indices
 * offset per primitive), in `listMeshes()` order — the order packages/rig pins
 * its flat vertex indices against.
 *
 * Placement follows the NODE that draws each mesh:
 *   - a SKINNED node's own transform is ignored (glTF spec — its joints place it);
 *   - a rigid node's rest world transform is baked into the vertices, and the
 *     mesh rigid-binds to the nearest joint at or above it, so it rides that
 *     joint through an animation (joint 0 when there is none).
 */
export function documentToAsset(doc: Document, label: string): SkinnedAsset {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  if (meshes.length === 0) throw new Error(`${label}: no mesh to render`);

  const skins = root.listSkins();
  if (skins.length > 1) throw new Error(`${label}: multiple skins unsupported (P2-T1)`);
  const skin = skins[0];

  // joint node -> joint index, needed BEFORE the geometry loop so a rigid mesh
  // can name the joint it hangs from. The skeleton block below reuses it.
  const jointNodes = skin ? skin.listJoints() : [];
  const nodeIndex = new Map(jointNodes.map((n, i) => [n, i]));
  // Resolve where every mesh sits before touching geometry, so a document we
  // cannot place fails naming the mesh rather than drawing it somewhere
  // arbitrary.
  const placements = placeMeshes(meshes, nodeIndex, label);

  const posParts: Float32Array[] = [];
  const nrmParts: Float32Array[] = [];
  const jntParts: Uint32Array[] = [];
  const wgtParts: Float32Array[] = [];
  const uvParts: Float32Array[] = [];
  const idxParts: Uint32Array[] = [];
  const ranges: PrimitiveRange[] = [];
  const textures: RenderTexture[] = [];
  const materials: RenderMaterial[] = [];
  // dedupe images by glTF Texture identity, materials by glTF Material
  // identity. They are separate maps because the SAME texture can appear in
  // two materials with different factors — folding the factor into the texels
  // would make those two collide.
  const textureIndex = new Map<Texture | string, number>();
  const materialIndex = new Map<Material | string, number>();
  let vertexBase = 0;
  let indexBase = 0;

  /** A 1x1 opaque white image, so an untextured material is factor x white. */
  const whiteTexture = () => {
    const key = 'image:white';
    let idx = textureIndex.get(key);
    if (idx === undefined) {
      idx = textures.push(factorTexture([1, 1, 1, 1])) - 1;
      textureIndex.set(key, idx);
    }
    return idx;
  };

  const imageTextureFor = (tex: Texture) => {
    let idx = textureIndex.get(tex);
    if (idx === undefined) {
      const mime = tex.getMimeType();
      if (mime && mime !== 'image/png') {
        throw new Error(
          `${label}: base color texture is ${mime} — only PNG is supported ` +
            `(the importer border emits PNG)`,
        );
      }
      const image = tex.getImage();
      if (!image) throw new Error(`${label}: base color texture has no image payload`);
      idx = textures.push(decodeToRgba(image, label)) - 1;
      textureIndex.set(tex, idx);
    }
    return idx;
  };

  const materialFor = (prim: ReturnType<typeof meshes[number]['listPrimitives']>[number]) => {
    const mat = prim.getMaterial();
    if (!mat) {
      // no material at all: the legacy clay constant, so pre-material fixtures
      // render exactly as they did before this file learned about materials
      const key = 'material:clay';
      let idx = materialIndex.get(key);
      if (idx === undefined) {
        idx = materials.push({
          texture: whiteTexture(),
          factor: [...CLAY_LINEAR] as [number, number, number, number],
          alphaMode: 'OPAQUE',
          alphaCutoff: 0,
        }) - 1;
        materialIndex.set(key, idx);
      }
      return idx;
    }

    let idx = materialIndex.get(mat);
    if (idx === undefined) {
      const tex = mat.getBaseColorTexture();
      const f = mat.getBaseColorFactor();
      const declared = mat.getAlphaMode();
      const alphaMode = declared === 'OPAQUE' ? 'OPAQUE' : 'MASK';
      const alphaCutoff = declared === 'MASK' ? mat.getAlphaCutoff() : BLEND_AS_CUTOUT_AT;
      // BLEND becomes a cutout at 0.5 (contracts.ts: the AOV pass declares no
      // blend state and depth/mask are not blendable), and the cutout tests the
      // TEXTURE's alpha alone — factor alpha is dropped to 1.
      //
      // Because a uniform factor carries no SHAPE. glTF alpha is
      // factor.a * texture.a, so keeping the factor would compare a constant
      // against the cutoff and discard either everything or nothing: a cape at
      // 40% opacity vanished from every AOV, which is not "hard-edged" as the
      // contract promises but absent. The texture's alpha is the only part with
      // a silhouette in it, so it is the only part a cutout can honour.
      //
      // MASK keeps the full glTF product on purpose. There, factor.a below the
      // cutoff discarding everything IS the spec, and it is the author saying
      // the surface is fully transparent rather than us guessing.
      const alphaFactor = declared === 'BLEND' ? 1 : f[3];
      idx = materials.push({
        texture: tex ? imageTextureFor(tex) : whiteTexture(),
        factor: [f[0], f[1], f[2], alphaFactor],
        alphaMode,
        alphaCutoff,
      }) - 1;
      materialIndex.set(mat, idx);
    }
    return idx;
  };

  for (const mesh of meshes) {
    const place = placements.get(mesh)!;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!.getArray() as Float32Array;
      const vcount = pos.length / 3;
      // A transform is baked into a COPY: `pos` is the accessor's own array,
      // and mutating it would rewrite the Document under the caller.
      posParts.push(place.world ? transformedPositions(pos, place.world) : pos);

      const nrmAcc = prim.getAttribute('NORMAL');
      if (!nrmAcc) {
        throw new Error(`${label}: primitive missing NORMAL (the importer generates them)`);
      }
      const nrm = nrmAcc.getArray() as Float32Array;
      nrmParts.push(place.world ? transformedNormals(nrm, place.world) : nrm);

      const jAcc = prim.getAttribute('JOINTS_0');
      const wAcc = prim.getAttribute('WEIGHTS_0');
      if (place.skinned && jAcc && wAcc) {
        jntParts.push(toU32(jAcc.getArray() as ArrayLike<number>));
        wgtParts.push(wAcc.getArray() as Float32Array);
      } else {
        if (!place.skinned && (jAcc || wAcc)) {
          throw new Error(
            `${label}: mesh "${mesh.getName()}" carries skin attributes but node ` +
              `"${place.node.getName()}" binds no skin — those joint indices address a ` +
              'skeleton this primitive is not attached to',
          );
        }
        // Rigid-bind every vertex to ONE joint with weight 1. At rest that is
        // the identity (jointWorld · inverseBind = I), so the vertices land
        // exactly where `world` put them; when the joint animates they ride
        // it. This is what carries a socketed prop with the hand.
        //
        // PRECONDITION: IBM_j = inverse(rest world of j), which is what the
        // importer produces and what fit.ts asserts (assertRestRoundTrip).
        const j = new Uint32Array(vcount * 4);
        const w = new Float32Array(vcount * 4);
        for (let i = 0; i < vcount; i++) {
          j[i * 4] = place.joint;
          w[i * 4] = 1;
        }
        jntParts.push(j);
        wgtParts.push(w);
      }

      const uvAcc = prim.getAttribute('TEXCOORD_0');
      if (!uvAcc) uvParts.push(new Float32Array(vcount * 2));
      else {
        const arr = uvAcc.getArray()!;
        if (arr instanceof Float32Array) uvParts.push(arr);
        else {
          // quantized UVs (u8/u16 normalized) from vendor files: expand to f32
          const scale = uvAcc.getNormalized()
            ? (arr instanceof Uint8Array ? 1 / 255 : 1 / 65535)
            : 1;
          const out = new Float32Array(arr.length);
          for (let i = 0; i < arr.length; i++) out[i] = arr[i] * scale;
          uvParts.push(out);
        }
      }

      const iAcc = prim.getIndices();
      let indexCount: number;
      if (iAcc) {
        const src = iAcc.getArray() as ArrayLike<number>;
        const out = new Uint32Array(src.length);
        for (let i = 0; i < src.length; i++) out[i] = src[i] + vertexBase;
        idxParts.push(out);
        indexCount = out.length;
      } else {
        const out = new Uint32Array(vcount);
        for (let i = 0; i < vcount; i++) out[i] = vertexBase + i;
        idxParts.push(out);
        indexCount = out.length;
      }
      ranges.push({ firstIndex: indexBase, indexCount, material: materialFor(prim) });
      indexBase += indexCount;
      vertexBase += vcount;
    }
  }

  const positions = concatF32(posParts);
  const bounds = boundsOf(positions);
  const common = {
    positions,
    normals: concatF32(nrmParts),
    joints: concatU32(jntParts),
    weights: concatF32(wgtParts),
    uvs: concatF32(uvParts),
    indices: concatU32(idxParts),
    ranges,
    textures,
    materials,
    bounds,
  };

  if (!skin) {
    // static: one identity joint (every vertex was rigid-bound to it above)
    return {
      ...common,
      jointCount: 1,
      jointNames: ['<static>'],
      bindLocals: mat4Identity(),
      jointParents: Int32Array.of(-1),
      inverseBind: mat4Identity(),
    };
  }

  const jointCount = jointNodes.length;

  const parentOf = new Map<typeof jointNodes[number], typeof jointNodes[number]>();
  const walk = (n: typeof jointNodes[number]) => {
    for (const c of n.listChildren()) {
      parentOf.set(c, n);
      walk(c);
    }
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n);

  const bindLocals = new Float32Array(jointCount * 16);
  const jointParents = new Int32Array(jointCount);
  jointNodes.forEach((j, i) => {
    bindLocals.set(j.getMatrix() as number[], i * 16);
    const p = parentOf.get(j);
    const pi = p ? (nodeIndex.get(p) ?? -1) : -1;
    if (pi >= i) throw new Error(`${label}: joint order — parent must precede child`);
    jointParents[i] = pi;
  });

  return {
    ...common,
    jointCount,
    jointNames: jointNodes.map((j) => j.getName()),
    bindLocals,
    jointParents,
    inverseBind: skin.getInverseBindMatrices()!.getArray() as Float32Array,
  };
}

/**
 * Pose sources:
 *  - 'turntable': whole-body rotation about +Y (directions/goldens fixture pose).
 *  - 'idle': a gentle low-amplitude sway about +Y — the near-static loop the
 *    flicker metric needs. Frame 0 is the bind pose in both.
 *  - 'clip': play a poses artifact (P3-T1) — handled by evalPosesMatrices; it
 *    never reaches the test-pose driver below.
 */
export type PoseMode = 'turntable' | 'idle' | 'clip';

function rootAngle(pose: PoseMode, frame: number): number {
  if (pose === 'idle') return 0.03 * Math.sin(frame * 0.4);
  if (pose === 'clip') return 0; // unreachable via the renderer's clip branch
  return frame * 0.06;
}

export function jointScratch(asset: SkinnedAsset): { mats: Float32Array; worlds: Float32Array } {
  return {
    mats: new Float32Array(asset.jointCount * 16),
    worlds: new Float32Array(asset.jointCount * 16),
  };
}

const scratchDelta: Mat4 = new Float32Array(16);
const scratchLocal: Mat4 = new Float32Array(16);

/**
 * Skinning matrices (world * inverseBind) for `frame` into `out`. Deterministic
 * per frame index — the test pose is a whole-body turntable: the ROOT joint
 * rotates about +Y and every child rides at its bind local. Rotation about the
 * vertical through the feet keeps the feet plane on world Y=0 (so feet-baseline
 * framing stays exact) and, for an axis-centered character, keeps the silhouette
 * within the bind-pose bounds — while still changing every joint's world matrix
 * per frame, so the storage-buffer skin path is exercised. Frame 0 is the exact
 * bind pose. Real ClipBinding sampling replaces this when the anim package lands.
 */
export function evalJointMatrices(
  asset: SkinnedAsset,
  frame: number,
  out: Float32Array,
  worlds: Float32Array,
  pose: PoseMode = 'turntable',
): void {
  const angle = rootAngle(pose, frame);
  for (let i = 0; i < asset.jointCount; i++) {
    const bind = asset.bindLocals.subarray(i * 16, i * 16 + 16);
    // root rotates about Y (through the grounded feet); children ride at bind
    if (i === 0) mat4RotationY(angle, scratchDelta);
    else mat4Identity(scratchDelta);
    mat4Multiply(bind, scratchDelta, scratchLocal);

    const world = worlds.subarray(i * 16, i * 16 + 16);
    const p = asset.jointParents[i];
    if (p < 0) world.set(scratchLocal);
    else mat4Multiply(worlds.subarray(p * 16, p * 16 + 16), scratchLocal, world);

    mat4Multiply(
      world,
      asset.inverseBind.subarray(i * 16, i * 16 + 16),
      out.subarray(i * 16, i * 16 + 16),
    );
  }
}

/**
 * Skinning matrices for one poses-file frame: local matrices come from the
 * poses blob (mapped by name; unmapped joints play their bind locals), then the
 * same world/IBM composition as evalJointMatrices. `map` is
 * poses.mapPosesJoints's asset-index -> poses-index table.
 */
export function evalPosesMatrices(
  asset: SkinnedAsset,
  posesData: Float32Array,
  map: Int32Array,
  jointsPerFrame: number,
  frame: number,
  out: Float32Array,
  worlds: Float32Array,
): void {
  const base = frame * jointsPerFrame * 16;
  for (let i = 0; i < asset.jointCount; i++) {
    const pi = map[i];
    const local = pi >= 0
      ? posesData.subarray(base + pi * 16, base + pi * 16 + 16)
      : asset.bindLocals.subarray(i * 16, i * 16 + 16);

    const world = worlds.subarray(i * 16, i * 16 + 16);
    const p = asset.jointParents[i];
    if (p < 0) world.set(local);
    else mat4Multiply(worlds.subarray(p * 16, p * 16 + 16), local, world);

    mat4Multiply(
      world,
      asset.inverseBind.subarray(i * 16, i * 16 + 16),
      out.subarray(i * 16, i * 16 + 16),
    );
  }
}

/** posedBounds, but driven by a poses blob instead of the test-pose driver. */
export function posedBoundsFromPoses(
  asset: SkinnedAsset,
  posesData: Float32Array,
  map: Int32Array,
  jointsPerFrame: number,
  frames: number,
): ModelBounds {
  const mats = new Float32Array(asset.jointCount * 16);
  const worlds = new Float32Array(asset.jointCount * 16);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const { positions: p, joints: J, weights: W } = asset;
  const vcount = p.length / 3;

  for (let f = 0; f < Math.max(1, frames); f++) {
    evalPosesMatrices(asset, posesData, map, jointsPerFrame, f, mats, worlds);
    for (let v = 0; v < vcount; v++) {
      const px = p[v * 3], py = p[v * 3 + 1], pz = p[v * 3 + 2];
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) {
        const wgt = W[v * 4 + k];
        if (wgt === 0) continue;
        const j = J[v * 4 + k] * 16;
        x += wgt * (mats[j] * px + mats[j + 4] * py + mats[j + 8] * pz + mats[j + 12]);
        y += wgt * (mats[j + 1] * px + mats[j + 5] * py + mats[j + 9] * pz + mats[j + 13]);
        z += wgt * (mats[j + 2] * px + mats[j + 6] * py + mats[j + 10] * pz + mats[j + 14]);
      }
      if (x < min[0]) min[0] = x;
      if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y;
      if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z;
      if (z > max[2]) max[2] = z;
    }
  }
  return { min, max };
}

/**
 * Union AABB of the SKINNED vertices over frames [0, frames) — the stable
 * per-clip bounds the framing solver must use so near/far bracketing and the
 * bracketing hold for the animated pose, not just the bind pose (a rotating or
 * moving silhouette sweeps outside the bind AABB). CPU mirror of the vertex
 * shader's skin blend; deterministic.
 */
export function posedBounds(
  asset: SkinnedAsset,
  frames: number,
  pose: PoseMode = 'turntable',
): ModelBounds {
  const mats = new Float32Array(asset.jointCount * 16);
  const worlds = new Float32Array(asset.jointCount * 16);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const { positions: p, joints: J, weights: W } = asset;
  const vcount = p.length / 3;
  const nf = Math.max(1, frames);

  for (let f = 0; f < nf; f++) {
    evalJointMatrices(asset, f, mats, worlds, pose);
    for (let v = 0; v < vcount; v++) {
      const px = p[v * 3], py = p[v * 3 + 1], pz = p[v * 3 + 2];
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 4; k++) {
        const wgt = W[v * 4 + k];
        if (wgt === 0) continue;
        const j = J[v * 4 + k] * 16;
        x += wgt * (mats[j] * px + mats[j + 4] * py + mats[j + 8] * pz + mats[j + 12]);
        y += wgt * (mats[j + 1] * px + mats[j + 5] * py + mats[j + 9] * pz + mats[j + 13]);
        z += wgt * (mats[j + 2] * px + mats[j + 6] * py + mats[j + 10] * pz + mats[j + 14]);
      }
      if (x < min[0]) min[0] = x;
      if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y;
      if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z;
      if (z > max[2]) max[2] = z;
    }
  }
  return { min, max };
}
