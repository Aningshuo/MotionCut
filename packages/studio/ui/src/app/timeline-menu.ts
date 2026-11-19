import { createElement as h, useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface TimelineMenuTarget {
  kind: 'clip' | 'track' | 'space';
  track?: number;
  at: number;
  ids: string[];
}

export interface TimelineMenuItem {
  id: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
}

export type TimelineMenuGroups = TimelineMenuItem[][];

export function TimelineMenu(props: {
  x: number; y: number; target: TimelineMenuTarget; groups: TimelineMenuGroups; close: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const previous = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (panel === null) return;
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const place = (): void => {
      panel.style.left = `${Math.max(6, Math.min(props.x, window.innerWidth - panel.offsetWidth - 6))}px`;
      panel.style.top = `${Math.max(6, Math.min(props.y, window.innerHeight - panel.offsetHeight - 6))}px`;
    };
    place();
    const initial = panel.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (initial ?? panel).focus({ preventScroll: true });
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      if (panel.contains(document.activeElement)) previous.current?.focus({ preventScroll: true });
    };
  }, [props.x, props.y, props.target]);

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) props.close();
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', props.close);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', props.close);
    };
  }, [props.close]);

  function navigate(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      props.close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (buttons.length === 0) return;
    const current = buttons.findIndex(button => button === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) :
      (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return createPortal(h('div', {
    ref, className: 'oc-timeline-menu', tabIndex: -1, role: 'menu',
    'aria-label': props.target.kind === 'clip' ? '片段操作' : '轨道操作',
    'data-testid': 'timeline-context-menu', 'data-target': props.target.kind,
    onKeyDown: navigate, onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  }, props.groups.filter(group => group.length > 0).map((group, index) =>
    h('div', { role: 'group', className: 'oc-timeline-menu-group', key: index },
      group.map(item => h('button', {
        type: 'button', role: 'menuitem', key: item.id, disabled: item.disabled,
        'data-action': item.id, 'data-danger': item.danger ? 'true' : undefined,
        onClick: () => { props.close(); item.run(); },
      }, h('span', null, item.label), item.shortcut ? h('kbd', null, item.shortcut) : null)),
    ))), document.body);
}
