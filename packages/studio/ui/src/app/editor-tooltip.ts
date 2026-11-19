import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './editor-tooltip.css';

const HOVER_DELAY_MS = 2000;
const EDGE_GAP = 8;
const HINT_TARGET = '[data-editor-hint]';

function hintTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(HINT_TARGET) : null;
}

export function EditorTooltip(): ReactNode {
  const [hint, setHint] = useState<{ target: HTMLElement; text: string } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: number | undefined;
    const cancel = (): void => {
      window.clearTimeout(timer);
      timer = undefined;
      target = null;
    };
    const dismiss = (): void => {
      cancel();
      setHint(null);
    };
    const schedule = (next: HTMLElement | null): void => {
      if (next === target) return;
      dismiss();
      if (next === null) return;
      target = next;
      timer = window.setTimeout(() => {
        const text = next.dataset.editorHint;
        if (next.isConnected && next.getClientRects().length > 0 && text) setHint({ target: next, text });
      }, HOVER_DELAY_MS);
    };
    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') schedule(hintTarget(event.target));
    };
    const onLeave = (event: PointerEvent | FocusEvent): void => {
      if (target !== null && hintTarget(event.target) === target && hintTarget(event.relatedTarget) !== target) dismiss();
    };
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Element && event.target.matches(':focus-visible')) schedule(hintTarget(event.target));
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss();
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onLeave, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onLeave, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('click', dismiss, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      cancel();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onLeave, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onLeave, true);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (tooltip === null || hint === null) return;
    const rect = hint.target.getBoundingClientRect();
    const { offsetWidth, offsetHeight } = tooltip;
    const maxLeft = window.innerWidth - offsetWidth - EDGE_GAP;
    const left = rect.left + (rect.width - offsetWidth) / 2;
    const above = rect.top - offsetHeight - EDGE_GAP;
    const below = rect.bottom + EDGE_GAP;
    const fitsBelow = below + offsetHeight <= window.innerHeight - EDGE_GAP;
    const preferBelow = hint.target.closest('.topbar, .creation-library') !== null;
    tooltip.style.left = `${Math.max(EDGE_GAP, Math.min(left, maxLeft))}px`;
    tooltip.style.top = `${fitsBelow && (preferBelow || above < EDGE_GAP) ? below : Math.max(EDGE_GAP, above)}px`;
  }, [hint]);

  return hint === null ? null : createPortal(createElement('div', {
    ref: tooltipRef,
    className: 'editor-tooltip',
    role: 'tooltip',
    'data-testid': 'editor-tooltip',
  }, hint.text), document.body);
}
