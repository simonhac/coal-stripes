import React from 'react';
import { CalendarDate } from '@internationalized/date';
import { getMonthName } from '@/shared/date-utils';

export interface TooltipData {
  startDate: CalendarDate;
  endDate: CalendarDate | null;
  label: string;
  capacityFactor: number | null;
  tooltipType: 'day' | 'month' | 'period';
  regionCode: string;
  facilityCode?: string;
  network?: string;
  unitName?: string;
  pinned?: boolean;
}

interface CapFacTooltipProps {
  data: TooltipData | null;
}

export function getTooltipFormattedDate(data: TooltipData): string {
  switch (data.tooltipType) {
    case 'day':
      return `${data.startDate.day} ${getMonthName(data.startDate)} ${data.startDate.year}`;
    
    case 'month':
      return `${getMonthName(data.startDate)} ${data.startDate.year}`;
    
    case 'period': {
      if (!data.endDate) {
        throw new Error('endDate is required for period tooltip type');
      }
      
      // Show date range
      const startDay = data.startDate.day;
      const startMonth = getMonthName(data.startDate);
      const startYear = data.startDate.year;
      const endDay = data.endDate.day;
      const endMonth = getMonthName(data.endDate);
      const endYear = data.endDate.year;
      
      if (startYear === endYear && startMonth === endMonth) {
        return `${startDay}–${endDay} ${startMonth} ${startYear}`;
      } else if (startYear === endYear) {
        return `${startDay} ${startMonth} – ${endDay} ${endMonth} ${startYear}`;
      } else {
        return `${startDay} ${startMonth} ${startYear} – ${endDay} ${endMonth} ${endYear}`;
      }
    }
  }
}

export function CapFacTooltip({ data }: CapFacTooltipProps) {
  if (!data) {
    return <div className="hover-date-value" style={{ visibility: 'hidden' }}></div>;
  }

  const formattedDate = getTooltipFormattedDate(data);

  const getCapacityValue = (capacityFactor: number | null) => {
    if (capacityFactor === null) return '—';
    return `${capacityFactor.toFixed(1)}%`;
  };

  return (
    <div className="hover-date-value">
      <span className="hover-date">
        <time>{formattedDate}</time>
      </span>
      <span className="hover-values">
        <span className="tooltip-icon" style={{ backgroundColor: '#333' }}></span>
        {data.label} <strong>{getCapacityValue(data.capacityFactor)}</strong>
      </span>
    </div>
  );
}