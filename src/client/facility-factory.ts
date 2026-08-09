import { GeneratingUnitDTO, Facility, GeneratingUnit } from '@/shared/types';

/**
 * Creates a Facility object from an array of GeneratingUnitDTO objects
 * that all belong to the same facility.
 * 
 * @param facilityCode - The facility code
 * @param dtoUnits - Array of GeneratingUnitDTO objects for this facility
 * @returns A Facility object with properly formatted unit names
 */
export function createFacility(facilityCode: string, dtoUnits: GeneratingUnitDTO[]): Facility {
  if (!dtoUnits || dtoUnits.length === 0) {
    throw new Error(`No units provided for facility ${facilityCode}`);
  }

  // Convert GeneratingUnitDTO[] to GeneratingUnit[]
  const generatingUnits: GeneratingUnit[] = dtoUnits.map(dto => ({
    unitId: dto.duid,
    unitName: dto.duid, // Keep original DUID as unitName - formatting will be done in CompositeTile
    capacity: dto.capacity,
    commenced: dto.commenced,
    lastSeen: dto.last_seen,
    status: dto.status,
    history: dto.history
  }));
  
  // Create Facility object
  const facility: Facility = {
    network: dtoUnits[0].network,
    region: dtoUnits[0].region,
    facilityCode: facilityCode,
    facilityName: dtoUnits[0].facility_name,
    units: generatingUnits
  };
  
  return facility;
}

/**
 * Groups an array of GeneratingUnitDTO objects by facility code
 * and creates a Map of Facility objects.
 * 
 * @param units - Array of all GeneratingUnitDTO objects
 * @returns Map of facility code to Facility object
 */
export function createFacilitiesFromUnits(units: GeneratingUnitDTO[]): Map<string, Facility> {
  // Group units by facility code
  const unitsByFacility = new Map<string, GeneratingUnitDTO[]>();
  
  for (const unit of units) {
    const facilityCode = unit.facility_code;
    if (!unitsByFacility.has(facilityCode)) {
      unitsByFacility.set(facilityCode, []);
    }
    unitsByFacility.get(facilityCode)!.push(unit);
  }
  
  // Create Facility objects
  const facilities = new Map<string, Facility>();
  
  for (const [facilityCode, dtoUnits] of unitsByFacility) {
    const facility = createFacility(facilityCode, dtoUnits);
    facilities.set(facilityCode, facility);
  }
  
  return facilities;
}