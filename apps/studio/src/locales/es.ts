/**
 * Spanish — the first real second locale (the maintainer's language). Held
 * to 100% coverage of extracted ids by i18n_extract_test.ts; the extractor
 * prints ready-to-paste stubs for anything new. Product terms that ARE the
 * product's vocabulary (bake, sidecar, rig, log) stay as loanwords on
 * purpose — they match the CLI the GUI mirrors.
 */
export const es: Record<string, string> = {
  // gallery
  'no bake yet': 'sin bake todavía',
  'Open': 'Abrir',
  'accepted': 'aceptado',
  'unaccepted': 'sin aceptar',
  'baked': 'bake',
  'Could not read that root.': 'No se pudo leer esa carpeta raíz.',
  'No characters under this root.': 'No hay personajes en esta raíz.',
  'a character is any directory holding a character.json':
    'un personaje es cualquier carpeta con un character.json',

  // menu bar + chips
  'File': 'Archivo',
  'Edit': 'Edición',
  'Reload gallery': 'Recargar la galería',
  'Run health exam': 'Ejecutar examen de salud',
  'Manage models…': 'Gestionar modelos…',
  'Undo': 'Deshacer',
  'Redo': 'Rehacer',
  'Command palette': 'Paleta de comandos',
  'Switch language': 'Cambiar idioma',
  'Switch theme': 'Cambiar tema',
  'lang': 'idioma',
  'theme': 'tema',
  'gpu: unexamined': 'gpu: sin examinar',

  // tabs
  'Characters': 'Personajes',
  'Gallery': 'Galería',
  'Close': 'Cerrar',
  'Delete key': 'tecla Supr',
  'Go to': 'Ir a',
  'Go to gallery': 'Ir a la galería',
  'This character is no longer under the loaded root.':
    'Este personaje ya no está en la raíz cargada.',

  // toolbar
  'Projects root': 'Raíz de proyectos',
  'Load': 'Cargar',
  'Examining…': 'Examinando…',

  // stage rail
  'Pipeline stages': 'Etapas del pipeline',
  'Gen': 'Gen',
  'Rig': 'Rig',
  'Anim': 'Anim',
  'Look': 'Look',
  'Bake': 'Bake',
  'Export': 'Exportar',
  'locked': 'bloqueada',
  'stages unlock when a canonical mesh is saved':
    'las etapas se desbloquean al guardar una malla canónica',

  // canvas well
  'preview': 'vista previa',
  'bake': 'bake',
  'contact strip': 'tira de contacto',
  'no bake recorded': 'sin bake registrado',
  'Zoom': 'Zoom',
  'no bake yet — the well shows core output only':
    'sin bake todavía — el pozo solo muestra salida del core',
  'nearest-neighbor · integer zoom · core output':
    'vecino más cercano · zoom entero · salida del core',

  // inspector
  'Inspector': 'Inspector',
  'nothing recorded': 'nada registrado',
  'read-only — every value here is the manifest': 'solo lectura — cada valor aquí es el manifiesto',
  'Resize inspector': 'Redimensionar el inspector',

  // log drawer + status bar
  'Session log': 'Registro de sesión',
  'lines': 'líneas',
  'Severity filter': 'Filtro de severidad',
  'all': 'todo',
  'warn': 'aviso',
  'error': 'error',
  'errors': 'errores',
  'Copied': 'Copiado',
  'Copy': 'Copiar',
  'Nothing yet — every line a core CLI writes lands here verbatim.':
    'Nada todavía — cada línea que escribe el CLI del core aterriza aquí literal.',
  'render': 'render',
  'ok': 'ok',
  'FAILED': 'FALLÓ',
  'sidecar ok': 'sidecar ok',
  'sidecar FAILED': 'sidecar FALLÓ',
  'contract': 'contrato',
  'adapters': 'adaptadores',
  'examining…': 'examinando…',
  'health: not yet examined': 'salud: aún sin examinar',
  'characters': 'personajes',
  'bridge': 'puente',
  'log': 'registro',
  'Toggle session log': 'Mostrar u ocultar el registro',

  // command palette
  'Type a command…': 'Escribe un comando…',
  'Commands': 'Comandos',
  'No matching command': 'Ningún comando coincide',

  // manage models
  'Manage models': 'Gestionar modelos',
  'Refresh': 'Actualizar',
  'installed': 'instalado',
  'not installed': 'no instalado',
  'platforms': 'plataformas',
  'Verify': 'Verificar',
  'Remove': 'Quitar',
  'Confirm remove': 'Confirmar quitar',
  'Install': 'Instalar',
  'Confirm download': 'Confirmar descarga de',
  'Working…': 'Trabajando…',
  'I accept the license': 'Acepto la licencia',
  'license acceptance required': 'requiere aceptar la licencia',
  'not available in': 'no disponible en',
  'Gates are enforced by core, shown here so nothing refuses by surprise.':
    'Las puertas las aplica el core; aquí se muestran para que nada rechace por sorpresa.',
  'could not read the catalog — the log drawer has the verbatim reason':
    'no se pudo leer el catálogo — el registro tiene el motivo literal',
  'catalog output was not JSON': 'la salida del catálogo no era JSON',
  'failed — the log drawer has the verbatim reason': 'falló — el registro tiene el motivo literal',
  // generate surface (P4-T2)
  'New character': 'Nuevo personaje',
  'Name': 'Nombre',
  'id': 'id',
  'a name is required': 'hace falta un nombre',
  'ids need at least 2 characters': 'los ids necesitan al menos 2 caracteres',
  'ids are lowercase letters, digits and dashes': 'los ids son minúsculas, dígitos y guiones',
  'Source image': 'Imagen de origen',
  'drop an image anywhere, or paste a path': 'suelta una imagen aquí, o pega una ruta',
  'Backend': 'Backend',
  'this backend is not installed': 'este backend no está instalado',
  'Options': 'Opciones',
  'defaults are the catalog’s — only changes travel':
    'los valores por defecto son del catálogo — solo viajan los cambios',
  'Generate model': 'Generar modelo',
  'Generating…': 'Generando…',
  'starting…': 'empezando…',
  'events': 'eventos',
  'browser preview: generate needs the desktop shell':
    'vista de navegador: generar necesita la app de escritorio',
  'canonical mesh saved': 'malla canónica guardada',
  'stages 02–06 are unlocked': 'las etapas 02–06 están desbloqueadas',
  'pick': 'pick',
  'picked': 'elegido',
  'discarded': 'descartado',
  'seed': 'seed',
  'More like this': 'Más como este',
  'Save as canonical mesh': 'Guardar como malla canónica',
  'reproject source detail': 'reproyectar el detalle del origen',
  'match source colours': 'igualar los colores del origen',
  'nothing generated': 'nada generado',
  'Replay previous session': 'Reproducir la sesión anterior',
  'no previous session': 'sin sesión anterior',
  'CLI twin': 'comando CLI equivalente',

  // rig stage (P4-T2)
  'Rig this character': 'Riggear este personaje',
  'Rig track': 'Vía de rig',
  'Track B — predicted skeleton (UniRig)': 'Vía B — esqueleto predicho (UniRig)',
  'Track A — canonical body fit': 'Vía A — ajuste del cuerpo canónico',
  'a fresh skeleton fitted to this mesh on the GPU — about two minutes':
    'un esqueleto nuevo ajustado a esta malla en la GPU — unos dos minutos',
  'the bundled body fitted to the mesh — deterministic, no GPU':
    'el cuerpo incluido ajustado a la malla — determinista, sin GPU',
  'Body': 'Cuerpo',
  'Run rig': 'Ejecutar rig',
  'Rigging…': 'Riggeando…',
  'Deform check': 'Chequeo de deformación',
  'no deform report on disk — re-run the rig to write one':
    'no hay informe de deformación en disco — vuelve a ejecutar el rig para escribirlo',
  'every joint passed the test poses': 'todas las articulaciones pasaron las poses de prueba',
  'of': 'de',
  'joints flagged under test poses': 'articulaciones marcadas bajo poses de prueba',
  'clean': 'limpias',
  'joint': 'articulación',
  'finding': 'hallazgo',
  'max stretch': 'estiramiento máx',
  'mean move': 'desplazamiento medio',
  'detached pieces': 'piezas sueltas',
  'no placement hint can repair this': 'ninguna pista de posición puede reparar esto',
  'Orientation': 'Orientación',
  'each fix re-runs the rig (~2 min)': 'cada arreglo vuelve a ejecutar el rig (~2 min)',
  'Face front': 'Mirar al frente',
  'Feet to ground': 'Pies al suelo',
  'Center': 'Centrar',
  'Rotate': 'Rotar',
  'face-front first: every direction is derived from the front, so a wrong front makes all eight wrong':
    'primero mirar al frente: las ocho direcciones se derivan del frente, así que un frente mal puesto estropea las ocho',
  'Repair': 'Reparar',
  'Auto-hint from this report and re-run': 'Derivar pistas de este informe y re-ejecutar',
  'Re-run rig': 'Re-ejecutar rig',
  'Joint edits file': 'Archivo de ediciones de articulaciones',
  'Apply edits': 'Aplicar ediciones',
  'Re-run with edits as hints': 'Re-ejecutar con las ediciones como pistas',
  'Accept this rig': 'Aceptar este rig',
  'Acceptance': 'Aceptación',
  'acceptance is yours, not a default: if you have looked and the sprites are fine, record it — the bake stops warning':
    'aceptar es cosa tuya, no un valor por defecto: si ya miraste y los sprites están bien, regístralo — el bake deja de avisar',
  'Accept rig': 'Aceptar rig',
  'Unaccept rig': 'Retirar aceptación',
  'rig accepted': 'rig aceptado',
  'joints': 'articulaciones',
  'track': 'vía',
  'Anim is next': 'Anim es lo siguiente',

  // anim stage (P4-T2)
  'Enabled clips': 'Clips activados',
  'nothing enabled — pick clips from the library below':
    'nada activado — elige clips de la biblioteca de abajo',
  'frames': 'fotogramas',
  'speed': 'velocidad',
  'hold last': 'mantener último',
  'hold last frame': 'mantener el último fotograma',
  'Record change': 'Registrar cambio',
  'Disable': 'Desactivar',
  'Re-enable': 'Reactivar',
  'disabled': 'desactivado',
  'enabled': 'activado',
  'clips': 'clips',
  'directions': 'direcciones',
  'frames per bake pass': 'fotogramas por pasada de bake',
  'Clip library': 'Biblioteca de clips',
  'Search': 'Buscar',
  'name or tag…': 'nombre o etiqueta…',
  'Category': 'Categoría',
  'loop': 'bucle',
  'Enable': 'Activar',
  'could not read the clip library — the log drawer has the verbatim reason':
    'no se pudo leer la biblioteca de clips — el registro tiene el motivo literal',
  'clip library output was not JSON': 'la salida de la biblioteca no era JSON',
};
