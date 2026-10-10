// Dialogs and sheets here are opened from buttons and shortcuts, not Radix triggers, so Radix has nowhere
// to return focus on close and it lands on <body>. Remember what had focus when it opened and go back there.
import { useCallback, useLayoutEffect, useRef } from 'react';

export function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
  }, [open]);
  return useCallback((e: Event) => {
    const el = opener.current;
    if (el?.isConnected) {
      e.preventDefault();
      el.focus();
    }
  }, []);
}
