import { useEffect } from 'react';

// iOS Safari does not resize the layout viewport for the on-screen keyboard. The
// visual viewport does shrink, so expose the covered height as --keyboard-inset
// (used for bottom padding/scroll margins) and flag data-keyboard while it is open,
// which hides the bottom tab bar instead of letting it float above the keyboard.
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      root.style.setProperty('--keyboard-inset', `${inset}px`);
      // Pinch-zoom also shrinks the visual viewport; only treat it as a keyboard while editing.
      const editing = document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]') ?? false;
      if (inset > 80 && editing) root.dataset.keyboard = 'open';
      else delete root.dataset.keyboard;
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update); document.removeEventListener('focusout', update);
    };
  }, []);
}
