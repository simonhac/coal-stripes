/**
 * Diagnostics.
 *
 * Much smaller than the Vercel version, because most of what it existed to
 * answer no longer needs asking. It used to reconcile four caches with three
 * invalidation mechanisms, and `/api/diagnostics/tiles` had to probe each year
 * TWICE — once cache-busted at the origin, once plain at the edge — because no
 * single response could tell you which layer had answered. Workers Cache reports
 * that itself in `cf-cache-status`, so one plain request per year is enough.
 *
 * What remains: purge (one button, one call), a per-year cache probe, and the
 * client-side tile render timings, which have no server equivalent.
 */
import React, { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAESTDateTimeString, getTodayAEST } from '@/shared/date-utils';
import { capacityFactorsPath } from '@/shared/capacity-factors-url';
import { DATE_BOUNDARIES } from '@/shared/config';
import {
  tileTimingRecorder,
  type TileTimingRecord,
} from '@/client/tile-timing-recorder';

const cell: React.CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid #e5e5e5',
  whiteSpace: 'nowrap',
};
const headCell: React.CSSProperties = {
  ...cell,
  textAlign: 'left',
  fontWeight: 600,
  borderBottom: '2px solid #ccc',
  position: 'sticky',
  top: 0,
  background: '#fff',
};
const numCell: React.CSSProperties = {
  ...cell,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

/** Cloudflare's own vocabulary — no local classification to keep in sync. */
const STATUS_COLOUR: Record<string, string> = {
  HIT: '#137333',
  MISS: '#b06000',
  EXPIRED: '#b06000',
  STALE: '#b06000',
  UPDATING: '#b06000',
  REVALIDATED: '#137333',
  BYPASS: '#999',
};

interface PurgeResponse {
  purgedAt: string;
  tags: string[];
  ok: boolean;
  errors: unknown[];
  note: string;
  totalMs: number;
}

/**
 * One-click purge of the server-side cache.
 *
 * The secret is held in React state only — never localStorage — so it lives no
 * longer than the tab. A purge forces cold, rate-limited OpenElectricity
 * fetches, hence the auth and the confirm step.
 *
 * One mutation, not two. The Vercel version had to purge and re-warm in
 * separate requests because `revalidateTag` also discarded entries written
 * later in the same request. Workers Cache has no such behaviour, and purging
 * is cheap now anyway: R2 is untouched, so the next request for each year
 * refills the cache from a stored object rather than from OpenElectricity.
 */
function PurgeCaches() {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState('');
  const [precondition, setPrecondition] = useState<string | null>(null);

  const purge = useMutation({
    mutationFn: async (): Promise<PurgeResponse> => {
      const res = await fetch('/api/admin/purge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
      });
      const json = (await res.json()) as { error?: string } | null;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.error ?? res.statusText}`);
      return json as unknown as PurgeResponse;
    },
    // Drop this tab's own query cache too, so the app reflects the purge
    // without a reload.
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const error = precondition ?? purge.error?.message ?? null;

  function run() {
    if (!secret) {
      setPrecondition('Enter CACHE_SECRET first.');
      return;
    }
    if (
      !window.confirm(
        'Purge every cached year and the stats payload?\n\n' +
          'The R2 store is not touched, so the next request for each year is ' +
          'refilled from a stored object, not from OpenElectricity.',
      )
    ) {
      return;
    }
    setPrecondition(null);
    purge.mutate();
  }

  return (
    <section style={{ marginBottom: '40px' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: '18px' }}>Purge server cache</h2>
      <p style={{ margin: '0 0 12px', color: '#555', fontSize: '13px', maxWidth: '760px' }}>
        Purges the <code>capacity-factors</code> and <code>coal-stats</code> tags from Workers
        Cache globally, and clears the facilities-roster memo on whichever isolate serves the
        request. The browser&rsquo;s own HTTP cache can never be purged, which is why the data
        routes keep their browser <code>max-age</code> at 60&nbsp;s. Requires{' '}
        <code>CACHE_SECRET</code> (its own secret, not the cron token); it is kept in this tab
        only, never stored.
      </p>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="CACHE_SECRET"
          autoComplete="off"
          style={{ ...inputStyle, width: '220px' }}
        />
        <button onClick={run} disabled={purge.isPending} style={buttonStyle}>
          {purge.isPending ? 'Purging…' : 'Purge'}
        </button>
      </div>

      {error && (
        <p style={{ color: '#c00', fontSize: '13px', marginTop: '10px' }}>{error}</p>
      )}
      {purge.data && (
        <p style={{ color: '#555', fontSize: '13px', marginTop: '10px' }}>
          Purged {purge.data.tags.join(', ')} at {purge.data.purgedAt} in {purge.data.totalMs} ms.{' '}
          {purge.data.note}
        </p>
      )}
    </section>
  );
}

interface Probe {
  year: number;
  ok: boolean;
  status: number;
  cacheStatus: string;
  source: string;
  age: string | null;
  builtAt: string | null;
  ms: number;
}

/**
 * Per-year cache health, by asking for exactly what a visitor would ask for.
 *
 * The request must be identical to the client's — same path, same query string —
 * because the cache key includes the whole query string. Adding a cache-buster
 * here, as the old origin probe did, would measure an entry nobody else reads.
 */
async function probeYear(year: number): Promise<Probe> {
  const started = performance.now();
  const res = await fetch(capacityFactorsPath(year));
  await res.arrayBuffer();
  return {
    year,
    ok: res.ok,
    status: res.status,
    cacheStatus: res.headers.get('cf-cache-status') ?? '—',
    // Survives a HIT: the header was stored with the cached response, so it
    // keeps reporting what originally produced the entry even though the Worker
    // did not run this time. Measured, not assumed.
    source: res.headers.get('x-cf-source') ?? '—',
    age: res.headers.get('age'),
    builtAt: res.headers.get('x-cf-built-at'),
    ms: Math.round(performance.now() - started),
  };
}

function ServerCacheHealth() {
  const firstYear = DATE_BOUNDARIES.EARLIEST_START_DATE.year;
  const lastYear = getTodayAEST().year;

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['cache-probe', firstYear, lastYear],
    // Deliberately manual: probing every year issues ~28 requests and, on a cold
    // cache, makes the visitor pay for them.
    enabled: false,
    queryFn: async () => {
      const years: number[] = [];
      for (let y = firstYear; y <= lastYear; y++) years.push(y);
      const out: Probe[] = [];
      for (const y of years) out.push(await probeYear(y));
      return out;
    },
  });

  const warm = data?.filter((p) => p.cacheStatus === 'HIT').length ?? 0;

  return (
    <section style={{ marginBottom: '40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '8px' }}>
        <h2 style={{ margin: 0, fontSize: '18px' }}>Server cache health</h2>
        <button onClick={() => refetch()} disabled={isFetching} style={buttonStyle}>
          {isFetching ? 'Probing…' : `Probe ${firstYear}–${lastYear}`}
        </button>
      </div>
      <p style={{ margin: '0 0 10px', color: '#555', fontSize: '13px', maxWidth: '760px' }}>
        Requests each year exactly as the visualisation does and reports Cloudflare&rsquo;s own{' '}
        <code>cf-cache-status</code> and our own <code>x-cf-source</code>. <code>HIT</code> is a
        warm entry; <code>MISS</code> means that request rebuilt it — which is now cheap, because{' '}
        <code>x-cf-source: r2</code> says it was rebuilt from the store rather than from
        OpenElectricity. An <code>upstream</code> on an established year is the one result worth
        investigating. <code>x-cf-built-at</code> is when the payload was last assembled from
        OpenElectricity, and travels with the body, so it stays honest however many times the
        response is replayed.
      </p>

      {error && <p style={{ color: '#c00', fontSize: '13px' }}>{error.message}</p>}

      {data && (
        <>
          <p style={{ margin: '0 0 10px', color: '#555', fontSize: '13px' }}>
            {warm} of {data.length} years warm.
          </p>
          <div style={{ overflowX: 'auto', maxHeight: '520px', overflowY: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={headCell}>Year</th>
                  <th style={headCell}>Cache</th>
                  <th style={headCell}>Source</th>
                  <th style={numCell}>Age</th>
                  <th style={numCell}>Time</th>
                  <th style={headCell}>Built at (AEST)</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.year}>
                    <td style={cell}>{p.year}</td>
                    <td style={{ ...cell, color: STATUS_COLOUR[p.cacheStatus] ?? '#1a1a1a' }}>
                      {p.ok ? p.cacheStatus : `HTTP ${p.status}`}
                    </td>
                    <td style={{ ...cell, color: p.source === 'upstream' ? '#c00' : '#1a1a1a' }}>
                      {p.source}
                    </td>
                    <td style={numCell}>{p.age ?? '—'}</td>
                    <td style={numCell}>{p.ms} ms</td>
                    <td style={cell}>{p.builtAt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

const MAX_CLIENT_ROWS = 300;

function ClientRenderTimes() {
  const [records, setRecords] = useState<readonly TileTimingRecord[]>([]);

  useEffect(() => {
    // Poll (rather than subscribe) so a burst of tile-builds during one year
    // load coalesces into ~2 re-renders/second, matching the Shift+P overlay.
    const tick = () => setRecords(tileTimingRecorder.getRecords().slice());
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  const newestFirst = records.slice().reverse();
  const shown = newestFirst.slice(0, MAX_CLIENT_ROWS);

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '8px' }}>
        <h2 style={{ margin: 0, fontSize: '18px' }}>Client tile renders (this session)</h2>
        <button onClick={() => tileTimingRecorder.clear()} style={buttonStyle}>
          Clear
        </button>
      </div>

      {records.length === 0 ? (
        <p style={{ color: '#555', fontSize: '14px', maxWidth: '760px' }}>
          No client render timings captured in this browser session yet. These populate only as
          tiles are built. Open the <Link to="/">visualisation</Link>, navigate between years (e.g.
          jump to the start year), then return here <strong>in the same tab</strong> — a hard
          refresh or a new tab starts empty.
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 10px', color: '#555', fontSize: '13px' }}>
            {records.length} record{records.length === 1 ? '' : 's'} retained
            {records.length > MAX_CLIENT_ROWS ? ` (showing newest ${MAX_CLIENT_ROWS})` : ''}. Newest
            first. <code>tile-build</code> = one facility canvas; <code>year-build</code> = all tiles
            for a year; <code>fetch-build</code> = network + parse + build.
          </p>
          <div style={{ overflowX: 'auto', maxHeight: '520px', overflowY: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={headCell}>Time (AEST)</th>
                  <th style={headCell}>Kind</th>
                  <th style={headCell}>Year</th>
                  <th style={headCell}>Facility</th>
                  <th style={numCell}>Duration</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={`${r.at}-${r.kind}-${r.facility ?? ''}-${i}`}>
                    <td style={cell}>{getAESTDateTimeString(new Date(r.at))}</td>
                    <td style={cell}>{r.kind}</td>
                    <td style={cell}>{r.year}</td>
                    <td style={cell}>{r.facility ?? '—'}</td>
                    <td style={numCell}>{r.ms.toFixed(1)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

const tableStyle: React.CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '13px',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  minWidth: '640px',
};
const buttonStyle: React.CSSProperties = {
  fontSize: '12px',
  padding: '3px 10px',
  border: '1px solid #999',
  borderRadius: '4px',
  background: '#f4f4f4',
  cursor: 'pointer',
};
const inputStyle: React.CSSProperties = {
  fontSize: '12px',
  padding: '3px 8px',
  border: '1px solid #999',
  borderRadius: '4px',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
};

export const Route = createFileRoute('/diagnostics')({ component: DiagnosticsPage });

function DiagnosticsPage() {
  return (
    <main
      style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '32px 20px 80px',
        fontFamily: 'var(--font-body, system-ui, sans-serif)',
        color: '#1a1a1a',
      }}
    >
      <header style={{ marginBottom: '28px' }}>
        <h1 style={{ margin: '0 0 6px', fontSize: '24px' }}>Cache and render diagnostics</h1>
        <p style={{ margin: 0, color: '#555', fontSize: '14px' }}>
          Server cache health answers “does a cold cache cost an R2 read or an upstream fetch?” and
          “how old is the data we hold?”; the client table lists how long each tile took to render
          in this browser.{' '}
          <Link to="/">← back to the visualisation</Link>
        </p>
      </header>
      <PurgeCaches />
      <ServerCacheHealth />
      <ClientRenderTimes />
    </main>
  );
}
