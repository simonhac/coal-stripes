import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { CapFacTooltip, TooltipData } from './CapFacTooltip';
import {
  calculateRegionStats,
  calculateAverageCapacityFactor,
  getRegionNames,
} from '@/client/cap-fac-stats';
import { useFleetMode } from '@/client/fleet-mode-context';

interface RegionTooltipProps {
  regionCode: string;
  isMobile: boolean;
}

/**
 * One region's tooltip, and the hover subscription that feeds it.
 *
 * Deliberately a leaf. The subscription used to sit in RegionSection, so every
 * hover re-rendered the whole section — its region label, every facility label,
 * every tile and the month axis — when the only thing that had changed was the
 * tooltip. Subscribing down here keeps a hover to six re-renders across the
 * page instead of forty-odd.
 */
export function RegionTooltip({ regionCode, isMobile }: RegionTooltipProps) {
  const queryClient = useQueryClient();
  const mode = useFleetMode();
  const [tooltipData, setTooltipData] = useState<TooltipData | null>(null);

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
        console.error(`Error in RegionTooltip ${regionCode} handleTooltipHover:`, error);
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

  return <CapFacTooltip data={tooltipData} />;
}
