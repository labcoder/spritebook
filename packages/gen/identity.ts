/**
 * The identity layer (P3-T4, Track A): everything that makes two characters on
 * ONE shared body different from each other.
 *
 * Track A's whole bet is that the skeleton, the UV layout and the animation
 * bindings are IDENTICAL across a roster (schema/roster.ts) — that is what makes
 * a hundred characters tractable. The cost of that bet is that identity can no
 * longer come from the rig, so it has to come from the surface. Three passes,
 * in ascending order of how much they change:
 *
 *   1. `compositeDecals`   paints into the character's texture (UV space)
 *   2. `applyAttachments`  hangs new meshes off the skeleton's sockets
 *   3. `applyBoneMask`     replaces whole regions of the body with new geometry
 *
 * All three are deliberately PURE CPU and file-to-file, like reproject.ts: a
 * deterministic pass over glTF + PNG bytes, testable exactly, no GPU lane
 * needed. And all three are ADDITIVE to the shared body — pass 1 and 2 never
 * touch a vertex position (asserted, not assumed), and pass 3 only removes what
 * the caller explicitly asked to replace.
 *
 * ## Mirroring here is opt-in too (D-008)
 *
 * A decal defaults to `mirrored: false` and then lands on EXACTLY ONE region.
 * That is not a detail — it is the founding constraint: a tattoo the user put on
 * one arm belongs on one arm, and a roster tool that helpfully copies it to the
 * other arm has broken the product's promise. The side partner is found by
 * NAMING and cross-checked against `BodyRegion.side`, never by geometry (the
 * P0-T4 lesson that geometric side detection ties itself to float noise).
 *
 * The naming rule mirrors `packages/rig/edits.ts` `sidePartner` — duplicated
 * rather than imported, because a region id is not a joint name and the two
 * charsets differ: `BodyRegionSchema.id` is `[a-z0-9-]+`, which cannot spell
 * `forearm_l` at all. So the patterns below are that function's rule PLUS the
 * hyphen and prefix spellings the region charset actually permits.
 *
 * ## Materials that survive a copy
 *
 * Attachment and replacement meshes are copied into the target document with
 * core glTF only (no `mergeDocuments`, which lives in a package this one does
 * not depend on). The copy carries geometry, node transforms and CORE PBR
 * material state — base color factor + texture, metallic/roughness, emissive,
 * alpha mode, double-sidedness. Extension-based materials (clearcoat,
 * transmission, …) are not carried; a prop that needs them is a canonical-import
 * problem, not a socket problem.
 */
import {
  type Accessor,
  type Document,
  type Material,
  type Mesh,
  type Node,
  NodeIO,
  type Primitive,
  type Skin,
} from '@gltf-transform/core';
import { decode as decodePng, encode as encodePng } from 'fast-png';
import type {
  AttachmentPlacement,
  BodyRegion,
  BoneMask,
  CanonicalBody,
  DecalPlacement,
} from '@spritebook/schema';

// ---------------------------------------------------------------------------
// Shared glTF plumbing
// ---------------------------------------------------------------------------

const io = new NodeIO();

async function readDoc(path: string, what: string): Promise<Document> {
  try {
    return await io.readBinary(await Deno.readFile(path));
  } catch (err) {
    throw new Error(`${what}: cannot read "${path}" (${(err as Error).message})`);
  }
}

/**
 * Every POSITION array, concatenated in `listMeshes()`/`listPrimitives()` order
 * — the geometry fingerprint the decal and attachment passes promise not to
 * change. Compared as BYTES so a NaN or a -0 cannot slip through a `===`.
 */
function positionBytes(doc: Document): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const array = pos.getArray()!;
      parts.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice());
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Write `doc`, then re-read it and prove the ORIGINAL vertex positions came back
 * bit-identical.
 *
 * `mode: 'exact'` is the decal promise — the file's geometry is the geometry it
 * arrived with. `mode: 'appended'` is the attachment promise — the body's own
 * vertices are unchanged and everything new sits after them, which holds because
 * copied meshes are created after the read and glTF-Transform writes meshes in
 * creation order. If that ever stopped being true this check would FAIL rather
 * than pass quietly, which is the safe direction for a guarantee.
 */
async function writeVerifyingGeometry(
  doc: Document,
  before: Uint8Array,
  outPath: string,
  what: string,
  mode: 'exact' | 'appended' = 'exact',
): Promise<void> {
  await Deno.writeFile(outPath, await io.writeBinary(doc));
  const after = positionBytes(await readDoc(outPath, what));
  const grew = mode === 'appended' ? after.length >= before.length : after.length === before.length;
  if (!grew) {
    throw new Error(
      `${what}: the body's vertex count changed (${before.length / 4} -> ` +
        `${after.length / 4} floats) - this pass must never touch existing geometry`,
    );
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      throw new Error(
        `${what}: vertex positions changed at byte ${i} - this pass adds to the body and ` +
          'must never move what is already there',
      );
    }
  }
}

/** The one buffer a GLB is allowed; every accessor we create lands in it. */
function glbBuffer(doc: Document) {
  return doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
}

type TypedArray = ReturnType<Accessor['getArray']> & ArrayLike<number>;

function copyAccessor(dst: Document, src: Accessor, name = ''): Accessor {
  const array = src.getArray()!;
  const copy = new (array.constructor as new (n: number) => TypedArray)(array.length) as
    & TypedArray
    & { set(a: ArrayLike<number>): void };
  copy.set(array);
  return dst.createAccessor(name)
    .setType(src.getType())
    .setNormalized(src.getNormalized())
    .setArray(copy as never)
    .setBuffer(glbBuffer(dst));
}

/** Copy core PBR state; extension materials are out of scope (module header). */
function copyMaterial(dst: Document, src: Material): Material {
  const mat = dst.createMaterial(src.getName())
    .setBaseColorFactor(src.getBaseColorFactor())
    .setMetallicFactor(src.getMetallicFactor())
    .setRoughnessFactor(src.getRoughnessFactor())
    .setEmissiveFactor(src.getEmissiveFactor())
    .setAlphaMode(src.getAlphaMode())
    .setDoubleSided(src.getDoubleSided());
  if (src.getAlphaMode() === 'MASK') mat.setAlphaCutoff(src.getAlphaCutoff());
  const tex = src.getBaseColorTexture();
  const image = tex?.getImage();
  if (tex && image) {
    mat.setBaseColorTexture(
      dst.createTexture(tex.getName())
        .setImage(image.slice())
        .setMimeType(tex.getMimeType()),
    );
  }
  return mat;
}

/**
 * Copy one primitive into `dst`. `transform` (a column-major mat4) is applied to
 * POSITION and, via its upper 3x3, to NORMAL — needed when a mesh authored under
 * a transformed node is folded into a skinned mesh, whose vertices live in bind
 * space and whose node transform glTF ignores.
 */
function copyPrimitive(
  dst: Document,
  src: Primitive,
  materials: Map<Material, Material>,
  transform?: ArrayLike<number>,
): Primitive {
  const prim = dst.createPrimitive().setMode(src.getMode());
  for (const semantic of src.listSemantics()) {
    const acc = copyAccessor(dst, src.getAttribute(semantic)!, semantic);
    if (transform && (semantic === 'POSITION' || semantic === 'NORMAL')) {
      applyMat4(acc.getArray() as Float32Array, transform, semantic === 'POSITION');
    }
    prim.setAttribute(semantic, acc);
  }
  const indices = src.getIndices();
  if (indices) prim.setIndices(copyAccessor(dst, indices, 'indices'));
  const material = src.getMaterial();
  if (material) {
    let copied = materials.get(material);
    if (!copied) {
      copied = copyMaterial(dst, material);
      materials.set(material, copied);
    }
    prim.setMaterial(copied);
  }
  return prim;
}

/**
 * Drop an accessor this primitive is the last user of. glTF-Transform keeps
 * orphaned accessors in the root list and the writer serializes them, so
 * replacing or removing a primitive without this quietly leaves its old vertex
 * data in the file — a character glb that grows every time it is re-masked.
 */
function disposeIfSole(prim: Primitive, accessor: Accessor | null): void {
  if (!accessor) return;
  const users = accessor.listParents().filter((p) => p.propertyType === 'Primitive');
  if (users.length === 1 && users[0] === prim) accessor.dispose();
}

/** Remove a primitive and the vertex data nothing else references. */
function disposePrimitive(prim: Primitive): void {
  for (const semantic of prim.listSemantics()) disposeIfSole(prim, prim.getAttribute(semantic));
  disposeIfSole(prim, prim.getIndices());
  prim.dispose();
}

/** In-place `v -> M v` over a packed vec3 array (w = 1 for points, 0 for normals). */
function applyMat4(v: Float32Array, m: ArrayLike<number>, isPoint: boolean): void {
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    const w = isPoint ? 1 : 0;
    v[i] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    v[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    v[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  }
}

/** Copy a node subtree (transforms, meshes, children) into `dst`. */
function copyNodeTree(dst: Document, src: Node, materials: Map<Material, Material>): Node {
  const node = dst.createNode(src.getName())
    .setTranslation(src.getTranslation())
    .setRotation(src.getRotation())
    .setScale(src.getScale());
  const mesh = src.getMesh();
  if (mesh) {
    const copy = dst.createMesh(mesh.getName());
    for (const prim of mesh.listPrimitives()) {
      copy.addPrimitive(copyPrimitive(dst, prim, materials));
    }
    node.setMesh(copy);
  }
  for (const child of src.listChildren()) node.addChild(copyNodeTree(dst, child, materials));
  return node;
}

/** The document's skin, with an actionable throw when there is nothing to bind to. */
function requireSkin(doc: Document, what: string, path: string): Skin {
  const skins = doc.getRoot().listSkins();
  if (skins.length === 0) {
    throw new Error(
      `${what}: "${path}" has no skin - sockets and bone masks address the shared body's ` +
        'skeleton, so rig the mesh (`spritebook rig`) before applying identity',
    );
  }
  return skins[0];
}

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

/**
 * `_l`/`_r`, `-l`/`-r`, `.L`/`.R`, `Left`/`Right`, `left-`/`right-`. The first
 * four are `packages/rig/edits.ts`'s joint rule verbatim; the rest are the same
 * rule spelled the way `BodyRegionSchema.id`'s charset allows (no underscores).
 */
const SIDE_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^(.*)_l$/i, (m) => `${m[1]}_r`],
  [/^(.*)_r$/i, (m) => `${m[1]}_l`],
  [/^(.*)-l$/i, (m) => `${m[1]}-r`],
  [/^(.*)-r$/i, (m) => `${m[1]}-l`],
  [/^(.*)\.L$/, (m) => `${m[1]}.R`],
  [/^(.*)\.R$/, (m) => `${m[1]}.L`],
  [/^Left(.*)$/, (m) => `Right${m[1]}`],
  [/^Right(.*)$/, (m) => `Left${m[1]}`],
  [/^left-(.*)$/, (m) => `right-${m[1]}`],
  [/^right-(.*)$/, (m) => `left-${m[1]}`],
];

/** The name of a region's side partner, by NAMING only, or null. */
export function sidePartnerRegion(regionId: string): string | null {
  for (const [re, swap] of SIDE_PATTERNS) {
    const m = regionId.match(re);
    if (m) return swap(m);
  }
  return null;
}

export interface UvRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TexelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DecalLanding {
  id: string;
  /** the region it was placed by, or null for an explicit `uvRect` */
  region: string | null;
  /** the integer texel rect it was composited into */
  rect: TexelRect;
  /** texels this composite actually changed — 0 means the decal MISSED */
  changedTexels: number;
  /** true for the flipped copy a `mirrored: true` decal puts on the partner */
  mirrored: boolean;
}

export interface DecalReport {
  textureSize: number;
  /** one entry per composite, in draw order; a mirrored decal makes TWO */
  landings: DecalLanding[];
  /** distinct texels changed by all decals together */
  changedTexels: number;
  /** ids whose composite changed nothing — a silent miss, made loud */
  missed: string[];
  /** name of the material whose texture was painted (absent: model had none) */
  material?: string;
  /** non-fatal notes the caller should surface (an ambiguous atlas choice) */
  warnings: string[];
}

export interface CompositeDecalsOptions {
  /** the character glb whose base color texture is painted */
  modelPath: string;
  decals: DecalPlacement[];
  /** region lookup for decals placed by name (required unless every decal has a uvRect) */
  body?: CanonicalBody;
  outPath: string;
  /** override the texture size; defaults to the existing texture's, else 512 */
  textureSize?: number;
}

function regionsOf(body: CanonicalBody | undefined): string {
  return body ? body.regions.map((r) => r.id).sort().join(', ') : '(no body supplied)';
}

/** Resolve a decal's UV rect: explicit wins, else the named region's. */
function resolveRect(decal: DecalPlacement, body: CanonicalBody | undefined): {
  rect: UvRect;
  region: string | null;
} {
  if (decal.uvRect) return { rect: decal.uvRect, region: null };
  if (!decal.region) {
    throw new Error(
      `decal "${decal.id}" has neither a uvRect nor a region - it has nowhere to land; ` +
        `name a region (${regionsOf(body)}) or place it by hand with uvRect`,
    );
  }
  if (!body) {
    throw new Error(
      `decal "${decal.id}" names region "${decal.region}", but no canonical body was ` +
        'supplied to look it up - pass `body`, or place the decal with an explicit uvRect',
    );
  }
  const region = body.regions.find((r) => r.id === decal.region);
  if (!region) {
    throw new Error(
      `decal "${decal.id}" names region "${decal.region}", which body "${body.id}" does not ` +
        `have - available regions: ${regionsOf(body)}`,
    );
  }
  return { rect: region.uvRect, region: region.id };
}

/** The region a mirrored decal's flipped copy belongs to (D-008 side partner). */
function partnerRegionOf(decal: DecalPlacement, regionId: string, body: CanonicalBody): UvRect {
  const region = body.regions.find((r) => r.id === regionId)!;
  if (region.side === 'center') {
    throw new Error(
      `decal "${decal.id}" is mirrored onto region "${regionId}", but that region is on the ` +
        "body's centre line and has no side partner - drop `mirrored` (a centre decal is " +
        'already on both halves)',
    );
  }
  const partnerId = sidePartnerRegion(regionId);
  const partner = partnerId ? body.regions.find((r) => r.id === partnerId) : undefined;
  if (!partner) {
    throw new Error(
      `decal "${decal.id}" is mirrored, but region "${regionId}" (side ${region.side}) has no ` +
        `side partner in body "${body.id}"${partnerId ? ` - looked for "${partnerId}"` : ''}; ` +
        `available regions: ${regionsOf(body)}`,
    );
  }
  if (partner.side === region.side) {
    throw new Error(
      `decal "${decal.id}": region "${regionId}" and its name partner "${partner.id}" are both ` +
        `side "${region.side}" - the body's naming and its \`side\` fields disagree, and ` +
        'mirroring must never guess which one is right',
    );
  }
  return partner.uvRect;
}

/** UV rect -> integer texel rect, clamped to the texture and never empty. */
function texelRect(rect: UvRect, size: number, what: string): TexelRect {
  const x = Math.min(size - 1, Math.max(0, Math.round(rect.x * size)));
  const y = Math.min(size - 1, Math.max(0, Math.round(rect.y * size)));
  const w = Math.min(size - x, Math.max(0, Math.round(rect.w * size)));
  const h = Math.min(size - y, Math.max(0, Math.round(rect.h * size)));
  if (w === 0 || h === 0) {
    throw new Error(
      `${what}: its rect is ${w}x${h} texels on a ${size}px texture - too small to paint; ` +
        'raise the texture size or widen the rect',
    );
  }
  return { x, y, w, h };
}

/** Nearest-neighbour sample of an RGBA image into `w x h` (crisp, deterministic). */
function resampleNearest(
  src: Uint8Array,
  sw: number,
  sh: number,
  w: number,
  h: number,
  flipX: boolean,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / h));
    for (let x = 0; x < w; x++) {
      const tx = flipX ? w - 1 - x : x;
      const sx = Math.min(sw - 1, Math.floor(((tx + 0.5) * sw) / w));
      const s = (sy * sw + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return out;
}

/**
 * The texels a region actually OWNS, rasterized from the mesh itself: a
 * triangle belongs to the region when the majority of its vertices are
 * dominantly skinned to the region's joints, and its UV footprint is filled
 * into the mask. This is what makes a region a real address on a vendor
 * atlas: the AABB uvRect of scattered UV islands spans most of the page
 * (ubc-male's arm-l rect is 0.996 wide), so an unclipped decal painted the
 * whole character — both arms included, perfectly mirrored, which is the one
 * thing D-008 exists to prevent. And because an underivable mask would fall
 * straight back into that whole-page paint, it REFUSES (rather than returns
 * nothing) when the model carries no skeleton or none of the region's joints
 * — the two ways a body manifest can fail to describe the model it is aimed
 * at. uvRect-placed decals never come here: explicit coordinates are the
 * author's own aim.
 */
function regionTexelMask(
  doc: Document,
  material: Material | undefined,
  region: BodyRegion,
  size: number,
  what: string,
): Uint8Array {
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) {
    throw new Error(
      `${what} is placed by region "${region.id}", but the model has no skeleton to derive ` +
        'region ownership from - a region is the set of texels its joints own. Fit the ' +
        'canonical body first (spritebook rig --track-a), or place the decal by uvRect to ' +
        'paint explicit coordinates',
    );
  }
  const jointNames = skin.listJoints().map((j) => j.getName());
  const owned = new Set<number>();
  jointNames.forEach((n, i) => {
    if (region.joints.includes(n)) owned.add(i);
  });
  if (owned.size === 0) {
    throw new Error(
      `${what}: none of region "${region.id}"'s joints (${region.joints.join(', ')}) exist in ` +
        "the model's skeleton - this body manifest does not describe this model, and painting " +
        'anyway would cover the whole page rect instead of the region. Check that the body ' +
        'passed to identity is the one the model was fitted from',
    );
  }

  const mask = new Uint8Array(size * size);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (material && prim.getMaterial() !== material) continue;
      const uv = prim.getAttribute('TEXCOORD_0')?.getArray();
      const jn = prim.getAttribute('JOINTS_0')?.getArray();
      const wt = prim.getAttribute('WEIGHTS_0')?.getArray();
      const pos = prim.getAttribute('POSITION');
      if (!uv || !jn || !wt || !pos) continue;
      const vcount = pos.getCount();

      const dominantOwned = new Uint8Array(vcount);
      for (let v = 0; v < vcount; v++) {
        let best = -1;
        let bw = -1;
        for (let k = 0; k < 4; k++) {
          const w = wt[v * 4 + k];
          if (w > bw) {
            bw = w;
            best = jn[v * 4 + k];
          }
        }
        if (owned.has(best)) dominantOwned[v] = 1;
      }

      const idxAcc = prim.getIndices();
      const idx = idxAcc?.getArray();
      const triCount = (idx ? idx.length : vcount) / 3;
      for (let t = 0; t < triCount; t++) {
        const a = idx ? idx[t * 3] : t * 3;
        const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
        const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
        if (dominantOwned[a] + dominantOwned[b] + dominantOwned[c] < 2) continue;
        rasterizeUvTriangle(mask, size, uv, a, b, c);
      }
    }
  }
  return mask;
}

/** Fill one triangle's UV footprint into `mask` (texel-center sampling). */
function rasterizeUvTriangle(
  mask: Uint8Array,
  size: number,
  uv: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): void {
  const ax = uv[a * 2] * size, ay = uv[a * 2 + 1] * size;
  const bx = uv[b * 2] * size, by = uv[b * 2 + 1] * size;
  const cx = uv[c * 2] * size, cy = uv[c * 2 + 1] * size;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
  const sign = area > 0 ? 1 : -1;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sign;
      const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sign;
      const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sign;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) mask[y * size + x] = 1;
    }
  }
}

/**
 * Straight-alpha "over" of one decal into the texture, counting the texels it
 * really changed. The count is the point: a decal whose region resolved to the
 * wrong island, or whose PNG is fully transparent, changes nothing — and a
 * silent no-op is exactly how a user concludes the feature is broken.
 * `mask` (when given) clips paint to the texels the target region owns.
 */
function alphaOver(
  base: Uint8Array,
  size: number,
  rect: TexelRect,
  decal: Uint8Array,
  touched: Uint8Array,
  mask?: Uint8Array,
): number {
  let changed = 0;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (mask && !mask[(rect.y + y) * size + rect.x + x]) continue;
      const s = (y * rect.w + x) * 4;
      const a = decal[s + 3];
      if (a === 0) continue;
      const at = ((rect.y + y) * size + rect.x + x) * 4;
      const inv = 255 - a;
      // round-half-up integer compositing: deterministic, no float drift
      const next = [
        (decal[s] * a + base[at] * inv + 127) / 255 | 0,
        (decal[s + 1] * a + base[at + 1] * inv + 127) / 255 | 0,
        (decal[s + 2] * a + base[at + 2] * inv + 127) / 255 | 0,
        (a * 255 + base[at + 3] * inv + 127) / 255 | 0,
      ];
      let differs = false;
      for (let c = 0; c < 4; c++) {
        if (base[at + c] !== next[c]) differs = true;
        base[at + c] = next[c];
      }
      if (differs) {
        changed++;
        touched[(rect.y + y) * size + rect.x + x] = 1;
      }
    }
  }
  return changed;
}

/**
 * The material whose base color texture decals paint. Named explicitly by the
 * body manifest when there is one (region uvRects are authored against ONE
 * texture's UV space); otherwise the material of the LARGEST primitive — a
 * character's body always out-verts its hair and eyes, and `listMaterials()[0]`
 * once painted a tattoo into the ubc-male HAIR atlas, invisibly.
 */
function resolveBodyMaterial(
  doc: Document,
  bodyMaterial: string | undefined,
  what: string,
  warnings: string[],
): Material | undefined {
  const materials = doc.getRoot().listMaterials();
  if (bodyMaterial !== undefined) {
    const hit = materials.find((m) => m.getName() === bodyMaterial);
    if (!hit) {
      throw new Error(
        `${what}: the body manifest names material "${bodyMaterial}" but the model has ` +
          `[${materials.map((m) => m.getName()).join(', ')}] — a decal painted into the ` +
          `wrong atlas lands invisibly, so this refuses instead`,
      );
    }
    return hit;
  }
  let best: Material | undefined;
  let bestVerts = -1;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      const verts = prim.getAttribute('POSITION')?.getCount() ?? 0;
      if (verts > bestVerts) {
        bestVerts = verts;
        best = mat;
      }
    }
  }
  // With several atlases and nothing naming the right one, the biggest
  // primitive is a heuristic, not a fact - an armoured character whose plate
  // out-verts its skin would take the paint on the armour. Say so: a wrong
  // atlas is INVISIBLE in the output, so silence here reads as success.
  if (best && materials.length > 1) {
    warnings.push(
      `${what}: this model has ${materials.length} materials and the body manifest does not ` +
        `name one, so decals were painted into "${best.getName()}" (the largest primitive's). ` +
        'If that is the wrong atlas the decals are invisible - set bodyMaterial on the body ' +
        'manifest to pin it.',
    );
  }
  return best ?? materials[0];
}

/** Read the model's base color texels (or a neutral base when it has none). */
function baseTexture(
  material: Material | undefined,
  requested?: number,
): { rgba: Uint8Array; size: number } {
  const image = material?.getBaseColorTexture()?.getImage();
  if (!image) {
    const size = requested ?? 512;
    const rgba = new Uint8Array(size * size * 4).fill(200);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return { rgba, size };
  }
  const decoded = decodePng(image);
  // Normalize to RGBA HERE, at the decode boundary: a base texture is
  // whatever the generator emitted, and fixture-gen (among others) writes
  // 3-channel RGB. Every stride computation below assumes 4 channels, so an
  // un-normalized RGB base died inside fast-png with "wrong data size" —
  // found by the identity job's decal test on a plainly-picked fixture mesh.
  const src = toRgba(decoded.data, decoded.channels ?? 4, decoded.depth ?? 8);
  const size = requested ?? Math.max(decoded.width, decoded.height);
  if (decoded.width === size && decoded.height === size) return { rgba: src, size };
  return { rgba: resampleNearest(src, decoded.width, decoded.height, size, size, false), size };
}

/** Any PNG channel layout -> RGBA (grey, grey+alpha, RGB, RGBA). */
function toRgba(data: ArrayLike<number>, channels: number, depth = 8): Uint8Array {
  // 16-bit samples arrive as a Uint16Array. Writing those into a Uint8Array
  // wraps mod 256 (65280 -> 0), which is a silent colour corruption rather
  // than an error, so the high byte is taken explicitly.
  const to8 = depth === 16 ? (v: number) => v >>> 8 : (v: number) => v;
  const px = data.length / channels;
  const out = new Uint8Array(px * 4);
  for (let i = 0; i < px; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels >= 3) {
      out[d] = to8(data[s]);
      out[d + 1] = to8(data[s + 1]);
      out[d + 2] = to8(data[s + 2]);
      out[d + 3] = channels === 4 ? to8(data[s + 3]) : 255;
    } else if (channels === 2) {
      out[d] = out[d + 1] = out[d + 2] = to8(data[s]);
      out[d + 3] = to8(data[s + 1]);
    } else {
      out[d] = out[d + 1] = out[d + 2] = to8(data[s]);
      out[d + 3] = 255;
    }
  }
  return out;
}

/**
 * Bake UV-space decals into a character's base color texture.
 *
 * Decals are composited in `z` order, ties broken by input order (a STABLE
 * sort), so "higher z wins where two overlap" is true and re-running the pass on
 * the same manifest paints the same texels. Geometry is verified untouched after
 * the write.
 */
export async function compositeDecals(opts: CompositeDecalsOptions): Promise<DecalReport> {
  const what = 'decals';
  const doc = await readDoc(opts.modelPath, what);
  const before = positionBytes(doc);
  const warnings: string[] = [];
  const bodyMat = resolveBodyMaterial(doc, opts.body?.bodyMaterial, what, warnings);
  const { rgba, size } = baseTexture(bodyMat, opts.textureSize);
  const touched = new Uint8Array(size * size);

  // stable sort by z: Array.prototype.sort IS stable in every engine we target,
  // but ordering by (z, index) says so explicitly rather than relying on it
  const ordered = opts.decals
    .map((decal, index) => ({ decal, index }))
    .sort((a, b) => a.decal.z - b.decal.z || a.index - b.index);

  // texel-ownership masks, one per region actually painted (raster is O(tris)).
  // A region-placed decal ALWAYS gets a mask or a refusal - never a silent
  // fall-through to the raw AABB rect (the whole-page paint of the review's P0).
  const maskCache = new Map<string, Uint8Array>();
  const maskFor = (decalId: string, regionId: string | null): Uint8Array | undefined => {
    if (!regionId || !opts.body) return undefined; // uvRect placement: explicit coordinates
    let mask = maskCache.get(regionId);
    if (!mask) {
      const r = opts.body.regions.find((x) => x.id === regionId);
      if (!r) {
        throw new Error(
          `decal "${decalId}": region "${regionId}" is not in body "${opts.body.id}" - ` +
            `available: ${opts.body.regions.map((x) => x.id).join(', ')}`,
        );
      }
      mask = regionTexelMask(doc, bodyMat, r, size, `decal "${decalId}"`);
      maskCache.set(regionId, mask);
    }
    return mask;
  };

  const landings: DecalLanding[] = [];
  for (const { decal } of ordered) {
    const { rect, region } = resolveRect(decal, opts.body);
    const png = decodePng(await Deno.readFile(decal.pngPath));
    if (png.channels !== 4) {
      throw new Error(
        `decal "${decal.id}": "${decal.pngPath}" has ${png.channels} channels - a decal must ` +
          'be RGBA, because its alpha is what decides which texels it paints',
      );
    }
    // 16-bit decals decode to Uint16Array; narrow explicitly (see toRgba)
    const src = toRgba(png.data, 4, png.depth ?? 8);

    const target = texelRect(rect, size, `decal "${decal.id}"`);
    landings.push({
      id: decal.id,
      region,
      rect: target,
      mirrored: false,
      changedTexels: alphaOver(
        rgba,
        size,
        target,
        resampleNearest(src, png.width, png.height, target.w, target.h, false),
        touched,
        maskFor(decal.id, region),
      ),
    });

    // D-008: only an explicitly mirrored decal touches a second region. The
    // default path above has already finished, having painted exactly one.
    if (!decal.mirrored) continue;
    if (!region || !opts.body) {
      throw new Error(
        `decal "${decal.id}" is mirrored, but it was placed by uvRect rather than by region - ` +
          'the side partner is found by region naming, so a mirrored decal must name a region',
      );
    }
    const partnerRect = texelRect(
      partnerRegionOf(decal, region, opts.body),
      size,
      `decal "${decal.id}" (mirrored)`,
    );
    landings.push({
      id: decal.id,
      region: sidePartnerRegion(region),
      rect: partnerRect,
      mirrored: true,
      changedTexels: alphaOver(
        rgba,
        size,
        partnerRect,
        resampleNearest(src, png.width, png.height, partnerRect.w, partnerRect.h, true),
        touched,
        maskFor(decal.id, sidePartnerRegion(region)),
      ),
    });
  }

  const png = encodePng({ width: size, height: size, data: rgba });
  const root = doc.getRoot();
  let painted = bodyMat;
  const texture = painted?.getBaseColorTexture();
  if (texture) {
    texture.setImage(png).setMimeType('image/png');
  } else {
    const tex = doc.createTexture('identity').setImage(png).setMimeType('image/png');
    const mat = painted ?? doc.createMaterial('identity');
    mat.setBaseColorTexture(tex);
    if (!painted) {
      for (const mesh of root.listMeshes()) {
        for (const prim of mesh.listPrimitives()) prim.setMaterial(mat);
      }
      painted = mat;
    }
  }
  await writeVerifyingGeometry(doc, before, opts.outPath, what);

  return {
    textureSize: size,
    landings,
    changedTexels: touched.reduce((n, v) => n + v, 0),
    missed: landings.filter((l) => l.changedTexels === 0).map((l) => l.id),
    ...(painted ? { material: painted.getName() } : {}),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** A socket as `RigState.sockets` records it: an id, a bone, a local offset. */
export interface SocketSpec {
  id: string;
  bone: string;
  localOffset: number[];
}

export interface AttachmentLanding {
  id: string;
  socketId: string;
  /** the joint node the mesh now hangs from */
  bone: string;
  /** socket offset + the placement's nudge, applied on the wrapper node */
  offset: [number, number, number];
  meshes: number;
  primitives: number;
  vertices: number;
}

export interface AttachmentReport {
  attached: AttachmentLanding[];
  /** non-fatal notes the caller should surface; the job yields them as warns */
  warnings: string[];
}

export interface ApplyAttachmentsOptions {
  modelPath: string;
  attachments: AttachmentPlacement[];
  /** RigState.sockets */
  sockets: SocketSpec[];
  outPath: string;
}

function countGeometry(node: Node): { meshes: number; primitives: number; vertices: number } {
  let meshes = 0, primitives = 0, vertices = 0;
  const walk = (n: Node) => {
    const mesh = n.getMesh();
    if (mesh) {
      meshes++;
      for (const prim of mesh.listPrimitives()) {
        primitives++;
        vertices += prim.getAttribute('POSITION')?.getCount() ?? 0;
      }
    }
    for (const child of n.listChildren()) walk(child);
  };
  walk(node);
  return { meshes, primitives, vertices };
}

/**
 * Merge socketed meshes into a character.
 *
 * Each attachment becomes a child NODE of its socket's joint node, so the glTF
 * node hierarchy makes it follow the animation for free — no second skin, no
 * per-frame bookkeeping, and the render seam needs to know nothing about it. The
 * socket's `localOffset` (plus the user's nudge, if any) rides on one wrapper
 * node per attachment, which keeps the offset inspectable instead of baked into
 * vertices.
 *
 * The body's own geometry is verified untouched: an attachment ADDS.
 */
export async function applyAttachments(
  opts: ApplyAttachmentsOptions,
): Promise<AttachmentReport> {
  const what = 'attachments';
  const doc = await readDoc(opts.modelPath, what);
  const before = positionBytes(doc);
  const skin = requireSkin(doc, what, opts.modelPath);

  const joints = new Map(skin.listJoints().map((j) => [j.getName(), j]));
  const socketIds = opts.sockets.map((s) => s.id).sort().join(', ') || '(none)';
  const attached: AttachmentLanding[] = [];

  for (const placement of opts.attachments) {
    const socket = opts.sockets.find((s) => s.id === placement.socketId);
    if (!socket) {
      throw new Error(
        `attachment "${placement.id}" names socket "${placement.socketId}", which this rig does ` +
          `not have - available sockets: ${socketIds}`,
      );
    }
    const joint = joints.get(socket.bone);
    if (!joint) {
      throw new Error(
        `socket "${socket.id}" hangs off bone "${socket.bone}", which the skin does not have - ` +
          `available joints: ${[...joints.keys()].sort().join(', ')}`,
      );
    }
    const source = await readDoc(placement.meshPath, `attachment "${placement.id}"`);
    if (source.getRoot().listSkins().length > 0) {
      throw new Error(
        `attachment "${placement.id}" ("${placement.meshPath}") carries its own skin - a socket ` +
          'takes a RIGID mesh and animates it through the joint it hangs from; use a bone mask ' +
          'to replace skinned body geometry',
      );
    }

    const offset: [number, number, number] = [
      (socket.localOffset[0] ?? 0) + (placement.offset?.[0] ?? 0),
      (socket.localOffset[1] ?? 0) + (placement.offset?.[1] ?? 0),
      (socket.localOffset[2] ?? 0) + (placement.offset?.[2] ?? 0),
    ];
    const wrapper = doc.createNode(`attach-${placement.id}`).setTranslation(offset);
    const materials = new Map<Material, Material>();
    const scene = source.getRoot().getDefaultScene() ?? source.getRoot().listScenes()[0];
    const roots = scene ? scene.listChildren() : source.getRoot().listNodes();
    if (roots.length === 0) {
      throw new Error(
        `attachment "${placement.id}" ("${placement.meshPath}") has no nodes to attach`,
      );
    }
    for (const root of roots) wrapper.addChild(copyNodeTree(doc, root, materials));
    joint.addChild(wrapper);
    attached.push({
      id: placement.id,
      socketId: socket.id,
      bone: socket.bone,
      offset,
      ...countGeometry(wrapper),
    });
  }

  await writeVerifyingGeometry(doc, before, opts.outPath, what, 'appended');
  // A prop rides its joint through the glTF node hierarchy, which is what
  // every exporter honours - and now what our own renderer honours too
  // (packages/render/skinning.ts bakes a rigid mesh's node transform and
  // rigid-binds it to the nearest joint above it), so a socketed sword bakes
  // in the hand and stays there through a clip. `warnings` is kept because
  // the job surfaces it generically and the report shape should not churn.
  return { attached, warnings: [] };
}

// ---------------------------------------------------------------------------
// Bone masks
// ---------------------------------------------------------------------------

/**
 * A vertex belongs to a region when that region's joints together hold MORE than
 * this share of its skin weight. One half is the value that makes ownership
 * UNIQUE: weight rows sum to 1 (the rig writer guarantees it), so no vertex can
 * be majority-owned by two disjoint regions at once, and masking the head can
 * never quietly delete part of the hand.
 */
export const REGION_WEIGHT_FLOOR = 0.5;

export interface BoneMaskReplacement {
  region: string;
  meshPath: string;
  /** the region's joints, as the canonical body defines them */
  joints: string[];
  removedVertices: number;
  removedTriangles: number;
  insertedVertices: number;
  /** how the replacement rides the skeleton */
  binding: 'skinned' | 'rigid';
  /** set for a rigid binding: the joint the whole replacement follows */
  rigidJoint?: string;
  /** why it fell back to rigid, when it did */
  note?: string;
}

export interface BoneMaskReport {
  weightFloor: number;
  replaced: BoneMaskReplacement[];
}

export interface ApplyBoneMaskOptions {
  modelPath: string;
  /** region id -> the mesh that replaces it (schema BoneMask) */
  mask: BoneMask;
  body: CanonicalBody;
  outPath: string;
  /** override REGION_WEIGHT_FLOOR (0..1, exclusive of 1) */
  weightFloor?: number;
}

interface SkinRow {
  joints: Uint32Array;
  weights: Float32Array;
}

function readRows(prim: Primitive, what: string): SkinRow {
  const j = prim.getAttribute('JOINTS_0');
  const w = prim.getAttribute('WEIGHTS_0');
  if (!j || !w) {
    throw new Error(
      `${what}: a primitive of the body has no JOINTS_0/WEIGHTS_0 - a bone mask selects ` +
        'geometry by joint influence, so the body must be skinned',
    );
  }
  return { joints: Uint32Array.from(j.getArray()!), weights: Float32Array.from(w.getArray()!) };
}

/** Rebuild an attribute from the kept vertices; reuse the accessor when we own it. */
function compactAttribute(doc: Document, prim: Primitive, semantic: string, keep: number[]): void {
  const acc = prim.getAttribute(semantic)!;
  const array = acc.getArray()!;
  const stride = array.length / acc.getCount();
  const next = new (array.constructor as new (n: number) => TypedArray)(keep.length * stride) as
    & TypedArray
    & { [i: number]: number };
  for (const [to, from] of keep.entries()) {
    for (let c = 0; c < stride; c++) next[to * stride + c] = array[from * stride + c];
  }
  const shared = acc.listParents().filter((p) => p.propertyType === 'Primitive').length > 1;
  if (shared) {
    prim.setAttribute(
      semantic,
      doc.createAccessor(semantic)
        .setType(acc.getType())
        .setNormalized(acc.getNormalized())
        .setArray(next as never)
        .setBuffer(glbBuffer(doc)),
    );
  } else {
    acc.setArray(next as never);
  }
}

/**
 * Replace named regions of the shared body with a character's own geometry —
 * the escape hatch that keeps a roster from being one body in different hats.
 *
 * ## What gets cut, and the falloff
 *
 * A vertex belongs to the region when its region joints hold more than
 * `weightFloor` (default REGION_WEIGHT_FLOOR) of its skin weight. A TRIANGLE is
 * removed only when ALL THREE of its vertices belong. That all-three rule IS the
 * falloff: the ring of triangles straddling the seam stays with the neighbour,
 * so the replacement overlaps the body by roughly one triangle instead of
 * leaving a hole. For a sprite pipeline an overlap costs nothing and a hole is a
 * gap in the silhouette — the only thing a sprite is made of.
 *
 * ## How the replacement is bound
 *
 * If it arrives skinned and every joint it names exists in the body's skin, its
 * weights are remapped by NAME onto the body's skin (the body's rest pose is
 * authoritative — a replacement is authored against the canonical body). If it
 * has no skin, it is bound RIGIDLY to the region's dominant joint, which is
 * reported: a rigid forearm does not bend at the elbow, and the caller must be
 * able to see that it chose that.
 */
export async function applyBoneMask(opts: ApplyBoneMaskOptions): Promise<BoneMaskReport> {
  const what = 'bone mask';
  const floor = opts.weightFloor ?? REGION_WEIGHT_FLOOR;
  if (!(floor >= 0 && floor < 1)) {
    throw new Error(`${what}: weightFloor must be in [0, 1), got ${floor}`);
  }
  const doc = await readDoc(opts.modelPath, what);
  const skin = requireSkin(doc, what, opts.modelPath);
  const jointNames = skin.listJoints().map((j) => j.getName());
  const jointIndex = new Map(jointNames.map((n, i) => [n, i]));

  // every mesh the skin drives is cut from; the first one receives the
  // replacements, so they are skinned by the same skin with no extra node
  const skinnedMeshes: Mesh[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (node.getSkin() !== skin || !mesh || skinnedMeshes.includes(mesh)) continue;
    skinnedMeshes.push(mesh);
  }
  if (skinnedMeshes.length === 0) {
    throw new Error(`${what}: "${opts.modelPath}" has a skin but no node binds it to a mesh`);
  }
  const targetMesh = skinnedMeshes[0];

  const replaced: BoneMaskReplacement[] = [];
  for (const [regionId, meshPath] of Object.entries(opts.mask)) {
    const region = opts.body.regions.find((r) => r.id === regionId);
    if (!region) {
      throw new Error(
        `${what}: region "${regionId}" is not part of body "${opts.body.id}" - available ` +
          `regions: ${regionsOf(opts.body)}`,
      );
    }
    const regionJoints: number[] = [];
    for (const name of region.joints) {
      const index = jointIndex.get(name);
      if (index === undefined) {
        throw new Error(
          `${what}: region "${regionId}" is defined by joint "${name}", which this character's ` +
            `skin does not have - available joints: ${[...jointNames].sort().join(', ')}`,
        );
      }
      regionJoints.push(index);
    }
    const inRegion = new Set(regionJoints);

    // 1. cut the region out of every primitive the skin drives
    let removedVertices = 0, removedTriangles = 0;
    const jointMass = new Map<number, number>(regionJoints.map((j) => [j, 0]));
    for (const mesh of skinnedMeshes) {
      for (const prim of [...mesh.listPrimitives()]) {
        const position = prim.getAttribute('POSITION');
        if (!position) continue;
        const rows = readRows(prim, what);
        const count = position.getCount();
        const belongs = new Uint8Array(count);
        for (let v = 0; v < count; v++) {
          let share = 0;
          for (let k = 0; k < 4; k++) {
            const w = rows.weights[v * 4 + k];
            if (w > 0 && inRegion.has(rows.joints[v * 4 + k])) share += w;
          }
          belongs[v] = share > floor ? 1 : 0;
          // the dominant joint is measured over the geometry actually removed,
          // so a rigid replacement follows the joint that owned what it replaces
          if (!belongs[v]) continue;
          for (let k = 0; k < 4; k++) {
            const j = rows.joints[v * 4 + k];
            const w = rows.weights[v * 4 + k];
            if (w > 0 && inRegion.has(j)) jointMass.set(j, jointMass.get(j)! + w);
          }
        }

        const indices = prim.getIndices();
        const tri = indices
          ? Uint32Array.from(indices.getArray()!)
          : Uint32Array.from({ length: count }, (_v, i) => i);
        const kept: number[] = [];
        let cut = 0;
        for (let t = 0; t < tri.length; t += 3) {
          // the falloff: a triangle goes only when ALL of it belongs
          if (belongs[tri[t]] && belongs[tri[t + 1]] && belongs[tri[t + 2]]) {
            cut++;
            continue;
          }
          kept.push(tri[t], tri[t + 1], tri[t + 2]);
        }
        if (cut === 0) continue;
        removedTriangles += cut;

        if (kept.length === 0) {
          removedVertices += count;
          mesh.removePrimitive(prim);
          disposePrimitive(prim);
          continue;
        }
        // compact: keep only vertices some surviving triangle still references
        const remap = new Int32Array(count).fill(-1);
        const keepList: number[] = [];
        for (const v of kept) {
          if (remap[v] === -1) {
            remap[v] = keepList.length;
            keepList.push(v);
          }
        }
        removedVertices += count - keepList.length;
        for (const semantic of prim.listSemantics()) {
          compactAttribute(doc, prim, semantic, keepList);
        }
        const next = keepList.length <= 0xffff
          ? Uint16Array.from(kept, (v) => remap[v])
          : Uint32Array.from(kept, (v) => remap[v]);
        prim.setIndices(
          doc.createAccessor('indices')
            .setType('SCALAR')
            .setArray(next as never)
            .setBuffer(glbBuffer(doc)),
        );
      }
    }

    // 2. insert the replacement, bound to the same joints
    const source = await readDoc(meshPath, `${what} region "${regionId}"`);
    const sourceSkin = source.getRoot().listSkins()[0];
    const sourceNodes = sourceNodesWithMeshes(source);
    const missing = sourceSkin
      ? sourceSkin.listJoints().map((j) => j.getName()).filter((n) => !jointIndex.has(n))
      : [];
    const unweighted = sourceNodes.some((n) =>
      n.getMesh()!.listPrimitives().some((p) =>
        !p.getAttribute('JOINTS_0') || !p.getAttribute('WEIGHTS_0')
      )
    );
    const rigid = !sourceSkin || missing.length > 0 || unweighted;
    const dominant = regionJoints.reduce(
      (best, j) => (jointMass.get(j)! > jointMass.get(best)! ? j : best),
      regionJoints[0],
    );
    const materials = new Map<Material, Material>();
    let insertedVertices = 0;
    const remapSkin = sourceSkin
      ? Uint32Array.from(sourceSkin.listJoints(), (j) => jointIndex.get(j.getName()) ?? 0)
      : new Uint32Array();

    for (const node of sourceNodes) {
      // glTF ignores a SKINNED mesh node's own transform (its vertices are in
      // bind space), so the world matrix is baked in only for a rigid source
      const transform = sourceSkin ? undefined : (node.getWorldMatrix() as unknown as number[]);
      for (const srcPrim of node.getMesh()!.listPrimitives()) {
        const prim = copyPrimitive(doc, srcPrim, materials, transform);
        const count = prim.getAttribute('POSITION')?.getCount() ?? 0;
        insertedVertices += count;
        bindPrimitive(doc, prim, count, jointNames.length, rigid ? dominant : null, remapSkin);
        targetMesh.addPrimitive(prim);
      }
    }

    replaced.push({
      region: regionId,
      meshPath,
      joints: [...region.joints],
      removedVertices,
      removedTriangles,
      insertedVertices,
      binding: rigid ? 'rigid' : 'skinned',
      ...(rigid
        ? {
          rigidJoint: jointNames[dominant],
          note: missing.length > 0
            ? `replacement names joints this body does not have (${missing.join(', ')}), so it ` +
              `is bound rigidly to "${jointNames[dominant]}" and will not deform`
            : `replacement carries no skin weights, so it is bound rigidly to ` +
              `"${jointNames[dominant]}" and will not deform`,
        }
        : {}),
    });
  }

  // a mesh with zero primitives is invalid glTF — a region that consumed every
  // primitive of a mesh must take the mesh with it
  for (const mesh of skinnedMeshes) {
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }
  await Deno.writeFile(opts.outPath, await io.writeBinary(doc));
  return { weightFloor: floor, replaced };
}

/** Scene-order nodes that carry a mesh (so world transforms are meaningful). */
function sourceNodesWithMeshes(doc: Document): Node[] {
  const out: Node[] = [];
  const walk = (node: Node) => {
    if (node.getMesh()) out.push(node);
    for (const child of node.listChildren()) walk(child);
  };
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  for (const node of scene ? scene.listChildren() : doc.getRoot().listNodes()) walk(node);
  if (out.length === 0) throw new Error('bone mask: the replacement mesh file has no meshes');
  return out;
}

/**
 * Give a copied primitive the body's skin binding: either remap its own joint
 * indices by name, or (rigid) pin every vertex to one joint with weight 1 —
 * which at rest is the identity, because `jointWorld . inverseBind = I`.
 */
function bindPrimitive(
  doc: Document,
  prim: Primitive,
  count: number,
  jointCount: number,
  rigidJoint: number | null,
  remap: Uint32Array,
): void {
  const narrow = jointCount <= 256;
  const joints = narrow ? new Uint8Array(count * 4) : new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  if (rigidJoint === null) {
    const existing = prim.getAttribute('JOINTS_0')!.getArray()!;
    const existingWeights = prim.getAttribute('WEIGHTS_0')!.getArray()!;
    for (let i = 0; i < count * 4; i++) {
      joints[i] = remap[existing[i]] ?? 0;
      weights[i] = existingWeights[i];
    }
  } else {
    for (let v = 0; v < count; v++) {
      joints[v * 4] = rigidJoint;
      weights[v * 4] = 1;
    }
  }
  // the copied binding is superseded by the body's; don't leave it in the file
  disposeIfSole(prim, prim.getAttribute('JOINTS_0'));
  disposeIfSole(prim, prim.getAttribute('WEIGHTS_0'));
  prim.setAttribute(
    'JOINTS_0',
    doc.createAccessor('JOINTS_0').setType('VEC4').setArray(joints as never).setBuffer(
      glbBuffer(doc),
    ),
  );
  prim.setAttribute(
    'WEIGHTS_0',
    doc.createAccessor('WEIGHTS_0').setType('VEC4').setArray(weights).setBuffer(glbBuffer(doc)),
  );
}
