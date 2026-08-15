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

  // The earliest date we have data from. OpenElectricity's record now reaches
  // back to 1998-12-07 — earlier than the NEM's own commencement of trading on
  // 13 Dec 1998. (It used to stop at 1999-01-01; that was verified 2026-08-07
  // and extended upstream some time after.) Re-verified 2026-08-15 against the
  // live API: 76 of the 80 coal unit rows begin 1998-12-07, CALL_A_2 begins
  // 1998-12-21, and six more first appear in Jan/Feb 1999. Nothing exists
  // before 1998-12-07 at any resolution.
  //
  // The one thing that makes this cheap: a request for the whole of 1998
  // SUCCEEDS and is silently clipped to 1998-12-07 — it does not return
  // NoDataFound. So buildCapacityFactors(1998) needs no special case; it asks
  // for 1998-01-01 → 1998-12-31 as it does for any year and gets back a
  // 365-entry array whose first 340 days are null.
  //
  // 7 December is a PARTIAL day, and we show it anyway. The 5-minute series
  // starts at 1998-12-07T02:40:00+10:00, so the day is ~89% covered and its
  // daily energy is correspondingly short: fleet capacity factor reads 60.0% on
  // the 7th against 66.5% and 67.4% on the 8th and 9th (60.0 ÷ 0.889 = 67.5%,
  // which is the 9th almost exactly). That first stripe is therefore about 7
  // percentage points pale — one pixel column. Withholding a real day of the
  // record to avoid it would trade a fact for an aesthetic.
  //
  // Do NOT trust the facilities metadata here: `data_first_seen` reports the
  // start of a unit's later contiguous run, not its first reading (MM4 claims
  // 2000-02-28 when data exists from 1999-01-06). It happens to agree with the
  // 7 Dec boundary for most units; that is not a reason to start believing it.
  //
  // Two non-obvious consequences of a mid-December start:
  //
  //   • earliestDataEndDay is 1999-12-06, NOT a year boundary. Under the old
  //     1999-01-01 it landed on 1999-12-31 by coincidence (1999 is not a leap
  //     year, so +364 days reached year end). The leftmost resting window now
  //     spans two calendar years, and S / Home / [ land on 7 Dec 1998 –
  //     6 Dec 1999. Everything downstream is day-offset arithmetic, so nothing
  //     breaks — but do not reintroduce an assumption that offset 0 is a year.
  //
  //   • The 1998 tile's first 340 days are null and classify as 'interior-gap'
  //     (pale blue), not pre-commission: lifecycleBounds clamps a decades-earlier
  //     commencement date to index 0, so the whole year reads as "alive". They
  //     are never seen — at rest the window starts exactly at earliestDataDay,
  //     and during an overstep CompositeTile paints page background over every
  //     column before it. The tile deliberately does not know about this global
  //     boundary; the composite overlay is what enforces it.
  //
  // The WEM series only starts on 20 September 2006, so 1998–2005 render WEM as
  // blank page background, not pale blue: with no data at all in the year, every
  // day of those tiles classifies as pre-commission (see @/shared/data-gaps).
  // WEM's 1998 fetch returns NoDataFound, which cap-fac-data-service tolerates.
  EARLIEST_START_DATE: new CalendarDate(1998, 12, 7),

  // Buffer months to allow beyond data boundaries for UI flexibility.
  // CURRENTLY UNUSED: the earliestDisplay*/latestDisplay* values and the
  // *DisplayBounds helpers derived from this in @/shared/date-boundaries have no
  // callers outside their own tests. The overstep a reader can actually reach is
  // set by the gesture layer — WHEEL_STRETCH_DAYS (60) for the wheel, and the
  // @use-gesture rubberband (~54 days) for a drag. Keyboard and month clicks
  // clamp hard and never overstep at all.
  DISPLAY_SLOP_MONTHS: 9,
} as const;


// Page/body background colour (matches --beige-lighter and body background in
// opennem.css). Used to paint the "no data" region beyond the ends of the
// available data so the chart fades into the page rather than showing pale blue.
export const PAGE_BACKGROUND_HEX = '#faf9f6';
// Same colour as a little-endian ABGR uint32, for writing directly into a canvas
// ImageData buffer (bytes R=FA, G=F9, B=F6, A=FF read as one uint32).
export const PAGE_BACKGROUND_ABGR = 0xFFF6F9FA;


// Tile rendering configuration
export const TILE_CONFIG = {
  SHOW_DEBUG_OVERLAY: false,        // Show yellow border and year text on tiles
  DEBUG_BORDER_WIDTH: 3,            // Width of debug border in pixels
  DEBUG_BORDER_COLOR: 'yellow',     // Yellow color for debug border
  DEBUG_TEXT_SIZE: 40,              // Font size for year text
  DEBUG_TEXT_COLOR: '#9333ea',      // Purple color for year text
} as const;


// Bump to invalidate every cached capacity-factor payload — the replacement for
// the old CF_CACHE_VERSION + `&v=BUILD_ID` pair.
//
// It rides on the Cache-Tag header (`cf-dto-<version>`), so a change is applied
// by purging that one tag rather than by forking every URL. Bump it whenever the
// DTO's *shape* changes in a way the client can't tolerate — e.g. when per-unit
// `status` was added and the `current` fleet view began depending on it.
//
// Deploys alone do NOT need a bump, but not because entries survive them: they
// no longer do. Workers Cache keys include the Worker version
// (`cross_version_cache: false` in wrangler.jsonc), so a deploy starts cold by
// itself. What this version still buys is the two places a deploy cannot reach —
// the R2 key namespace (`v1/years/…`) and the TanStack Query key in a tab that
// has been open across one.
// v1 → v2: year payloads gained folded-member rows (Playford B's PLAYFB1-4),
// `selfHistory` on absorbing rows and `suppressedNullDays`, so /stats can report
// what OpenElectricity holds rather than what survives our folding. A bump is
// required rather than merely tidy: pre-deploy JS has no `foldedInto` filter, so
// serving it a v2 payload would draw Playford B as five rows.
export const CF_DTO_VERSION = 'v2';

// Cache freshness policy, shared by the server route (Cache-Control headers)
// and the client (TanStack Query staleTime).
//
// NEM data is subject to revision — in January we can easily see revisions to
// data from the December just past — so no tier treats past years as
// immutable. These windows set how long Workers Cache serves an entry before it
// must be rebuilt.
//
// These windows do double duty: they set `s-maxage` on the response AND are read
// by the store refresher as a write schedule (src/server/store-refresher.ts).
// Same question either way — how long before this year's numbers might have
// moved — so one definition keeps the cache and the store agreeing on "fresh".
//
// Do NOT assume stale-while-revalidate covers a lapse: it is set on the response
// but Workers Cache does not honour it, so a lapsed entry blocks the next
// visitor (measured on both Free and Paid, .context/spike/RESULTS.md). That is
// survivable only because R2 sits underneath — the blocked request reads a
// stored object rather than OpenElectricity.
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
