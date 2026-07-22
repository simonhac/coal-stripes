'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OpenElectricityHeader } from '@/components/OpenElectricityHeader';
import { statsQueryOptions } from '@/client/stats-queries';
import { formatEnergy, formatPercent, type Granularity } from '@/shared/energy-format';
import type { CoalGenerationStatsDTO, GranularityStat, StatRow, StatValue } from '@/shared/types';
import '../opennem.css';

const GAP_PREVIEW_LIMIT = 20;

const PANELS: { granularity: Granularity; title: string; subtitle: string }[] = [
  {
    granularity: 'day',
    title: 'Daily records',
    subtitle: 'Highest single-day coal generation, and the most recent day.',
  },
  {
    granularity: 'month',
    title: 'Monthly records',
    subtitle: 'Highest calendar-month total, and the most recent complete month.',
  },
  {
    granularity: 'quarter',
    title: 'Quarterly records',
    subtitle: 'Highest calendar-quarter total, and the most recent complete quarter.',
  },
  {
    granularity: 'year',
    title: 'Annual records',
    subtitle: 'Highest calendar-year total, and the most recent complete year.',
  },
];

function holeTitle(value: StatValue): string | undefined {
  const { holeUnitDays, estimatedFullTotal } = value.coverage;
  if (holeUnitDays <= 0) return undefined;
  const est = estimatedFullTotal ? `; ≈ ${formatEnergy(estimatedFullTotal)} at full coverage` : '';
  return `${holeUnitDays.toLocaleString('en-AU')} unit-days missing in this period — the total is a lower bound${est}`;
}

function ValueCell({ value, granularity }: { value: StatValue | null; granularity: Granularity }) {
  if (!value) {
    return <td className="opennem-stats-num opennem-stats-empty">—</td>;
  }
  const sub =
    granularity === 'day'
      ? value.label
      : `${value.label} · ${formatEnergy(value.avgPerDay)}/day`;
  const title = holeTitle(value);
  return (
    <td className="opennem-stats-num">
      <span className="opennem-stats-value">
        {formatEnergy(value.total)}
        {title && (
          <sup className="opennem-stats-flag" title={title}>
            *
          </sup>
        )}
      </span>
      <span className="opennem-stats-sub">{sub}</span>
    </td>
  );
}

function ProportionCell({ proportion }: { proportion: number | null }) {
  if (proportion === null) {
    return <td className="opennem-stats-num opennem-stats-empty">—</td>;
  }
  const pct = Math.min(100, Math.max(0, proportion * 100));
  return (
    <td className="opennem-stats-num">
      <span className="opennem-stats-value">{formatPercent(proportion)}</span>
      <span className="opennem-stats-bar">
        <span className="opennem-stats-bar-fill" style={{ width: `${pct}%` }} />
      </span>
    </td>
  );
}

function StatPanel({
  granularity,
  title,
  subtitle,
  rows,
}: {
  granularity: Granularity;
  title: string;
  subtitle: string;
  rows: StatRow[];
}) {
  return (
    <section className="opennem-stats-panel">
      <div className="opennem-stats-panel-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <div className="opennem-stats-scroll">
        <table className="opennem-stats-table">
          <thead>
            <tr>
              <th className="opennem-stats-rowlabel">Region</th>
              <th className="opennem-stats-num">Peak</th>
              <th className="opennem-stats-num">Most recent</th>
              <th className="opennem-stats-num">% of peak</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const stat: GranularityStat = row[granularity];
              return (
                <tr key={row.key} className={`opennem-stats-row opennem-stats-row-${row.kind}`}>
                  <th scope="row" className="opennem-stats-rowlabel">
                    <span className="opennem-stats-rowlabel-long">{row.label.long}</span>
                    <span className="opennem-stats-rowlabel-short">{row.label.short}</span>
                  </th>
                  <ValueCell value={stat.peak} granularity={granularity} />
                  <ValueCell value={stat.recent} granularity={granularity} />
                  <ProportionCell proportion={stat.proportion} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DataQualityPanel({ dq }: { dq: CoalGenerationStatsDTO['dataQuality'] }) {
  const [showAll, setShowAll] = useState(false);

  // Tolerate an older cached payload whose shape predates `gaps`.
  const gaps = dq.gaps ?? [];
  if (gaps.length === 0) return null;

  const truncated = gaps.length > GAP_PREVIEW_LIMIT;
  const shown = showAll ? gaps : gaps.slice(0, GAP_PREVIEW_LIMIT);
  const remainderCount = gaps.length - shown.length;
  const remainderDays = dq.totalHoleUnitDays - shown.reduce((sum, g) => sum + g.days, 0);

  const listNote = !truncated
    ? `All ${gaps.length.toLocaleString('en-AU')} are shown below, longest first.`
    : showAll
      ? `Showing all ${gaps.length.toLocaleString('en-AU')} gaps, longest first.`
      : `The ${GAP_PREVIEW_LIMIT} longest are shown below (of ${gaps.length.toLocaleString('en-AU')} total), longest first.`;

  return (
    <section className="opennem-stats-panel">
      <div className="opennem-stats-panel-head">
        <h2>Data quality</h2>
        <p>
          {dq.totalHoleUnitDays.toLocaleString('en-AU')} unit-days across{' '}
          {gaps.length.toLocaleString('en-AU')} gaps are missing from OpenElectricity between each
          unit&rsquo;s first and last recorded generation. Totals over affected periods are marked{' '}
          <span className="opennem-stats-flag">*</span> and shown as lower bounds. {listNote}
        </p>
      </div>
      <div className="opennem-stats-scroll">
        <table className="opennem-stats-table">
          <thead>
            <tr>
              <th className="opennem-stats-rowlabel">Unit</th>
              <th className="opennem-stats-rowlabel">Region</th>
              <th className="opennem-stats-rowlabel">Gap</th>
              <th className="opennem-stats-num">Days</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((gap) => (
              <tr
                key={`${gap.duid}-${gap.start}`}
                className="opennem-stats-row opennem-stats-row-region"
              >
                <th scope="row" className="opennem-stats-rowlabel">
                  {gap.duid}
                </th>
                <td className="opennem-stats-rowlabel">{gap.region}</td>
                <td className="opennem-stats-rowlabel">
                  {gap.start} → {gap.end}
                </td>
                <td className="opennem-stats-num">
                  <span className="opennem-stats-value">{gap.days.toLocaleString('en-AU')}</span>
                </td>
              </tr>
            ))}
            {truncated && !showAll && (
              <tr className="opennem-stats-row opennem-stats-row-total">
                <th scope="row" className="opennem-stats-rowlabel" colSpan={3}>
                  + {remainderCount.toLocaleString('en-AU')} more gaps ·{' '}
                  <button
                    type="button"
                    className="opennem-stats-link"
                    onClick={() => setShowAll(true)}
                  >
                    Show all
                  </button>
                </th>
                <td className="opennem-stats-num">
                  <span className="opennem-stats-value">
                    {remainderDays.toLocaleString('en-AU')}
                  </span>
                </td>
              </tr>
            )}
            {truncated && showAll && (
              <tr className="opennem-stats-row opennem-stats-row-total">
                <th scope="row" className="opennem-stats-rowlabel" colSpan={4}>
                  <button
                    type="button"
                    className="opennem-stats-link"
                    onClick={() => setShowAll(false)}
                  >
                    Show top {GAP_PREVIEW_LIMIT} only
                  </button>
                </th>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function StatsPage() {
  const { data, isLoading, isError, error } = useQuery(statsQueryOptions('full'));

  return (
    <>
      <OpenElectricityHeader />
      <div className="opennem-stats-container">
        <header className="opennem-stats-intro">
          <h1>Coal generation records</h1>
          <p>
            Peak coal generation for each region and network across the National Electricity Market
            and Western Australia, with the most recent period shown as a proportion of that peak.
            Generation (MWh) is reconstructed from daily capacity factors and registered capacity;
            figures include every plant that ever operated, back to 1999.
            {data && (
              <>
                {' '}
                Latest data: <strong>{data.latestDataDay}</strong>.
              </>
            )}
          </p>
        </header>

        {isLoading && (
          <div className="opennem-loading">
            <span className="opennem-loading-spinner" />
            Computing records…
          </div>
        )}

        {isError && (
          <div className="opennem-error">
            Failed to load stats: {(error as Error)?.message ?? 'unknown error'}
          </div>
        )}

        {data && (
          <>
            {PANELS.map((panel) => (
              <StatPanel
                key={panel.granularity}
                granularity={panel.granularity}
                title={panel.title}
                subtitle={panel.subtitle}
                rows={data.rows}
              />
            ))}

            <DataQualityPanel dq={data.dataQuality} />

            <p className="opennem-stats-note">
              Peaks use total generation over complete calendar periods (a partial current period is
              never counted). &ldquo;Most recent&rdquo; is the latest day and the latest complete
              month, quarter and year. Generation is derived as capacity factor × registered
              capacity × 24 h; capacity factors are held to 3 decimal places, so the reconstruction
              is essentially exact. Day totals mix AEST (NEM) and AWST (WEM) calendar days. WEM (WA)
              facility data begins in 2006.
            </p>
          </>
        )}
      </div>
    </>
  );
}
