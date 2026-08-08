import React from 'react';
import { CalendarDate } from '@internationalized/date';
import { CompositeTile } from './CompositeTile';
import { CapFacXAxis } from './CapFacXAxis';
import { FacilityLabel } from './FacilityLabel';
import { RegionLabel } from './RegionLabel';
import { RegionTooltip } from './RegionTooltip';

interface RegionSectionProps {
  regionCode: string;
  facilities: { code: string; name: string }[];
  endDate: CalendarDate;
  animatedDateRange: { start: CalendarDate; end: CalendarDate } | null;
  onMonthClick: (year: number, month: number) => void;
  isMobile: boolean;
}

export function RegionSection({
  regionCode,
  facilities,
  endDate,
  animatedDateRange,
  onMonthClick,
  isMobile
}: RegionSectionProps) {
  if (!animatedDateRange) {
    return null;
  }

  return (
    <div key={regionCode} className="opennem-region">
      <div className="opennem-region-header">
        <RegionLabel
          regionCode={regionCode}
          dateRange={animatedDateRange}
          isMobile={isMobile}
        />
        <RegionTooltip regionCode={regionCode} isMobile={isMobile} />
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