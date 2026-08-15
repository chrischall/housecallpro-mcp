/** Library surface: the client and its records, for consumers embedding this package. */
export { HousecallProClient, type EstimateResponse } from './client.js';
export {
  LinkRegistry,
  parseLink,
  RETRIEVAL_TOKEN_RE,
  API_ORIGIN,
  CLIENT_ORIGIN,
  SHORT_ORIGIN,
  type HousecallLink,
  type LinkKind,
  type ParsedLink,
} from './links.js';
export {
  summarizeEstimate,
  type EstimateSummary,
  type EstimateOptionSummary,
  type EstimateLineItem,
} from './normalize.js';
export { VERSION } from './version.js';
