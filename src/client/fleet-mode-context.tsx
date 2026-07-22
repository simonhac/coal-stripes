'use client';

import { createContext, useContext } from 'react';
import type { FleetMode } from '@/shared/types';

// The active fleet roster mode. `full` (the default) shows every coal unit that
// ever operated across recorded history — including retired plants; `current`
// shows only units operating in the present year. Components read it via
// useFleetMode() and feed it to yearQueryOptions / the cap-fac stats helpers so
// they resolve the correct per-mode query cache entry.
const FleetModeContext = createContext<FleetMode>('full');

export const FleetModeProvider = FleetModeContext.Provider;

export function useFleetMode(): FleetMode {
  return useContext(FleetModeContext);
}
