import { useEffect, useState } from 'react';
import { loadPerfPanelState, savePerfPanelState } from '@/client/perf-panel-state';

/**
 * Whether the Shift+P diagnostic overlay should be on screen.
 *
 * This lives outside PerformanceDisplay so the overlay can be code-split. The
 * keyboard shortcut used to be registered *by* the component, which meant the
 * component had to be loaded before it could be summoned — so it was loaded
 * always, on every visit, for everybody. Six hundred lines and its two data
 * modules now arrive only if someone actually presses the keys.
 *
 * Deliberately not part of the shortcut registry in @/shared/shortcuts: that one
 * is user-facing (it populates the "?" dialog), and this is a developer tool
 * that should stay undocumented and stay live regardless of dialog scope.
 *
 * Starts false rather than reading storage during render, so the server and the
 * first client render agree; the stored answer arrives one effect later.
 */
export function usePerfPanel(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (loadPerfPanelState().visible) setOpen(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.key !== 'P') return;
      setOpen(prev => {
        const next = !prev;
        // Persisted here, on the toggle, rather than from an effect watching
        // `open` — an effect would also fire for the initial false and write
        // the panel closed before the load above had a chance to open it.
        savePerfPanelState({ visible: next });
        return next;
      });
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return open;
}
