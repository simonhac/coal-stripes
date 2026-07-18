'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getAESTDateTimeString } from '@/shared/date-utils';
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
  xVercelCache: string | null;
  age: number | null;
  coldFetch: boolean | null;
  coldFetchMs: number | null;
  classification: TileClassification;
}

interface DiagnosticsSummary {
  yearsProbed: number;
  warm: number;
  cold: number;
  uncertain: number;
  failed: number;
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
        Each year is probed by self-fetching <code>/api/capacity-factors</code>. Latency and the{' '}
        <code>x-cf-cold</code> marker reveal whether a warm Next.js Data Cache served it or a cold
        OpenElectricity fetch was paid. <code>x-vercel-cache</code> reflects only the regional CDN
        edge (a <code>MISS</code> can still be warm at the origin).
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
            — {data.summary.warm} warm, {data.summary.cold} cold, {data.summary.uncertain} uncertain
            {data.summary.failed > 0 ? `, ${data.summary.failed} failed` : ''} · slowest{' '}
            {data.summary.slowestYear ?? '—'} ({data.summary.slowestMs ?? '—'} ms) · probed{' '}
            {data.generatedAt}
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={headCell}>Year</th>
                  <th style={headCell}>Tier</th>
                  <th style={headCell}>Status</th>
                  <th style={numCell}>Latency</th>
                  <th style={headCell}>Cold fetch?</th>
                  <th style={headCell}>x-vercel-cache</th>
                  <th style={numCell}>Age (s)</th>
                </tr>
              </thead>
              <tbody>
                {data.tiles.map((t) => (
                  <tr key={t.year}>
                    <td style={cell}>{t.year}</td>
                    <td style={cell}>{t.tier}</td>
                    <td style={{ ...cell, color: CLASS_COLOUR[t.classification], fontWeight: 600 }}>
                      {t.classification}
                      {!t.ok ? ` (${t.status})` : ''}
                    </td>
                    <td style={numCell}>{t.ms} ms</td>
                    <td style={cell}>
                      {t.coldFetch === null ? '—' : t.coldFetch ? `yes${t.coldFetchMs ? ` (${t.coldFetchMs} ms)` : ''}` : 'no'}
                    </td>
                    <td style={cell}>{t.xVercelCache ?? '—'}</td>
                    <td style={numCell}>{t.age ?? '—'}</td>
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
          Server cache health answers “is cron caching working?”; the client table lists how long
          each tile took to render in this browser. <Link href="/">← back to the visualisation</Link>
        </p>
      </header>
      <ServerCacheHealth />
      <ClientRenderTimes />
    </main>
  );
}
