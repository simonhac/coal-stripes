/**
 * Where the Shift+P diagnostic overlay keeps its window state.
 *
 * Split out of PerformanceDisplay so the *decision* to show the overlay can be
 * made without loading the overlay. The component is 600-odd lines that almost
 * no visitor ever opens, and it used to be part of the eagerly-preloaded route
 * chunk purely because the only thing that knew whether to show it — the Shift+P
 * handler and this localStorage read — lived inside it. Now the page reads this
 * (a few bytes) and dynamically imports the component only when the answer is
 * yes.
 *
 * Reads and writes are individually best-effort: the panel is a developer
 * convenience, and a privacy mode that forbids localStorage should cost the
 * visitor nothing worse than a panel that forgets where it was.
 */

export type PerfPanelDisplayMode = 'performance' | 'caches' | 'features' | 'tile';
export type PerfPanelDisclosureState = 'collapsed' | 'detailed';

export interface PerfPanelState {
  visible: boolean;
  position: { x: number; y: number };
  disclosureState: PerfPanelDisclosureState;
  displayMode: PerfPanelDisplayMode;
}

const STORAGE_KEY = 'performance-monitor-state';

function defaultState(): PerfPanelState {
  return {
    visible: false,
    position: { x: typeof window !== 'undefined' ? window.innerWidth / 2 - 50 : 100, y: 10 },
    disclosureState: 'collapsed',
    displayMode: 'caches',
  };
}

/**
 * The stored state, validated against the current viewport.
 *
 * The position check is not paranoia about corrupt JSON: a window that was
 * dragged to the corner of a wide monitor and reopened on a laptop would
 * otherwise restore off-screen, with no way to drag it back.
 */
export function loadPerfPanelState(): PerfPanelState {
  const fallback = defaultState();

  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback;
  }

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return fallback;

    const state = JSON.parse(saved) as Partial<PerfPanelState>;
    const onScreen =
      state.position &&
      state.position.x >= 0 &&
      state.position.x <= window.innerWidth - 100 &&
      state.position.y >= 0 &&
      state.position.y <= window.innerHeight - 100;

    return {
      visible: state.visible === true,
      position: onScreen ? state.position! : fallback.position,
      disclosureState: state.disclosureState || fallback.disclosureState,
      displayMode: state.displayMode || fallback.displayMode,
    };
  } catch (e) {
    console.error('Failed to parse saved performance monitor state:', e);
    return fallback;
  }
}

/**
 * Merge a patch into the stored state.
 *
 * A patch rather than a whole-object write because two owners now share this
 * key: the page owns `visible` (it has to, to decide whether to load the
 * overlay at all), and the overlay owns the rest. A full write from either would
 * discard the other's field.
 */
export function savePerfPanelState(patch: Partial<PerfPanelState>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPerfPanelState(), ...patch }));
  } catch {
    // Storage unavailable or full. The panel still works for this session.
  }
}
