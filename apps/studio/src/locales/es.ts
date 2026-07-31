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
};
