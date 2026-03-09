import { STATIONS } from '../src/stations.js';
export { STATIONS };
export const PRIORITY_STATIONS = STATIONS.filter(
  s => s.tags && (s.tags.includes('priority') || s.tags.includes('military'))
);
