import type { ReactElement } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { t } from './i18n';

/** Render the existing tab/card as the trigger, preserving its role and layout. */
export function ProjectMenu({ children, onDelete }: {
  children: ReactElement;
  onDelete?: () => void;
}) {
  if (!onDelete) return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup className='menupop'>
            <ContextMenu.Item className='menuitem destructive' onClick={onDelete}>
              {t('Delete project…')}
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
