/** Library surface: the client and its records, for consumers embedding this package. */
export {
  HousecallProClient,
  type EstimateResponse,
  type InvoiceResponse,
} from './client.js';
export {
  LinkRegistry,
  parseLink,
  RETRIEVAL_TOKEN_RE,
  ESTIMATE_TOKEN_RE,
  INVOICE_TOKEN_RE,
  tokenShape,
  API_ORIGIN,
  CLIENT_ORIGIN,
  SHORT_ORIGIN,
  type HousecallLink,
  type LinkKind,
  type ParsedLink,
} from './links.js';
export {
  summarizeEstimate,
  summarizeInvoice,
  type EstimateSummary,
  type InvoiceSummary,
  type EstimateOptionSummary,
  type EstimateLineItem,
} from './normalize.js';
export { VERSION } from './version.js';
