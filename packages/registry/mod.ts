/**
 * @spritebook/registry - the D-009 model registry: a committed catalog
 * (licenses, territories, platforms, VRAM floors, per-file sha256 pins), the
 * installed tree under the models root, project pins, the install gates, and
 * the install/verify/rm jobs speaking the JobEvent vocabulary. Backends are
 * catalog DATA, never hardcoded integrations, and nothing lands on disk
 * unverified - the trust anchor is the hash, never the download source.
 */
export * from './catalog.ts';
export * from './installed.ts';
export * from './virtualization.ts';
export * from './pins.ts';
export * from './gates.ts';
export * from './hash.ts';
export * from './install.ts';

export * from './execution.ts';
export * from './setup.ts';
