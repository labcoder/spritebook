import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
} from 'react';
import { prefs } from './prefs';
import { t } from './i18n';

const INSP_MIN = 280;
const INSP_MAX = 560;
const INSP_DEFAULT = 360;

function useInspectorWidth(): [number, (w: number) => void] {
  const [w, setW] = useState(() => prefs.inspectorWidth(INSP_DEFAULT, INSP_MIN, INSP_MAX));
  const set = useCallback((next: number) => {
    const clamped = Math.min(INSP_MAX, Math.max(INSP_MIN, Math.round(next)));
    setW(clamped);
    prefs.setInspectorWidth(clamped);
  }, []);
  return [w, set];
}

function Grip(
  { width, setWidth }: { width: number; setWidth: (w: number) => void },
) {
  const dragging = useRef<{ startX: number; startW: number } | null>(null);

  return (
    <div
      className='grip'
      role='separator'
      aria-orientation='vertical'
      aria-label={t('Resize inspector')}
      aria-valuemin={INSP_MIN}
      aria-valuemax={INSP_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = { startX: e.clientX, startW: width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        setWidth(
          dragging.current.startW + (dragging.current.startX - e.clientX),
        );
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
      onLostPointerCapture={() => {
        dragging.current = null;
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onDoubleClick={() => setWidth(INSP_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setWidth(width + 16);
        else if (e.key === 'ArrowRight') setWidth(width - 16);
        else if (e.key === 'Home') setWidth(INSP_MAX);
        else if (e.key === 'End') setWidth(INSP_MIN);
        else return;
        e.preventDefault();
      }}
    />
  );
}

const PanelContext = createContext<
  {
    title: string;
    width: number;
    setWidth: (width: number) => void;
    collapsed: boolean;
    toggle: () => void;
    actions?: ReactNode;
  } | null
>(null);

/** One property panel per stage; hiding its contents keeps drafts and jobs alive. */
export function Workbench({ title, actions, children }: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [width, setWidth] = useInspectorWidth();
  const [collapsed, setCollapsed] = useState(false);
  return (
    <PanelContext.Provider
      value={{ title, actions, width, setWidth, collapsed, toggle: () => setCollapsed((v) => !v) }}
    >
      <div
        className={`workbench-frame ${collapsed ? 'inspector-collapsed' : ''}`}
        style={{ '--inspector-size': `${width}px` } as CSSProperties}
      >
        {children}
      </div>
    </PanelContext.Provider>
  );
}

export function Inspector(
  { children, className = '' }: { children: ReactNode; className?: string },
) {
  const panel = useContext(PanelContext);
  const id = useId();
  if (!panel) throw new Error('Inspector needs a Workbench');
  const { title, width, setWidth, collapsed, toggle, actions } = panel;
  return (
    <aside className={`control-panel ${className}`} aria-label={title}>
      {!collapsed && <Grip width={width} setWidth={setWidth} />}
      <header className='inspector-head'>
        <h1 hidden={collapsed} title={title}>{title}</h1>
        <button
          type='button'
          className='icon-button inspector-toggle'
          aria-label={collapsed ? t('Expand inspector') : t('Collapse inspector')}
          title={collapsed ? t('Expand inspector') : t('Collapse inspector')}
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={toggle}
        >
          <svg viewBox='0 0 20 20' aria-hidden='true'>
            <path d={collapsed ? 'm12 5-5 5 5 5' : 'm8 5 5 5-5 5'} />
          </svg>
        </button>
      </header>
      <div id={id} className='inspector-content' hidden={collapsed} inert={collapsed}>
        {actions && <div className='inspector-actions'>{actions}</div>}
        {children}
      </div>
    </aside>
  );
}
