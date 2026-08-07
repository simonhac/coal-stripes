'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAgeFromAEST, getAESTDateTimeString, getTodayAEST } from '@/shared/date-utils';
import {
  tileTimingRecorder,
  type TileTimingRecord,
} from '@/client/tile-timing-recorder';

// Mirrors the /api/diagnostics/tiles response (kept local to avoid importing a
// server module into the client bundle).
type TileClassification = 'warm' | 'cold' | 'uncertain';

interface TileDiagnostic {
  year: number;
  tier: 'current' | 'recent' | 'archive';
  ms: number;
  status: number;
  ok: boolean;
  edge: { xVercelCache: string | null; age: number | null; ms: number };
  dataCache: {
    coldFetch: boolean | null;
    coldFetchMs: number | null;
    builtAt: string | null;
    ms: number;
  };
  classification: TileClassification;
}

interface DiagnosticsSummary {
  yearsProbed: number;
  warm: number;
  cold: number;
  uncertain: number;
  failed: number;
  edgeHits: number;
  slowestYear: number | null;
  slowestMs: number | null;
  totalMs: number;
  allWarm: boolean;
}

interface TilesDiagnosticsResponse {
  generatedAt: string;
  range: { from: number; to: number };
  thresholds: { warmMaxMs: number; coldMinMs: number };
  summary: DiagnosticsSummary;
  tiles: TileDiagnostic[];
}

const CLASS_COLOUR: Record<TileClassification, string> = {
  warm: '#137333',
  cold: '#c5221f',
  uncertain: '#b06000',
};

const cell: React.CSSProperties = {
  padding: '4px 10px',
  borderBottom: '1px solid #e0e0e0',
  textAlign: 'left',
  whiteSpace: 'nowrap',
};
const headCell: React.CSSProperties = {
  ...cell,
  borderBottom: '2px solid #999',
  fontWeight: 600,
  position: 'sticky',
  top: 0,
  background: '#fafafa',
};
const numCell: React.CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

// The "Cold fetch?" column is now unambiguous: the probe it comes from bypasses
// the CDN, so `x-cf-cold` always describes what that request actually paid,
// never a value replayed from an edge entry built minutes or hours ago.
function coldFetchCell(t: TileDiagnostic): { text: string; colour: string } {
  if (t.dataCache.coldFetch === null) return { text: '—', colour: '#555' };
  if (!t.dataCache.coldFetch) return { text: 'no', colour: '#1a1a1a' };
  const ms = t.dataCache.coldFetchMs ? ` (${t.dataCache.coldFetchMs} ms)` : '';
  return { text: `yes${ms}`, colour: CLASS_COLOUR.cold };
}

// The edge either answered on its own (what a visitor wants) or didn't. An
// edge MISS is not a failure — the origin's Data Cache is right behind it — but
// it does mean that visitor pays an origin round-trip instead of ~0.3 s.
function edgeCell(t: TileDiagnostic): { text: string; colour: string } {
  const raw = t.edge.xVercelCache;
  if (raw === null) return { text: '—', colour: '#555' };
  const hit = raw.toUpperCase() === 'HIT' || (t.edge.age ?? 0) > 0;
  return { text: raw.toLowerCase(), colour: hit ? CLASS_COLOUR.warm : '#b06000' };
}

// Mirrors the /api/admin/purge response.
interface PurgeStep {
  step: string;
  ok: boolean;
  detail: string;
}
interface WarmResult {
  year: number;
  mode: string;
  ok: boolean;
  status: number;
  ms: number;
  cold: boolean;
  skipped: boolean;
}
interface PurgeResponse {
  mode: 'purge' | 'rewarm';
  purgedAt: string;
  baseUrl: string;
  ok: boolean;
  steps: PurgeStep[];
  rewarm: { from: number; to: number; results: WarmResult[] };
  note: string;
  totalMs: number;
}

/**
 * One-click purge of every server-side cache.
 *
 * The secret is held in React state only — never localStorage — so it lives no
 * longer than the tab. A purge forces cold, rate-limited OpenElectricity
 * fetches, hence the auth and the confirm step.
 */
function PurgeCaches() {
  const queryClient = useQueryClient();
  const currentYear = getTodayAEST().year;

  const [secret, setSecret] = useState('');
  const [from, setFrom] = useState(String(currentYear));
  const [to, setTo] = useState(String(currentYear));
  const [phase, setPhase] = useState<'idle' | 'purging' | 'rewarming'>('idle');
  const [results, setResults] = useState<PurgeResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== 'idle';

  async function call(body: Record<string, unknown>): Promise<PurgeResponse> {
    const res = await fetch('/api/admin/purge', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.error ?? res.statusText}`);
    return json as PurgeResponse;
  }

  async function purge() {
    if (!secret) {
      setError('Enter CACHE_SECRET first.');
      return;
    }
    if (
      !window.confirm(
        `Purge all server caches and re-warm ${from}-${to}?\n\n` +
          'This discards every cached year and forces fresh, rate-limited fetches ' +
          'from OpenElectricity.',
      )
    ) {
      return;
    }

    setError(null);
    setResults([]);
    try {
      // Two requests, deliberately: revalidateTag also discards cache entries
      // written later in the SAME request, so a re-warm bundled into the purge
      // would be thrown away. See src/app/api/admin/purge/route.ts.
      setPhase('purging');
      const purged = await call({ mode: 'purge' });
      setResults([purged]);

      setPhase('rewarming');
      const rewarmed = await call({
        mode: 'rewarm',
        rewarmFrom: Number.parseInt(from, 10),
        rewarmTo: Number.parseInt(to, 10),
      });
      setResults([purged, rewarmed]);

      // Drop this tab's own query cache too, so the app reflects the purge
      // without a reload.
      await queryClient.invalidateQueries();
    } catch (e) {
      setError((e as Error)?.message ?? 'Request failed');
    } finally {
      setPhase('idle');
    }
  }

  return (
    <section style={{ marginBottom: '40px' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: '18px' }}>Purge server caches</h2>
      <p style={{ margin: '0 0 12px', color: '#555', fontSize: '13px', maxWidth: '760px' }}>
        Clears the Next.js Data Cache (<code>revalidateTag</code>), the Vercel CDN edge
        (<code>invalidateByTag</code> on the <code>Vercel-Cache-Tag</code> the data routes emit),
        and this instance&rsquo;s facilities-roster memo — then re-warms the year range below so the
        next visitor doesn&rsquo;t pay the cold fetch. Years outside that range are purged but
        refill on the next <code>warm-all</code> cron run (every 10 minutes). The browser&rsquo;s
        own HTTP cache can never be purged, which is why the data routes keep their browser{' '}
        <code>max-age</code> down to 60 s. Requires <code>CACHE_SECRET</code> (its own secret, not
        the cron token); it is kept in this tab only, never stored.
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
        <label style={{ fontSize: '13px', color: '#555' }}>
          Re-warm{' '}
          <input
            type="number"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ ...inputStyle, width: '70px' }}
          />
          {' – '}
          <input
            type="number"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ ...inputStyle, width: '70px' }}
          />
        </label>
        <button onClick={purge} disabled={busy} style={buttonStyle}>
          {phase === 'purging'
            ? 'Purging…'
            : phase === 'rewarming'
              ? `Re-warming ${from}–${to}…`
              : 'Purge caches'}
        </button>
      </div>

      {error && <p style={{ color: CLASS_COLOUR.cold, fontSize: '13px' }}>{error}</p>}

      {results.map((result) => (
        <div key={result.mode} style={{ marginTop: '12px' }}>
          <p style={{ margin: '0 0 8px', fontSize: '14px' }}>
            <strong style={{ color: result.ok ? CLASS_COLOUR.warm : CLASS_COLOUR.cold }}>
              {result.ok ? '✓' : '✗'} {result.mode}
            </strong>{' '}
            — {result.purgedAt} · {result.totalMs} ms
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={headCell}>Step</th>
                <th style={headCell}>Result</th>
                <th style={headCell}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.map((s) => (
                <tr key={s.step}>
                  <td style={cell}>{s.step}</td>
                  <td
                    style={{
                      ...cell,
                      color: s.ok ? CLASS_COLOUR.warm : CLASS_COLOUR.cold,
                      fontWeight: 600,
                    }}
                  >
                    {s.ok ? 'ok' : 'failed'}
                  </td>
                  <td style={{ ...cell, whiteSpace: 'normal' }}>{s.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: '10px 0 0', color: '#b06000', fontSize: '13px', maxWidth: '760px' }}>
            {result.note}
          </p>
        </div>
      ))}
    </section>
  );
}

function ServerCacheHealth() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useQuery<TilesDiagnosticsResponse>({
      queryKey: ['diagnostics', 'tiles'],
      queryFn: async () => {
        const res = await fetch('/api/diagnostics/tiles');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
      staleTime: 0,
      gcTime: 0,
    });

  return (
    <section style={{ marginBottom: '40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '8px' }}>
        <h2 style={{ margin: 0, fontSize: '18px' }}>Server cache health (per year)</h2>
        <button onClick={() => refetch()} disabled={isFetching} style={buttonStyle}>
          {isFetching ? 'Probing…' : 'Re-probe'}
        </button>
      </div>
      <p style={{ margin: '0 0 12px', color: '#555', fontSize: '13px', maxWidth: '760px' }}>
        There are two caches between a visitor and OpenElectricity, and each year is probed twice so
        they can be read separately. <strong>Data cache</strong> is the origin&rsquo;s own store —
        probed with the CDN deliberately bypassed, so <code>x-cf-cold</code> always says what{' '}
        <em>that</em> request paid rather than replaying an old value. This is the layer the
        every-10-minute warmer is responsible for. <strong>Edge</strong> is the Vercel CDN in
        Sydney: a <code>hit</code> means a visitor gets the year in ~0.3 s without the server
        running at all; a <code>miss</code> is not a failure, it just costs them one origin
        round-trip. Only a <strong>cold</strong> Data cache means somebody would have waited on
        OpenElectricity. <strong>Built at</strong> is when that year&rsquo;s data was last assembled
        upstream — it travels with the body, so it stays honest no matter which cache replayed it,
        and it is the column to read when asking whether an upstream data fix has reached us yet.
      </p>

      {isLoading && <p style={{ color: '#555' }}>Probing every year… this can take a while if a tile is cold.</p>}
      {isError && <p style={{ color: CLASS_COLOUR.cold }}>Failed to probe: {(error as Error)?.message}</p>}

      {data && (
        <>
          <p style={{ margin: '0 0 10px', fontSize: '14px' }}>
            <strong
              style={{ color: data.summary.allWarm ? CLASS_COLOUR.warm : CLASS_COLOUR.cold }}
            >
              {data.summary.allWarm ? '✓ All tiles warm' : '✗ Not all tiles warm'}
            </strong>{' '}
            — data cache: {data.summary.warm} warm, {data.summary.cold} cold,{' '}
            {data.summary.uncertain} uncertain
            {data.summary.failed > 0 ? `, ${data.summary.failed} failed` : ''} · edge:{' '}
            {data.summary.edgeHits}/{data.summary.yearsProbed} hit · slowest{' '}
            {data.summary.slowestYear ?? '—'} ({data.summary.slowestMs ?? '—'} ms) · probed{' '}
            {data.generatedAt}
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={headCell}>Year</th>
                  <th style={headCell}>Tier</th>
                  <th style={headCell}>Data cache</th>
                  <th style={numCell}>Latency</th>
                  <th style={headCell}>Cold fetch?</th>
                  <th style={headCell}>Built at</th>
                  <th style={headCell}>Data age</th>
                  <th style={headCell}>Edge</th>
                  <th style={numCell}>Edge age (s)</th>
                  <th style={numCell}>Edge latency</th>
                </tr>
              </thead>
              <tbody>
                {data.tiles.map((t) => {
                  const cf = coldFetchCell(t);
                  const eg = edgeCell(t);
                  const builtAt = t.dataCache.builtAt;
                  return (
                    <tr key={t.year}>
                      <td style={cell}>{t.year}</td>
                      <td style={cell}>{t.tier}</td>
                      <td style={{ ...cell, color: CLASS_COLOUR[t.classification], fontWeight: 600 }}>
                        {t.classification}
                        {!t.ok ? ` (${t.status})` : ''}
                      </td>
                      <td style={numCell}>{t.dataCache.ms} ms</td>
                      <td style={{ ...cell, color: cf.colour }}>{cf.text}</td>
                      <td style={cell}>{builtAt ? builtAt.replace('T', ' ').slice(0, 16) : '—'}</td>
                      <td style={cell}>{(builtAt && formatAgeFromAEST(builtAt)) ?? '—'}</td>
                      <td style={{ ...cell, color: eg.colour, fontWeight: 600 }}>{eg.text}</td>
                      <td style={numCell}>{t.edge.age ?? '—'}</td>
                      <td style={numCell}>{t.edge.ms} ms</td>
                    </tr>
                  );
                })}
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
          No client render timings captured in this browser session yet. These populate only as tiles
          are built. Open the <Link href="/">visualisation</Link>, navigate between years (e.g. jump
          to the start year), then return here <strong>in the same tab</strong> — a hard refresh or a
          new tab starts empty.
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
  fontFamily: 'var(--font-geist-mono, monospace)',
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
  fontFamily: 'var(--font-geist-mono, monospace)',
};

export default function DiagnosticsPage() {
  return (
    <main
      style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '32px 20px 80px',
        fontFamily: 'var(--font-geist-sans, system-ui, sans-serif)',
        color: '#1a1a1a',
      }}
    >
      <header style={{ marginBottom: '28px' }}>
        <h1 style={{ margin: '0 0 6px', fontSize: '24px' }}>Tile render diagnostics</h1>
        <p style={{ margin: 0, color: '#555', fontSize: '14px' }}>
          Server cache health answers “is cron caching working?” and “how old is the data we
          hold?”; the client table lists how long each tile took to render in this browser.{' '}
          <Link href="/">← back to the visualisation</Link>
        </p>
      </header>
      <PurgeCaches />
      <ServerCacheHealth />
      <ClientRenderTimes />
    </main>
  );
}
