'use client';

import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { CompositeTile } from './CompositeTile';
import { CapFacTooltip, TooltipData } from './CapFacTooltip';
import { CapFacXAxis } from './CapFacXAxis';
import { FacilityLabel } from './FacilityLabel';
import { RegionLabel } from './RegionLabel';
import { calculateRegionStats, calculateAverageCapacityFactor, getRegionNames } from '@/client/cap-fac-stats';
import { useFleetMode } from '@/client/fleet-mode-context';

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
  const queryClient = useQueryClient();
  const mode = useFleetMode();
  const [tooltipData, setTooltipData] = useState<TooltipData | null>(null);

  // Get region names
  const regionNames = getRegionNames(regionCode);
  const tooltipRegionName = isMobile ? regionNames.short : regionNames.long;

  // Listen for ALL tooltip hover events
  useEffect(() => {
    const handleTooltipHover = (e: Event) => {
      try {
        const customEvent = e as CustomEvent;
        const data = customEvent.detail as TooltipData;
      
      if (data) {
        // Check if hover is from our region or another region
        if (data.regionCode === regionCode) {
          setTooltipData(data);
        } else {
          // the hover is for a different region -- create an appropriate data object for this region
          
          // Determine date range based on tooltip type
          let dateRange: { start: CalendarDate; end: CalendarDate };

          switch (data.tooltipType) {
            case 'day':
              // For a single day, create a range of just that day
              dateRange = { start: data.startDate, end: data.startDate };
              break;

            case 'month':
            case 'period':
              // For month or period, use the provided range
              dateRange = { start: data.startDate, end: data.endDate || data.startDate };
              break;

            default:
              console.warn(`${regionCode} got ${data.regionCode}'s update with unknown tooltip type`);
              setTooltipData(null);
              return;
          }
          
          // Calculate capacity factor for our region
          const stats = calculateRegionStats(queryClient, mode, regionCode, dateRange);
          const avgCapacityFactor = calculateAverageCapacityFactor(stats);
          
          const myTooltipData: TooltipData = {
            startDate: data.startDate,
            endDate: data.tooltipType === 'day' ? null : data.endDate,
            label: tooltipRegionName,
            capacityFactor:  avgCapacityFactor,
            tooltipType: data.tooltipType,
            regionCode: regionCode,
            pinned: data.pinned
          }

          setTooltipData(myTooltipData);
        }
      }
      } catch (error) {
        console.error(`Error in RegionSection ${regionCode} handleTooltipHover:`, error);
      }
    };
    
    const handleTooltipHoverEnd = () => {
      // Always clear on explicit hover-end event (this now handles unpinning too)
      setTooltipData(null);
    };
    
    window.addEventListener('tooltip-data-hover', handleTooltipHover);
    window.addEventListener('tooltip-data-hover-end', handleTooltipHoverEnd);
    
    return () => {
      window.removeEventListener('tooltip-data-hover', handleTooltipHover);
      window.removeEventListener('tooltip-data-hover-end', handleTooltipHoverEnd);
    };
  }, [regionCode, tooltipRegionName, queryClient, mode]);
  
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
        <CapFacTooltip data={tooltipData} />
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