import { useEffect, type RefObject } from 'react';

/** Pressing "/" focuses the field, unless the person is typing somewhere, using a modifier, or in a dialog. */
export function useSlashToFocus(field: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      if (document.querySelector('dialog[open]')) return;
      const element = field.current;
      if (!element) return;
      event.preventDefault();
      element.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [field]);
}
