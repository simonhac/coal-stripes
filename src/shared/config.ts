/**
 * Central configuration for the coal stripes visualisation
 */

import { CalendarDate } from '@internationalized/date';

// Date navigation physics and interaction configuration
export const DATE_NAV_PHYSICS = {
  // Rubber band effect when dragging beyond data boundaries
  RUBBER_BAND: {
    SCALE_FACTOR: 0.2,              // Controls stretch amount (20% of max at infinity - more resistance)
  },
  
  // Spring physics for snap-back animations
  SPRING: {
    STIFFNESS: 200,                 // Spring constant - higher for snappier response
    DAMPING: 30,                    // Damping coefficient - adjusted for the stiffness
    MASS: 1,                        // Mass of the spring system
    MIN_DISTANCE: 0.5,              // Stop when within 0.5 days of target
    MIN_VELOCITY: 10,               // Stop when velocity is below 10 days/s
  },
  
  // Momentum scrolling after drag release
  MOMENTUM: {
    FRICTION: 0.92,                 // Deceleration factor (8% velocity loss per frame)
    MIN_VELOCITY: 0.5,              // Minimum velocity to continue momentum
    VELOCITY_SCALE: 3,              // Scale up velocity for momentum effect
  },
  
  // Touch-specific settings
  TOUCH: {
    MOVEMENT_SCALE: 1.0,            // No scaling - full touch responsiveness
    MOMENTUM_SCALE: 1.5,            // Touch-specific momentum multiplier (reduced by 50%)
  },
  
  // Drag interaction thresholds
  DRAG: {
    MIN_DISTANCE: 5,                // Minimum pixels to start a drag
    MIN_HORIZONTAL_RATIO: 1.5,      // Horizontal must be 1.5x vertical for drag
    VELOCITY_SAMPLE_WINDOW: 100,    // Keep velocity samples from last 100ms
    DEBOUNCE_DELAY: 150,            // Milliseconds to debounce drag updates
  },
} as const;


// Performance monitoring
export const PERF_CONFIG = {
  SLOW_OPERATION_THRESHOLD: 16.67,  // Operations slower than 60fps (16.67ms)
  FPS_BUFFER_SIZE: 60,              // Number of frames to keep for FPS calculation
} as const;


// UI Configuration
export const UI_CONFIG = {
  MOBILE_BREAKPOINT: 768,           // Pixels - below this is mobile
  SHORT_LABELS_BREAKPOINT: 600,     // Pixels - below this use short labels
  MIN_ROW_HEIGHT: 12,               // Minimum height for desktop rows
  MIN_ROW_HEIGHT_MOBILE: 16,        // Minimum height for mobile rows
  MAX_ROW_HEIGHT: 40,               // Maximum row height
  CAPACITY_TO_HEIGHT_RATIO: 30,     // Divide capacity by this to get height
} as const;


// Date boundaries
export const DATE_BOUNDARIES = {
  // number of days displayed in the tile
  TILE_WIDTH: 365,

  // The earliest date we have data from
  EARLIEST_START_DATE: new CalendarDate(2006, 1, 1),

  // Buffer months to allow beyond data boundaries for UI flexibility
  DISPLAY_SLOP_MONTHS: 9,
} as const;


// Tile rendering configuration
export const TILE_CONFIG = {
  SHOW_DEBUG_OVERLAY: false,        // Show yellow border and year text on tiles
  DEBUG_BORDER_WIDTH: 3,            // Width of debug border in pixels
  DEBUG_BORDER_COLOR: 'yellow',     // Yellow color for debug border
  DEBUG_TEXT_SIZE: 40,              // Font size for year text
  DEBUG_TEXT_COLOR: '#9333ea',      // Purple color for year text
} as const;


// Cache freshness policy, shared by the server route (unstable_cache
// revalidate + Cache-Control headers) and the client (TanStack Query
// staleTime).
//
// NEM data is subject to revision — in January we can easily see revisions to
// data from the December just past — so no tier treats past years as
// immutable. These windows set how often a warmed entry revalidates; the cron
// warmer (warm-all, every 10 minutes over every year back to 2006) keeps every
// tier permanently warm, and stale-while-revalidate means a warmed entry is
// served stale instantly while it refreshes in the background, so users never
// feel a cold fetch regardless of these windows.
export type YearCacheTier = 'current' | 'recent' | 'archive';

export interface YearCachePolicy {
  tier: YearCacheTier;
  revalidateSeconds: number;
  swrSeconds: number;
}

export const YEAR_CACHE_TIERS: Record<YearCacheTier, Omit<YearCachePolicy, 'tier'>> = {
  current: { revalidateSeconds: 60 * 60, swrSeconds: 60 * 60 * 24 },            // gains a new day daily
  recent: { revalidateSeconds: 60 * 60 * 24, swrSeconds: 60 * 60 * 24 * 7 },    // catches revisions within a day
  archive: { revalidateSeconds: 60 * 60 * 24 * 7, swrSeconds: 60 * 60 * 24 * 30 }, // deep revisions are rare
} as const;

export function yearCachePolicy(year: number, currentYear: number): YearCachePolicy {
  const tier: YearCacheTier =
    year >= currentYear ? 'current' : year >= currentYear - 5 ? 'recent' : 'archive';
  return { tier, ...YEAR_CACHE_TIERS[tier] };
}
