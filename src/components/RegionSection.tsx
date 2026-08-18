import React from 'react';
import { CalendarDate } from '@internationalized/date';
import { CompositeTile } from './CompositeTile';
import { CapFacXAxis } from './CapFacXAxis';
import { FacilityLabel } from './FacilityLabel';
import { RegionLabel } from './RegionLabel';
import { RegionTooltip } from './RegionTooltip';
import type { RosterFacility } from '@/client/roster-snapshot';

interface RegionSectionProps {
  regionCode: string;
  facilities: RosterFacility[];
  endDate: CalendarDate;
  animatedDateRange: { start: CalendarDate; end: CalendarDate } | null;
  /** Navigation's destination, for the date range this header may have to show. */
  targetDateRange: { start: CalendarDate; end: CalendarDate } | null;
  onMonthClick: (year: number, month: number) => void;
  isMobile: boolean;
}

export function RegionSection({
  regionCode,
  facilities,
  endDate,
  animatedDateRange,
  targetDateRange,
  onMonthClick,
  isMobile
}: RegionSectionProps) {
  if (!animatedDateRange) {
    return null;
  }

  return (
    <div key={regionCode} className="opennem-region">
      {/* A 1px marker at the region's bottom edge, which is what eventually
          pushes this sticky header out of view. The region itself is far too
          tall to ever fire an IntersectionObserver at that moment; this does.
          See useHeaderDateRangeTracker. */}
      <div className="opennem-region-sentinel" data-region-code={regionCode} aria-hidden="true" />
      <div className="opennem-region-header" data-region-code={regionCode}>
        <RegionLabel regionCode={regionCode} />
        <RegionTooltip
          regionCode={regionCode}
          isMobile={isMobile}
          animatedDateRange={animatedDateRange}
          targetDateRange={targetDateRange}
        />
      </div>
      <div className="opennem-region-content">
        <div className="opennem-facility-group">
          {/* Display all facilities for this region */}
          {facilities.map(facility => {
            return (
              <div key={facility.code} className="opennem-stripe-row" style={{ display: 'flex' }}>
                <FacilityLabel
                  facilityCode={facility.code}
                  facilityName={facility.name}
                  regionCode={regionCode}
                  dateRange={animatedDateRange}
                />
                <CompositeTile
                  endDate={endDate}
                  facilityCode={facility.code}
                  facilityName={facility.name}
                  regionCode={regionCode}
                  animatedDateRange={animatedDateRange}
                  minCanvasHeight={25}
                  fallbackHeight={facility.height}
                />
              </div>
            );
          })}
          
          <CapFacXAxis 
            dateRange={animatedDateRange}
            regionCode={regionCode}
            onMonthClick={onMonthClick}
            isMobile={isMobile}
          />
        </div>
      </div>
    </div>
  );
}