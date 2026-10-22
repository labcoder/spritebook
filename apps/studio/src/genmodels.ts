interface GeneratorChoice {
  id: string;
  versions: { installed: boolean }[];
}

export function discoverableModels<T extends { id: string }>(
  models: T[],
  development: boolean,
): T[] {
  return models.filter((m) => development || m.id !== 'fixture-gen')
    .sort((a, b) => Number(a.id === 'fixture-gen') - Number(b.id === 'fixture-gen'));
}

export function generatorSelection(models: GeneratorChoice[] | null, requested: string): string {
  return models?.find((m) => m.id === requested)?.id ??
    models?.find((m) => m.id !== 'fixture-gen' && m.versions.some((v) => v.installed))?.id ??
    models?.[0]?.id ?? '';
}
