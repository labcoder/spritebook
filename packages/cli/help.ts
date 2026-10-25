/** Help uses the parser's flag tables so accepted options cannot disappear from usage. */
const COMMANDS: Record<string, { description: string; usage: string; example: string }> = {
  import: {
    description: 'Start a character from a 3D mesh or the bundled offline example.',
    usage: 'import --workspace <dir> (--model <glb> | --example) [--name <name>]',
    example: 'import --workspace ./characters/hero --example',
  },
  prep: {
    description: 'Remove an image background and save a cut-out RGBA image.',
    usage: 'prep --image <file> --out <dir>',
    example: 'prep --image hero.png --out ./prepared',
  },
  gen: {
    description:
      'Generate candidate meshes from an image; opaque images are prepared automatically.',
    usage: 'gen --workspace <dir> --image <file> [--model <id>] [--candidates <1..8>]',
    example: 'gen --workspace ./characters/hero --image hero.png --candidates 2 --height 1.7',
  },
  pick: {
    description: 'Save a generated candidate as the canonical mesh for the character.',
    usage: 'pick --workspace <dir> --result <result-id>',
    example: 'pick --workspace ./characters/hero --result r1',
  },
  retexture: {
    description: 'Generate a new texture for an existing candidate without replacing its geometry.',
    usage: 'retexture --workspace <dir> --result <result-id> [--seed <integer>]',
    example: 'retexture --workspace ./characters/hero --result r1 --seed 42',
  },
  rig: {
    description: 'Build, inspect or accept a character rig. Review walk and jump before accepting.',
    usage:
      'rig --model <glb> --out <dir> [--workspace <dir>] [--upright] | rig --workspace <dir> --accept',
    example:
      'rig --model ./characters/hero/canonical/model.glb --out ./characters/hero/rig --workspace ./characters/hero --upright',
  },
  anim: {
    description: 'Browse animation clips, enable them for a character, and preview motion.',
    usage:
      'anim --list | anim --workspace <dir> --enable <clip:frames,...> | anim --workspace <dir> --preview <clip>',
    example: 'anim --workspace ./characters/hero --enable walk-loop:12',
  },
  look: {
    description: 'Set camera, lighting and sprite style, or render a single-frame preview.',
    usage: 'look --list | look --workspace <dir> [--style <id>] [--camera <id>] [--preview]',
    example: 'look --workspace ./characters/hero --style original --cell 512 --preview',
  },
  bake: {
    description: 'Render character animations into sprite atlases using the saved look.',
    usage: 'bake --workspace <dir> | bake --all --root <projects-dir> [--plan]',
    example: 'bake --workspace ./characters/hero --directions 8 --cell 512',
  },
  export: {
    description:
      'Export baked sprites for game engines and optionally copy the 3D mesh and textures.',
    usage: 'export --workspace <dir> --out <dir> (--targets <ids> | --mesh) [--mesh]',
    example: 'export --workspace ./characters/hero --out ./delivery --targets godot,strips --mesh',
  },
  workspace: {
    description:
      'Inspect a project, list a character roster, or read saved preview/atlas metadata.',
    usage: 'workspace --root <projects-dir> --roster | workspace --workspace <dir>',
    example: 'workspace --root ./characters --roster --json',
  },
  identity: {
    description: 'Update character decals, attachments or bone masks from JSON files.',
    usage:
      'identity --workspace <dir> [--decals <json>] [--attachments <json>] [--bone-mask <json>]',
    example: 'identity --workspace ./characters/hero --decals ./decals.json',
  },
  rename: {
    description: 'Change a character display name while keeping its ID and files.',
    usage: 'rename --workspace <dir> --name <name>',
    example: 'rename --workspace ./characters/hero --name "Captain Pip"',
  },
  clone: {
    description: 'Copy a character into a separate workspace with a new ID.',
    usage: 'clone --workspace <dir> --to <new-dir> --id <new-id> [--name <name>]',
    example: 'clone --workspace ./characters/hero --to ./characters/hero-alt --id hero-alt',
  },
  delete: {
    description:
      'Permanently delete generated project assets; preserve original inputs and unrelated files.',
    usage: 'delete --workspace <dir> --confirm <character-id>',
    example: 'delete --workspace ./characters/hero --confirm hero',
  },
  undo: {
    description: 'Undo the latest journaled manifest edit. Deleted projects cannot be restored.',
    usage: 'undo --manifest <character.json>',
    example: 'undo --manifest ./characters/hero/character.json',
  },
  redo: {
    description: 'Reapply a previously undone manifest edit.',
    usage: 'redo --manifest <character.json>',
    example: 'redo --manifest ./characters/hero/character.json',
  },
  models: {
    description: 'List, install, verify, repair or remove local model weights and runtimes.',
    usage: 'models <list|install|setup|verify|rm> [id[@version]] [options]',
    example: 'models list --installed',
  },
  extensions: {
    description: 'Manage models, optional Blender and bundled content in one place.',
    usage: 'extensions <list|install|setup|use|verify|rm> [id[@version]] [options]',
    example: 'extensions list',
  },
  doctor: {
    description: 'Check the core runtime and GPU; optionally check the Python sidecar.',
    usage: 'doctor [--sidecar] [--json]',
    example: 'doctor --sidecar --json',
  },
};

const OPTIONS: Record<string, string> = {
  workspace: 'Character project directory containing character.json.',
  model: 'Generation backend ID, or input mesh path for import/rig/bake (see Usage).',
  character: 'Character ID: lowercase letters, digits and dashes.',
  name: 'Human-readable character name. Quote names containing spaces.',
  height: 'Standing height in metres; normalizes the mesh scale.',
  example: 'Use the bundled CC0 humanoid; no model download required.',
  image: 'Source image path. Quote paths containing spaces.',
  out: 'Output directory; gen/pick/retexture also accept this as a workspace alias.',
  adjust: 'Backend settings as name=value[,name=value]; see the CLI guide for ranges.',
  candidates: 'Generate 1 to 8 candidates in one job; load the model once.',
  'model-version': 'Pin a model revision instead of choosing the highest installed version.',
  seed: 'Integer random seed, including 0; candidate seeds advance by 1000.',
  'more-like': 'Generate variations of this existing result ID.',
  result: 'Generated result ID, such as r1.',
  sidecar: 'Sidecar source directory (doctor: check the sidecar too).',
  'models-dir': 'Override the model weights directory.',
  catalog: 'Override the model catalog JSON path.',
  pins: 'Backend/runtime pins file for reproducible jobs.',
  reproject: 'Project source colors onto the selected mesh.',
  'no-reproject': 'Keep the generated texture without source reprojection.',
  'color-match': 'Match texture colors to the reference image.',
  'no-color-match': 'Keep the generated texture colors.',
  upright: 'Straighten a humanoid when the alignment estimate is confident.',
  'face-front': 'Infer the model front direction before rigging.',
  'feet-ground': 'Place the lowest point on the ground.',
  center: 'Center the mesh horizontally.',
  rotate: 'Turn around the upright axis in degrees.',
  'track-a': 'Fit the bundled template body on CPU instead of predicting with UniRig.',
  body: 'Template body asset path.',
  target: 'Template fitting target mesh path.',
  backend: 'Rig backend ID (default: unirig).',
  edits: 'Joint edits JSON file.',
  'rerun-with-hints': 'Rebuild using the joint edits as position hints.',
  'auto-hints': 'Derive hints from the last deform report and rebuild.',
  accept: 'Accept the reviewed rig and unlock animation/capture.',
  unaccept: 'Clear the accepted status of the rig.',
  'no-deform-check': 'Skip deform checks; visual motion review is still necessary.',
  'preview-joint': 'Render a bend preview for this joint ID.',
  audition: 'Build draft walk/jump review images for a generated candidate.',
  review: 'Build motion review images for the current rig.',
  'no-upright': 'Skip automatic straightening during a candidate audition.',
  list: 'List available animation clips or camera/style presets.',
  packs: 'Pack root to browse; for preview, the selected pack directory.',
  tag: 'Filter the clip library by tag.',
  category: 'Filter the clip library by category.',
  'import-pack': 'Animation pack directory to import.',
  into: 'Destination directory for an imported animation pack.',
  enable: 'Enable clip:frames[@speed][!hold][,...] for the character.',
  disable: 'Comma-separated clip IDs to disable.',
  preview: 'anim: clip ID to preview; look: render one frame.',
  clip: 'Animation clip ID for the Look preview.',
  frame: 'Zero-based animation frame for the Look preview.',
  direction: 'Zero-based direction index for the Look preview.',
  camera: 'Camera preset ID; use look --list to browse.',
  style: 'Output style ID, such as original; use look --list to browse.',
  elevation: 'Camera elevation above the ground in degrees.',
  yaw: 'Camera turn around the character in degrees.',
  projection: 'Camera projection: orthographic or perspective.',
  fov: 'Perspective field of view in degrees.',
  directions: 'Number of evenly spaced viewing directions.',
  ppm: 'Pixels per metre for orthographic framing.',
  cell: 'Sprite cell size in pixels, from 64 through 4096.',
  padding: 'Empty border around a sprite, in pixels.',
  colors: 'Palette color count for styles that quantize color.',
  outline: 'Outline width in pixels for styles that use outlines.',
  supersample: 'Antialiasing sample scale.',
  ambient: 'Ambient light intensity.',
  'light-yaw': 'Key light yaw in degrees.',
  'light-elevation': 'Key light elevation in degrees.',
  'light-frame': 'Light coordinate frame: camera or world.',
  all: 'Bake every eligible character under --root.',
  root: 'Projects root containing character workspaces.',
  'changed-since': 'Only consider characters changed since this ISO timestamp.',
  plan: 'Write a batch plan without rendering.',
  frames: 'Frames per clip when no per-clip count is specified.',
  clips: 'Clip selection: clip:frames[@speed][!hold][,...].',
  pack: 'Animation pack directory.',
  cache: 'Override the render cache directory.',
  'only-invalidated': 'Render stale outputs only.',
  mirror: 'Use mirrored directions where supported.',
  'no-mirror': 'Render every requested direction independently.',
  bake: 'export: bake directory; workspace: read the selected bake snapshot.',
  targets:
    'Comma-separated exporters: godot,aseprite,texturepacker,strips. Unity/Phaser use strips.',
  fps: 'Animation playback frame rate for exported assets.',
  mesh: 'Also export the canonical GLB and embedded textures; requires --workspace.',
  roster: 'List character workspaces under --root.',
  thumb: 'Read a saved character thumbnail.',
  atlas: 'Read a saved atlas page.',
  pass: 'Atlas render pass.',
  page: 'Zero-based atlas page index.',
  'look-preview': 'Saved Look preview key.',
  decals: 'Decal definitions JSON path.',
  attachments: 'Attachment definitions JSON path.',
  'bone-mask': 'Bone mask JSON path.',
  to: 'New workspace directory for the clone.',
  id: 'New character ID for the clone.',
  confirm: 'Exact character ID required for permanent deletion.',
  manifest: 'Path to character.json for journal undo/redo.',
  installed: 'Only list installed items.',
  'accept-license': 'Record explicit acceptance of the third-party license after reviewing it.',
  territory: 'Territory code for license eligibility checks.',
  from: 'Install from local files instead of downloading; checksums still apply.',
  'tools-dir': 'Override the optional-tools directory.',
  path: 'Existing Blender executable to detect and register; no download.',
  json: 'Queries return one JSON document; jobs stream NDJSON events.',
  'log-append': 'Append job events to this NDJSON log file.',
};

const SUBCOMMANDS: Record<string, string> = {
  list: 'List available items and their installation state.',
  install: 'Download and verify files, then provision the required runtime.',
  setup: 'Repair a model runtime while keeping verified weights.',
  verify: 'Verify installed files without reinstalling them.',
  rm: 'Remove managed files; existing external Blender installations are kept.',
  use: 'Detect an existing Blender installation, or register --path, after license acceptance.',
};

export function cliHelp(
  command: string | undefined,
  subcommand: string | undefined,
  flags: Record<string, readonly string[]>,
  booleans: Record<string, readonly string[]>,
) {
  if (command === undefined) {
    return {
      usage: 'spritebook <command> [options]',
      description: 'Create local 3D characters and capture them as game-ready sprite sheets.',
      commands: Object.entries(COMMANDS).map(([name, { description }]) => ({ name, description })),
      options: [
        { flag: '--help, -h', description: 'Show help without starting a job.' },
        { flag: '--version, -v', description: 'Print the installed SpriteBook version.' },
        { flag: '--json', description: OPTIONS.json },
      ],
      examples: [
        'spritebook import --workspace ./characters/hero --example',
        'spritebook gen --help',
      ],
    };
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(`Unknown command "${command}". Run spritebook --help.`);
  }
  const info = COMMANDS[command];
  if (
    subcommand && (
      !['models', 'extensions'].includes(command) || !Object.hasOwn(SUBCOMMANDS, subcommand) ||
      (command === 'models' && subcommand === 'use')
    )
  ) throw new Error(`Unknown subcommand "${subcommand}". Run spritebook ${command} --help.`);
  const usage = subcommand
    ? `${command} ${subcommand}${
      subcommand === 'list' ? '' : subcommand === 'use' ? ' blender' : ' <id[@version]>'
    } [options]`
    : info.usage;
  return {
    usage: `spritebook ${usage}`,
    description: subcommand ? SUBCOMMANDS[subcommand] : info.description,
    subcommands: ['models', 'extensions'].includes(command)
      ? Object.entries(SUBCOMMANDS).filter(([name]) => command === 'extensions' || name !== 'use')
        .map(([name, description]) => ({ name, description }))
      : undefined,
    options: [...new Set([...flags[command], 'json', 'log-append'])].map((name) => ({
      flag: `--${name}${name === 'json' || booleans[command]?.includes(name) ? '' : ' <value>'}`,
      description: OPTIONS[name] ?? name,
    })).concat({ flag: '--help, -h', description: 'Show this help without starting a job.' }),
    examples: [`spritebook ${info.example}`],
  };
}

export function formatHelp(help: ReturnType<typeof cliHelp>): string {
  const rows = (items: { name?: string; flag?: string; description: string }[]) =>
    items.map((item) => `  ${(item.name ?? item.flag ?? '').padEnd(27)} ${item.description}`).join(
      '\n',
    );
  return [
    `Usage: ${help.usage}`,
    help.description,
    help.commands ? `Commands:\n${rows(help.commands)}` : '',
    'subcommands' in help && help.subcommands ? `Subcommands:\n${rows(help.subcommands)}` : '',
    `Options:\n${rows(help.options)}`,
    `Examples:\n${help.examples.map((example) => `  ${example}`).join('\n')}`,
    'Use space-separated option values, and quote paths containing spaces.\nGuide: docs/user/cli.md',
  ].filter(Boolean).join('\n\n');
}
