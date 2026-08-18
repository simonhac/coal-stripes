/**
 * Cache management: one table of stored files, one button per row.
 *
 * This replaces four sections and ~750 lines. The old page was organised around
 * *how the caching works* — a purge button, a rebuild button, a 28-request cache
 * probe and a client render log, each with a paragraph explaining itself. What
 * an operator actually wants is to see the stored data files and force one to
 * recompute, so that is all this is.
 *
 * Two things went, and both were load-bearing mistakes rather than features:
 *
 * - **The probe.** Nothing was visible until you pressed it, and it downloaded
 *   28 × ~180 KB of real payloads to read three response headers — while warming
 *   the very cache it was measuring. /api/admin/store answers the same question
 *   from HEADs, so the table just loads. The one thing the probe told us that
 *   the store can't — did the edge actually clear? — survives as a single
 *   verification request after a flush.
 * - **The standalone purge button.** It implied you might want to clear the edge
 *   *without* recomputing, which is never what you want; the reverse — writing
 *   new objects and leaving the edge serving the old ones — is a bug. Flushing
 *   now always does both.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { capacityFactorsPath } from '@/shared/capacity-factors-url';
import { formatCompactAgeFromAEST } from '@/shared/date-utils';
import { mapPool } from '@/shared/map-pool';
import type { StoreEntry } from '@/server/year-store';
import { DOCUMENT_TAG } from '@/server/cache-headers';

/**
 * How many files to flush at once, and how far apart to start them.
 *
 * The same numbers the server uses: REFRESH_CONCURRENCY in
 * @/server/store-refresher and one start per 100 ms in @/server/queued-oeclient.
 * OpenElectricity never rate-limits us but serves about one heavy request a
 * second, so past ~5 in flight the extra parallelism buys no throughput.
 *
 * The bounding has to happen here. Each flush is its own HTTP request and so its
 * own Worker invocation, and the upstream queue is scoped per fan-out, not per
 * isolate — nothing on the server can see the other 27.
 */
const FLUSH_CONCURRENCY = 5;
const FLUSH_STAGGER_MS = 100;

/** Every row's transient state. Absent means at rest. */
type RowStatus =
  | { state: 'queued' }
  | { state: 'running' }
  | { state: 'done'; changed: boolean }
  | { state: 'failed'; error: string };

interface FlushResult {
  target: 'year' | 'stats' | 'metadata';
  year?: number;
  changed: boolean;
  cacheTag: string;
  builtAt: string;
  dataChangedAt: string;
}

/** Shared so the flush can patch the rows the table is rendering from. */
const STORE_QUERY_KEY = ['store-status'];

/**
 * A rejected passcode, which is the one failure that must stop everything.
 *
 * Every other failure is per-file — one year timing out upstream must not
 * abandon the other 27 — but a 401 will be a 401 for all of them, so retrying
 * it 28 more times only buys 28 more identical error messages.
 */
class UnauthorisedError extends Error {
  constructor() {
    super('Wrong passcode.');
    this.name = 'UnauthorisedError';
  }
}

/**
 * `fetch` rejects with a bare TypeError when it never reached the server at all
 * — the dev server is down, the network dropped. "Failed to fetch" is what the
 * browser calls that, and it reads like an application error rather than an
 * absent server, so say what it actually means.
 */
function describeFetchError(e: unknown): string {
  if (e instanceof TypeError) return 'Could not reach the server.';
  return e instanceof Error ? e.message : String(e);
}

const rowKey = (entry: StoreEntry): string =>
  entry.kind === 'year' ? String(entry.year) : entry.kind;

const rowLabel = (entry: StoreEntry): string =>
  entry.kind === 'stats' ? 'Stats' : entry.kind === 'metadata' ? 'Units' : String(entry.year);

export const Route = createFileRoute('/diagnostics')({ component: CacheManagement });

function CacheManagement() {
  const queryClient = useQueryClient();

  // React state only, never localStorage — it lives no longer than the tab.
  const [secret, setSecret] = useState('');
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({});
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  const store = useQuery({
    queryKey: STORE_QUERY_KEY,
    queryFn: async (): Promise<StoreEntry[]> => {
      const res = await fetch('/api/admin/store');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { entries: StoreEntry[] }).entries;
    },
  });

  const entries = store.data ?? [];
  // `refetch` is stable across renders; the query object is not, and depending
  // on it would rebuild `flush` on every tick of the table.
  const refetchStore = store.refetch;

  const flushOne = useCallback(
    async (body: unknown): Promise<FlushResult> => {
      const res = await fetch('/api/admin/rebuild', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) throw new UnauthorisedError();
      const json = (await res.json()) as { error?: string } | null;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.error ?? res.statusText}`);
      return json as unknown as FlushResult;
    },
    [secret],
  );

  /**
   * Recompute the given files, clear the edge, and say whether it worked.
   *
   * Order is the refresher's, and for its reasons. Years first; then the stats
   * fold, which reads the years back out of R2 and would otherwise fold the
   * generation it was about to replace; then the purge, which if it ran first
   * would refill the edge from the copy we were about to overwrite.
   */
  const flush = useCallback(
    async (targets: StoreEntry[]) => {
      if (!secret) {
        setError('Enter CACHE_SECRET first.');
        return;
      }
      cancelled.current = false;
      setBusy(true);
      setError(null);
      setNote(null);
      setStatuses({});

      // Settle the passcode in one request before spending 29 on it. Checking
      // costs nothing and has no side effects; discovering the same 401 once per
      // file costs 29 round trips and paints an identical failure across every
      // row, which reads as a broken store rather than a typo.
      try {
        const check = await fetch('/api/admin/auth', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (check.status === 401) throw new UnauthorisedError();
        if (!check.ok) throw new Error(`HTTP ${check.status}`);
      } catch (e) {
        setError(describeFetchError(e));
        setBusy(false);
        return;
      }

      setStatuses(
        Object.fromEntries(targets.map((t) => [rowKey(t), { state: 'queued' } as RowStatus])),
      );

      const years = targets.filter((t) => t.kind === 'year');
      const wantsStats = targets.some((t) => t.kind === 'stats');
      const wantsMetadata = targets.some((t) => t.kind === 'metadata');

      // One start per FLUSH_STAGGER_MS across the whole pool, so five requests
      // don't leave the browser in the same millisecond.
      let nextStart = 0;
      const gate = async () => {
        const at = Math.max(performance.now(), nextStart);
        nextStart = at + FLUSH_STAGGER_MS;
        const wait = at - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      };

      const setStatus = (key: string, status: RowStatus) =>
        setStatuses((prev) => ({ ...prev, [key]: status }));

      /**
       * Move the row's own stamps the moment its rebuild lands.
       *
       * Without this the whole table sits at its old ages until the sweep
       * finishes and the store is re-read, so a row could say `unchanged` next
       * to a Built of "21m ago" — the status claiming the file was just
       * rewritten and the timestamp flatly contradicting it.
       *
       * No extra request: the rebuild response already carries both stamps,
       * because it is the thing that wrote them. The refetch at the end still
       * happens and still wins; this only closes the gap until then.
       */
      const patchRow = (key: string, result: FlushResult) =>
        queryClient.setQueryData<StoreEntry[]>(STORE_QUERY_KEY, (prev) =>
          prev?.map((entry) =>
            rowKey(entry) === key
              ? {
                  ...entry,
                  builtAt: result.builtAt,
                  dataChangedAt: result.dataChangedAt,
                  // It was just built, so whatever it was before, it isn't now.
                  stale: false,
                }
              : entry,
          ),
        );

      let changed = 0;
      let failed = 0;
      let rejected = false;

      const drop = (key: string) =>
        setStatuses((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });

      // Caught per file, so mapPool always resolves: one year failing upstream
      // must not abandon the rest. The exception is a 401 — the secret can be
      // rotated mid-run, and once it has been, every remaining file would fail
      // the same way — so that stops the sweep like a cancel.
      await mapPool(years, FLUSH_CONCURRENCY, async (entry) => {
        const key = rowKey(entry);
        if (cancelled.current || rejected) {
          drop(key);
          return;
        }
        await gate();
        setStatus(key, { state: 'running' });
        try {
          const result = await flushOne({ year: entry.year });
          if (result.changed) changed += 1;
          patchRow(key, result);
          setStatus(key, { state: 'done', changed: result.changed });
        } catch (e) {
          if (e instanceof UnauthorisedError) {
            rejected = true;
            drop(key);
            return;
          }
          failed += 1;
          setStatus(key, { state: 'failed', error: describeFetchError(e) });
        }
      });

      if (rejected) {
        setError('Wrong passcode — the sweep stopped.');
        setBusy(false);
        void refetchStore();
        return;
      }

      let statsFolded = false;
      try {
        // Metadata BEFORE stats and after the years, which is the refresher's
        // order and for its reasons: its per-region first-data days are scanned
        // out of the stored years, and the fold then joins every year against
        // it. Unconditional, unlike the fold — it is one memoised facilities
        // call plus a handful of R2 reads, and it is what the whole store hangs
        // off, so "rebuild it whenever asked" is the useful behaviour.
        if (wantsMetadata && !cancelled.current) {
          setStatus('metadata', { state: 'running' });
          const metadata = await flushOne({ metadata: true });
          if (metadata.changed) changed += 1;
          patchRow('metadata', metadata);
          setStatus('metadata', { state: 'done', changed: metadata.changed });
        } else if (wantsMetadata) {
          drop('metadata');
        }

        // Refold when a year moved, or when the stats row was flushed on its
        // own. Nothing but the years feeds the fold, so an unchanged set folds
        // to an identical answer.
        if (wantsStats && (changed > 0 || years.length === 0) && !cancelled.current) {
          setStatus('stats', { state: 'running' });
          const stats = await flushOne({ stats: true });
          if (stats.changed) changed += 1;
          statsFolded = true;
          patchRow('stats', stats);
          setStatus('stats', { state: 'done', changed: stats.changed });
        } else if (wantsStats) {
          drop('stats');
        }

        // Always purge, even when nothing changed. The cron purges only what
        // moved — right for something that runs 144 times a day and shouldn't
        // cost readers a miss for no new data. Wrong for a button a human just
        // pressed, where the question is "is the edge clean now?" and the answer
        // has to be yes. Costs the same either way: one batched call, and the
        // Free plan caps purge *requests* per minute, not tags.
        // `html` rides along whenever the metadata was rebuilt: the blob is
        // inlined into every SSR document, so the documents ARE the cache entry
        // that would otherwise keep serving the old copy for an hour.
        const tags = [
          ...(years.length > 1
            ? ['capacity-factors', 'coal-stats']
            : targets
                .filter((t) => t.kind !== 'metadata')
                .map((t) => (t.kind === 'stats' ? 'coal-stats' : `cf-year-${t.year}`))),
          ...(wantsMetadata ? [DOCUMENT_TAG] : []),
        ];

        const purged = await fetch('/api/admin/purge', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        });
        if (purged.status === 401) throw new UnauthorisedError();
        if (!purged.ok) throw new Error(`Purge failed: HTTP ${purged.status}`);

        // Count what actually ran. Stats is skipped when no year moved — there
        // is nothing new to fold — so counting the row we didn't touch would
        // report 29 of 28.
        setNote(
          [
            `${years.length - failed + (statsFolded ? 1 : 0)} flushed, ${changed} changed` +
              (failed > 0 ? `, ${failed} failed` : '') +
              (wantsStats && !statsFolded ? ', stats already current' : '') +
              '.',
            await verifyEdge(years[0]?.year),
          ]
            .filter(Boolean)
            .join(' '),
        );

        await queryClient.invalidateQueries();
      } catch (e) {
        setError(describeFetchError(e));
      } finally {
        setBusy(false);
        void refetchStore();
      }
    },
    [flushOne, queryClient, refetchStore, secret],
  );

  return (
    <main style={page}>
      <header style={{ marginBottom: '20px' }}>
        {/* On its own line, not trailing the sentence: inline it read as a
            fragment of the description rather than as a way back to the site. */}
        <Link to="/" style={{ fontSize: '13px' }}>
          ← Back to the visualisation
        </Link>
        <h1 style={{ margin: '10px 0 4px', fontSize: '22px' }}>Cache management</h1>
        <p style={{ margin: 0, color: 'var(--oe-mid-grey)', fontSize: '13px' }}>
          Every file in the R2 store. <strong>Flush</strong> re-fetches it from OpenElectricity,
          rewrites it, and clears the edge cache.
        </p>
      </header>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '14px' }}>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="CACHE_SECRET"
          autoComplete="off"
          style={input}
        />
        <button onClick={() => void flush(entries)} disabled={busy || !secret} style={button}>
          {busy ? 'Flushing…' : 'Flush all'}
        </button>
        {busy && (
          <button onClick={() => (cancelled.current = true)} style={button}>
            Cancel
          </button>
        )}
      </div>

      {/* One error line. A failed flush usually knocks out the table's own
          refetch as well, so rendering both slots showed the same sentence
          twice and made one fault look like two. The flush error wins: it is
          the thing the operator just did. */}
      {(error ?? store.error) && (
        <p style={{ color: 'var(--oe-error-red)', fontSize: '13px', margin: '0 0 10px' }}>
          {error ?? describeFetchError(store.error)}
        </p>
      )}
      {note && <p style={{ color: 'var(--oe-mid-grey)', fontSize: '13px', margin: '0 0 10px' }}>{note}</p>}

      <div style={{ overflowX: 'auto' }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={headCell}>File</th>
              <th style={headCell}>Built</th>
              <th style={headCell}>Changed</th>
              <th style={headCell}>Status</th>
              <th style={headCell}></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <Row
                key={rowKey(entry)}
                entry={entry}
                status={statuses[rowKey(entry)]}
                disabled={busy || !secret}
                onFlush={() => void flush([entry])}
              />
            ))}
          </tbody>
        </table>
      </div>

      {store.isFetching && entries.length === 0 && (
        <p style={{ color: 'var(--oe-mid-grey)', fontSize: '13px' }}>Reading the store…</p>
      )}
    </main>
  );
}

/**
 * Did the purge actually land?
 *
 * The one question the old 28-year probe answered that the store table can't.
 * `cache: 'reload'` is required: the data routes send `max-age=60`, so without
 * it the browser answers from its own copy — the one layer no purge can reach —
 * and we'd learn nothing. It doesn't change the URL, so the edge cache key is
 * still the visitor's, and Cloudflare ignores a client `no-cache`, so the status
 * stays truthful. This request refills the entry it reports on, which is fine
 * and expected: MISS means it was empty when we asked.
 */
async function verifyEdge(year: number | undefined): Promise<string> {
  if (year === undefined) return '';
  try {
    const res = await fetch(capacityFactorsPath(year), { cache: 'reload' });
    await res.arrayBuffer();
    const status = res.headers.get('cf-cache-status');
    // No Workers Cache in front of a local dev server, so there is nothing to
    // report rather than something to worry about.
    if (!status) return 'No edge cache in this environment.';
    if (status === 'HIT') return `Edge still serving ${year} (age ${res.headers.get('age') ?? '?'}s).`;
    return `Edge cleared (${year}: ${status}).`;
  } catch {
    return 'Could not verify the edge.';
  }
}

function Row({
  entry,
  status,
  disabled,
  onFlush,
}: {
  entry: StoreEntry;
  status: RowStatus | undefined;
  disabled: boolean;
  onFlush: () => void;
}) {
  return (
    <tr>
      <td style={cell}>{rowLabel(entry)}</td>
      <td style={cell} title={entry.builtAt ?? ''}>
        {age(entry.builtAt)}
      </td>
      <td style={cell} title={entry.dataChangedAt ?? ''}>
        {age(entry.dataChangedAt)}
      </td>
      <td style={{ ...cell, color: statusColour(entry, status) }}>{statusText(entry, status)}</td>
      <td style={cell}>
        <button
          onClick={onFlush}
          disabled={disabled}
          title={disabled ? 'Enter CACHE_SECRET first' : `Recompute ${rowLabel(entry)} and clear the edge`}
          style={button}
        >
          Flush
        </button>
      </td>
    </tr>
  );
}

const age = (stamp: string | null): string =>
  stamp ? formatCompactAgeFromAEST(stamp) ?? stamp : '—';

/**
 * The status cell is where the two date columns stop needing an explanation:
 * after a flush it says `updated` or `unchanged`, which is exactly the
 * difference between them. Most flushes re-fetch identical numbers, so
 * `unchanged` — Built at moved, Changed at didn't — is the normal result.
 */
function statusText(entry: StoreEntry, status: RowStatus | undefined): string {
  if (status) {
    switch (status.state) {
      case 'queued':
        return 'queued';
      case 'running':
        return entry.kind === 'stats'
          ? 'folding…'
          : entry.kind === 'metadata'
            ? 'scanning…'
            : 'fetching…';
      case 'done':
        return status.changed ? 'updated' : 'unchanged';
      case 'failed':
        return status.error;
    }
  }
  if (!entry.builtAt) return 'never built';
  if (entry.stale) return 'stale';
  return '—';
}

/**
 * Status text colour, on the design system's semantic trio.
 *
 * `--oe-alert-yellow` is Open Electricity's name for #EB1F70, which is a
 * magenta. The name is theirs and so is the value; we use it for "in flight"
 * because it is the one token in the palette that is neither pass nor fail.
 */
function statusColour(entry: StoreEntry, status: RowStatus | undefined): string {
  if (status?.state === 'failed') return 'var(--oe-error-red)';
  if (status?.state === 'done') return status.changed ? 'var(--oe-success-green)' : 'var(--oe-mid-grey)';
  if (status) return 'var(--oe-alert-yellow)';
  if (!entry.builtAt || entry.stale) return 'var(--oe-error-red)';
  return 'var(--oe-mid-grey)';
}

// Design-system tokens, read from the custom properties opennem.css publishes,
// rather than the hand-picked greys and the guessed `var(--font-body)` /
// `var(--font-mono)` (neither of which was ever defined) that were here before.
const page: React.CSSProperties = {
  maxWidth: '760px',
  margin: '0 auto',
  padding: '32px 20px 80px',
  fontFamily: 'var(--font-stack)',
  color: 'var(--oe-dark-grey)',
};
const table: React.CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '13px',
  fontFamily: 'var(--font-data)',
  fontVariantNumeric: 'tabular-nums',
  minWidth: '520px',
};
const cell: React.CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid var(--oe-warm-grey)',
  whiteSpace: 'nowrap',
};
const headCell: React.CSSProperties = {
  ...cell,
  textAlign: 'left',
  fontWeight: 500,
  borderBottom: '2px solid var(--oe-mid-warm-grey)',
  position: 'sticky',
  top: 0,
  background: 'var(--oe-white)',
};
// Open Electricity's house button, inline so it can sit in this file's style
// objects alongside the rest. Kept small — these are admin controls, not calls
// to action — but the fill, the face and the radius are the real ones.
const button: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: '12px',
  fontWeight: 500,
  padding: '4px 10px',
  border: '1px solid var(--oe-black)',
  borderRadius: '4px',
  background: 'var(--oe-black)',
  color: 'var(--oe-white)',
  cursor: 'pointer',
};
const input: React.CSSProperties = {
  fontFamily: 'var(--font-data)',
  fontSize: '12px',
  padding: '3px 8px',
  border: '1px solid var(--oe-mid-warm-grey)',
  borderRadius: '4px',
  width: '200px',
};
