/**
 * Import failures are ACTIONABLE: they name the file, mesh, or joint and say
 * what to do — never a stack trace (p1.md acceptance).
 */
export class ImportError extends Error {
  override name = 'ImportError';

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
  }
}

/** Wrap unknown thrown values into a clean, single-sentence ImportError. */
export function toImportError(err: unknown, context: string): ImportError {
  if (err instanceof ImportError) return err;
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  return new ImportError(`${context}: ${detail}`, { cause: err });
}
