/**
 * Force one data file in the R2 store to be rebuilt from OpenElectricity.
 *
 * The missing counterpart to /api/admin/purge. Purging clears Workers Cache and
 * deliberately leaves R2 alone, because R2 is the floor the whole design rests
 * on — so after a purge every year still reports the same `x-cf-built-at`, and
 * there was no way short of `wrangler r2 object delete` or a CF_DTO_VERSION bump
 * to make it move. This is that way.
 *
 * **One file per request.** A year is a 3-9 s upstream fetch plus fill logic:
 * short enough to sit comfortably inside an invocation, and inside Cloudflare's
 * 100 s request ceiling. Twenty-eight of them in one request would not be. The
 * fan-out therefore happens in the *browser* (see /diagnostics), with the same
 * bounded concurrency the cron uses — which it must, because each request is a
 * separate invocation and `queued-oeclient`'s queue is per-fan-out, not per
 * isolate, so nothing on this side can see the others.
 *
 * **It does not purge.** That is load-bearing, not an omission: this zone is on
 * the Free plan, capped at five purge requests a minute, and a purge per year
 * would blow that on the first sweep. Instead each response names the cache tag
 * its file lives behind, and the client collects the tags of whatever actually
 * *changed* and sends them to /api/admin/purge in one call at the end of a run —
 * the same "purge only what moved" rule `refreshAll` follows, for the same
 * reason: dropping an entry whose numbers are identical costs the next reader a
 * miss and shows them nothing new. Naming the tag here rather than building it
 * in the browser keeps `yearTag` the single source of truth.
 *
 * There is no `force` flag because there is nothing to force: `buildYear` always
 * fetches and always writes. The refresh *schedule* only ever governs the cron.
 */
import { createFileRoute } from '@tanstack/react-router';
import { isAuthorisedPurgeRequest } from '@/server/auth';
import { COAL_STATS_TAG, NO_STORE, yearTag } from '@/server/cache-headers';
import { computeCoalStats } from '@/server/coal-stats-service';
import { currentDataYear, earliestDataYear } from '@/server/data-years';
import { buildYear, putStats } from '@/server/year-store';

interface RebuildBody {
  year?: unknown;
  stats?: unknown;
}

function bad(error: string): Response {
  return Response.json({ error }, { status: 400, headers: NO_STORE });
}

export const Route = createFileRoute('/api/admin/rebuild')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorisedPurgeRequest(request)) {
          return Response.json(
            { error: 'Unauthorised' },
            { status: 401, headers: NO_STORE },
          );
        }

        let body: RebuildBody;
        try {
          body = ((await request.json()) ?? {}) as RebuildBody;
        } catch {
          return bad('Body must be JSON: {"year":2004} or {"stats":true}');
        }

        const wantsStats = body.stats === true;
        const wantsYear = body.year !== undefined;
        if (wantsStats === wantsYear) {
          return bad('Specify exactly one of "year" or "stats".');
        }

        const started = performance.now();

        try {
          if (wantsStats) {
            // Folds the *stored* years, not upstream: computeCoalStats reads
            // through `readYear`, which hits R2 first and only falls through to
            // OpenElectricity for a year that isn't there. Run straight after a
            // rebuild sweep every year is present, so this is 28 R2 reads plus
            // CPU — the ~40 s in the docs is the cold-bucket case, where the
            // fold is paying for the builds it finds missing.
            //
            // Which is also why it must run *after* the years and not beside
            // them: fold first and you fold the previous generation's numbers.
            // Held rather than inlined: `created_at` is the stamp that lands in
            // customMetadata as `builtAt`, and the caller needs it to update its
            // own row without re-reading the store.
            const dto = await computeCoalStats();
            const write = await putStats(dto);
            return Response.json(
              {
                target: 'stats',
                changed: write.changed,
                cacheTag: COAL_STATS_TAG,
                builtAt: dto.created_at,
                dataChangedAt: write.dataChangedAt,
                ms: Math.round(performance.now() - started),
              },
              { headers: NO_STORE },
            );
          }

          const year = Number(body.year);
          if (!Number.isInteger(year)) return bad('"year" must be an integer.');
          // A future year is never stored (year-store's `isStorable`), so a
          // rebuild would fetch upstream, write nothing and report success.
          // Rejecting is the honest answer.
          if (year < earliestDataYear() || year > currentDataYear()) {
            return bad(
              `"year" must be between ${earliestDataYear()} and ${currentDataYear()}.`,
            );
          }

          const { dto, changed, dataChangedAt } = await buildYear(year);
          return Response.json(
            {
              target: 'year',
              year,
              changed,
              cacheTag: yearTag(year),
              builtAt: dto.created_at,
              dataChangedAt,
              ms: Math.round(performance.now() - started),
            },
            { headers: NO_STORE },
          );
        } catch (error) {
          console.error(JSON.stringify({
            log: 'rebuild:failed',
            target: wantsStats ? 'stats' : String(body.year),
            error: error instanceof Error ? error.message : String(error),
          }));
          return Response.json(
            {
              error: error instanceof Error ? error.message : String(error),
              ms: Math.round(performance.now() - started),
            },
            { status: 502, headers: NO_STORE },
          );
        }
      },
    },
  },
});
