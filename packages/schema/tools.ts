import { z } from 'zod';
import { LicenseInfoSchema, WeightFileSchema } from './registry.ts';

const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const relativePath = WeightFileSchema.shape.path;
const installedPath = z.string().min(1).regex(/^[^\\:\0]+$/).refine((path) =>
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
);

/** Optional external programs; never model adapters or executable community plugins. */
export const ToolCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tools: z.array(z.strictObject({
    id: z.literal('blender'),
    displayName: z.string().min(1),
    version,
    license: LicenseInfoSchema,
    sourceUrl: z.url(),
    releaseUrl: z.url(),
    downloads: z.array(z.strictObject({
      os: z.enum(['win32', 'darwin', 'linux']),
      arch: z.enum(['x64', 'arm64']),
      archive: WeightFileSchema,
      prefix: relativePath,
      executable: relativePath,
      executableSha256: digest,
      expandedBytes: z.int().positive(),
      requiredDiskBytes: z.int().positive(),
    })),
  })).length(1),
});
export type ToolEntry = z.output<typeof ToolCatalogSchema>['tools'][number];

const receipt = {
  schemaVersion: z.literal(1),
  id: z.literal('blender'),
  version,
  executable: z.string().min(1),
  executableSha256: digest,
  licenseAccepted: z.literal(true),
};
export const ToolReceiptSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...receipt, mode: z.literal('external') }),
  z.strictObject({
    ...receipt,
    mode: z.literal('managed'),
    archiveSha256: digest,
    files: z.array(
      z.strictObject({ path: installedPath, bytes: z.int().nonnegative(), sha256: digest }),
    )
      .min(1),
  }),
]);
export type ToolReceipt = z.output<typeof ToolReceiptSchema>;
