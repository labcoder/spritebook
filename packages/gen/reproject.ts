import { promises as fs } from 'node:fs';
/**
 * Detail reprojection (P3-T2): paint the SOURCE image back onto the picked
 * mesh's texture, so the fine detail a user chose the photo for survives
 * generation instead of being smoothed away by a latent decoder.
 *
 * Deliberately PURE CPU, like the NPR style stack: the pass is deterministic
 * on fixed inputs and runs GPU-free, which makes its tests exact and portable
 * (the P2-T2 lesson — a CPU stage is testable everywhere, a GPU stage needs a
 * hardware lane).
 *
 * ## The camera assumption, stated out loud
 *
 * Image-to-3D backends are conditioned on ONE front-facing view, and the
 * canonical form the border produces faces +Z at a known scale. So the source
 * image is treated as an ORTHOGRAPHIC front view fitted to the mesh's bounds
 * — the same framing convention the renderer uses. That is an approximation
 * of a real (unknown) generation camera, and it is why this pass only paints
 * what it can prove it sees:
 *
 *   1. a depth pre-pass rasterizes the mesh into SOURCE-IMAGE space and keeps
 *      the nearest z per pixel, so occluded geometry (an arm behind a torso)
 *      cannot steal the pixels in front of it;
 *   2. the UV pass writes a texel only when it is front-facing AND its depth
 *      matches that buffer AND the source pixel is opaque;
 *   3. every texel that fails those tests KEEPS its generated color, so the
 *      back of the head stays as the backend imagined it rather than becoming
 *      a smear of the front.
 *
 * A texel that is painted records full confidence; a short dilation afterwards
 * covers UV seams, where a texel's neighbours are painted but a rasterization
 * tie left it empty.
 */
import { type Document, NodeIO } from '@gltf-transform/core';
import { decode as decodePng } from 'fast-png';
import { encode as encodePng } from '@spritebook/render/png';

export interface ReprojectOptions {
  /** canonical glb whose baseColorTexture gets repainted */
  modelPath: string;
  /** the cut-out RGBA source image (alpha marks the subject) */
  imagePath: string;
  outPath: string;
  /** target texture size; defaults to the existing texture's size, else 512 */
  textureSize?: number;
  /** texels of seam dilation after painting (0 disables) */
  dilatePx?: number;
}

export interface ReprojectStats {
  textureSize: number;
  /** texels the projection could prove it saw */
  paintedTexels: number;
  /** texels that kept their generated color */
  keptTexels: number;
  /** paintedTexels / (painted + kept) */
  coverage: number;
  /** texels filled by seam dilation (included in paintedTexels) */
  dilatedTexels: number;
}

interface MeshArrays {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint32Array;
}

/** Pull the first textured primitive's arrays out of a Document. */
function readPrimitive(doc: Document): MeshArrays {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      const uv = prim.getAttribute('TEXCOORD_0');
      const normal = prim.getAttribute('NORMAL');
      const indices = prim.getIndices();
      if (!position || !uv) continue;
      if (!normal) {
        throw new Error(
          'reproject: the mesh has UVs but no NORMAL attribute, so front-facing texels ' +
            'cannot be distinguished from back-facing ones - re-import the model (the ' +
            'canonicalize step generates normals) before reprojecting',
        );
      }
      const count = position.getCount();
      const index = indices
        ? Uint32Array.from(indices.getArray()!)
        : Uint32Array.from({ length: count }, (_, i) => i);
      return {
        position: Float32Array.from(position.getArray()!),
        normal: Float32Array.from(normal.getArray()!),
        uv: Float32Array.from(uv.getArray()!),
        index,
      };
    }
  }
  throw new Error(
    'reproject: no primitive with POSITION and TEXCOORD_0 found - a mesh without UVs ' +
      'cannot receive a projected texture (it needs an unwrap stage first)',
  );
}

/** Axis-aligned bounds of the positions. */
function bounds(position: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], position[i + c]);
      max[c] = Math.max(max[c], position[i + c]);
    }
  }
  return { min, max };
}

/**
 * The orthographic front fit: world XY -> source-image pixels, preserving
 * aspect (letterboxed like the renderer's framing), +Y up mapping to image y
 * down. Returns the projector plus the world-space z used for depth.
 */
function frontProjector(position: Float32Array, imgW: number, imgH: number) {
  const { min, max } = bounds(position);
  const w = Math.max(max[0] - min[0], 1e-6);
  const h = Math.max(max[1] - min[1], 1e-6);
  // fit the mesh into the image preserving aspect — the same "one scale for
  // the whole subject" rule the camera solver uses
  const scale = Math.min(imgW / w, imgH / h);
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  return (x: number, y: number) => ({
    px: (x - cx) * scale + imgW / 2,
    py: imgH / 2 - (y - cy) * scale, // world +Y up -> image y down
  });
}

/** Barycentric weights of p in triangle (a,b,c); null when degenerate/outside. */
function bary(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
  eps: number,
): [number, number, number] | null {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-12) return null; // zero-area triangle
  const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  const l2 = 1 - l0 - l1;
  if (l0 < -eps || l1 < -eps || l2 < -eps) return null;
  return [l0, l1, l2];
}

/**
 * Pass 1 — rasterize into source-image space keeping the nearest z per pixel.
 * Without this, a texel on the back of an arm projects onto the same source
 * pixel as the chest in front of it and happily steals its color.
 */
function depthPrepass(
  m: MeshArrays,
  project: (x: number, y: number) => { px: number; py: number },
  imgW: number,
  imgH: number,
): Float32Array {
  const depth = new Float32Array(imgW * imgH).fill(-Infinity); // +Z toward viewer
  for (let t = 0; t < m.index.length; t += 3) {
    const i0 = m.index[t] * 3, i1 = m.index[t + 1] * 3, i2 = m.index[t + 2] * 3;
    const p0 = project(m.position[i0], m.position[i0 + 1]);
    const p1 = project(m.position[i1], m.position[i1 + 1]);
    const p2 = project(m.position[i2], m.position[i2 + 1]);
    const z0 = m.position[i0 + 2], z1 = m.position[i1 + 2], z2 = m.position[i2 + 2];
    const minX = Math.max(0, Math.floor(Math.min(p0.px, p1.px, p2.px)));
    const maxX = Math.min(imgW - 1, Math.ceil(Math.max(p0.px, p1.px, p2.px)));
    const minY = Math.max(0, Math.floor(Math.min(p0.py, p1.py, p2.py)));
    const maxY = Math.min(imgH - 1, Math.ceil(Math.max(p0.py, p1.py, p2.py)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const l = bary(p0.px, p0.py, p1.px, p1.py, p2.px, p2.py, x + 0.5, y + 0.5, 1e-6);
        if (!l) continue;
        const z = l[0] * z0 + l[1] * z1 + l[2] * z2;
        const at = y * imgW + x;
        if (z > depth[at]) depth[at] = z;
      }
    }
  }
  return depth;
}

/** Dilate painted texels into unpainted neighbours (UV seam cover). */
function dilate(
  rgba: Uint8Array,
  painted: Uint8Array,
  size: number,
  rounds: number,
): number {
  let filled = 0;
  for (let r = 0; r < rounds; r++) {
    const before = painted.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = y * size + x;
        if (before[at]) continue;
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const nat = ny * size + nx;
            if (!before[nat]) continue;
            sr += rgba[nat * 4];
            sg += rgba[nat * 4 + 1];
            sb += rgba[nat * 4 + 2];
            n++;
          }
        }
        if (n === 0) continue;
        rgba[at * 4] = Math.round(sr / n);
        rgba[at * 4 + 1] = Math.round(sg / n);
        rgba[at * 4 + 2] = Math.round(sb / n);
        rgba[at * 4 + 3] = 255;
        painted[at] = 1;
        filled++;
      }
    }
  }
  return filled;
}

/** Nearest-neighbour resample of an RGBA plane (keeps the generated base). */
function resample(
  src: Uint8Array,
  sw: number,
  sh: number,
  size: number,
): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / size));
      const s = (sy * sw + sx) * 4, d = (y * size + x) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return out;
}

/**
 * Repaint `modelPath`'s base color texture from `imagePath` and write
 * `outPath`. Geometry is untouched — only the texture image changes, so the
 * canonical mesh keeps its vertex bytes and its border provenance.
 */
export async function reprojectTexture(opts: ReprojectOptions): Promise<ReprojectStats> {
  const io = new NodeIO();
  const doc = await io.readBinary(new Uint8Array(await fs.readFile(opts.modelPath)));
  const m = readPrimitive(doc);

  const srcPng = decodePng(new Uint8Array(await fs.readFile(opts.imagePath)));
  if (srcPng.channels !== 4) {
    throw new Error(
      `reproject: source image must be RGBA (a cut-out); "${opts.imagePath}" has ` +
        `${srcPng.channels} channels - run \`spritebook prep\` on it first`,
    );
  }
  const src = srcPng.data as Uint8Array;
  const imgW = srcPng.width, imgH = srcPng.height;

  // the existing generated texture is the fallback for anything we cannot see
  const root = doc.getRoot();
  const material = root.listMaterials()[0];
  const baseTex = material?.getBaseColorTexture();
  const existing = baseTex?.getImage();
  let size = opts.textureSize ?? 512;
  let base: Uint8Array;
  if (existing) {
    const decoded = decodePng(existing);
    size = opts.textureSize ?? Math.max(decoded.width, decoded.height);
    base = resample(decoded.data as Uint8Array, decoded.width, decoded.height, size);
  } else {
    base = new Uint8Array(size * size * 4).fill(200);
    for (let i = 3; i < base.length; i += 4) base[i] = 255;
  }

  const project = frontProjector(m.position, imgW, imgH);
  const depth = depthPrepass(m, project, imgW, imgH);

  const rgba = base.slice();
  const painted = new Uint8Array(size * size);
  // depth tolerance scaled to the model — a fixed epsilon would be wrong for
  // a 0.2 m prop and a 2 m character alike
  const b = bounds(m.position);
  const depthTol = Math.max(1e-4, (b.max[2] - b.min[2]) * 0.02);

  for (let t = 0; t < m.index.length; t += 3) {
    const a = m.index[t], bIdx = m.index[t + 1], c = m.index[t + 2];
    const uvs = [a, bIdx, c].map((i) => ({ u: m.uv[i * 2], v: m.uv[i * 2 + 1] }));
    // glTF UV origin is top-left with v increasing downward
    const tp = uvs.map((q) => ({ x: q.u * size, y: q.v * size }));
    const minX = Math.max(0, Math.floor(Math.min(tp[0].x, tp[1].x, tp[2].x)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(tp[0].x, tp[1].x, tp[2].x)));
    const minY = Math.max(0, Math.floor(Math.min(tp[0].y, tp[1].y, tp[2].y)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(tp[0].y, tp[1].y, tp[2].y)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const l = bary(
          tp[0].x,
          tp[0].y,
          tp[1].x,
          tp[1].y,
          tp[2].x,
          tp[2].y,
          x + 0.5,
          y + 0.5,
          1e-6,
        );
        if (!l) continue;
        // interpolate world position + normal at this texel
        let wx = 0, wy = 0, wz = 0, nz = 0;
        const tri = [a, bIdx, c];
        for (let k = 0; k < 3; k++) {
          const i3 = tri[k] * 3;
          wx += l[k] * m.position[i3];
          wy += l[k] * m.position[i3 + 1];
          wz += l[k] * m.position[i3 + 2];
          nz += l[k] * m.normal[i3 + 2];
        }
        if (nz <= 1e-3) continue; // back-facing to a front camera
        const p = project(wx, wy);
        const sx = Math.floor(p.px), sy = Math.floor(p.py);
        if (sx < 0 || sy < 0 || sx >= imgW || sy >= imgH) continue;
        if (wz < depth[sy * imgW + sx] - depthTol) continue; // occluded
        const s = (sy * imgW + sx) * 4;
        if (src[s + 3] === 0) continue; // outside the cut-out subject
        const at = (y * size + x) * 4;
        rgba[at] = src[s];
        rgba[at + 1] = src[s + 1];
        rgba[at + 2] = src[s + 2];
        rgba[at + 3] = 255;
        painted[y * size + x] = 1;
      }
    }
  }

  const dilated = dilate(rgba, painted, size, opts.dilatePx ?? 2);
  const paintedTexels = painted.reduce((n, v) => n + v, 0);

  const png = encodePng({ width: size, height: size, data: rgba });
  if (baseTex) {
    baseTex.setImage(png).setMimeType('image/png');
  } else {
    const tex = doc.createTexture('reprojected').setImage(png).setMimeType('image/png');
    const mat = material ?? doc.createMaterial('reprojected');
    mat.setBaseColorTexture(tex);
    if (!material) {
      for (const mesh of root.listMeshes()) {
        for (const prim of mesh.listPrimitives()) prim.setMaterial(mat);
      }
    }
  }
  await fs.writeFile(opts.outPath, await io.writeBinary(doc));

  return {
    textureSize: size,
    paintedTexels,
    keptTexels: size * size - paintedTexels,
    coverage: paintedTexels / (size * size),
    dilatedTexels: dilated,
  };
}
