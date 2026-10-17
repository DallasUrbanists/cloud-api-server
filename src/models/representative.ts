/**
 * Public representative directory records linked to shared jurisdiction boundaries.
 *
 * Let's imagine wanting to tell your council member about a park. A representative
 * record is like a contact card showing who serves your area and how to reach them.
 *
 * @remarks Boundary and term validity are separate; research scheduling lives in the sync service.
 * @module
 */

/** One election's calendar dates, including early voting and its source-provided status. */
export interface RepresentativeElection {
  label: string;
  date: string;
  early_vote_start: string;
  early_vote_end: string;
  status: string;
}

import type { Boundary, ServiceDescriptor, BoundarySearch } from './boundary.js';

/**
 * A person/office record with nested jurisdiction and independently retained tenure history.
 *
 * Let's imagine a community address book: each entry connects a public official
 * to the area they serve, so neighbors can find the right person to contact.
 */
export interface Representative {
  id: number;
  boundaryId: number;
  boundary: Boundary;
  researchService: ServiceDescriptor | null;
  lastResearchSync: string | null;
  researchSyncTTL: number;
  title: string | null;
  name: string | null;
  bio: string | null;
  webpage_url: string | null;
  photo_url: string | null;
  emails: unknown;
  phones: unknown;
  social_accounts: unknown;
  elections: RepresentativeElection[] | null;
  start: string | null;
  end: string | null;
}

/** Response alias preserving the service's public representative shape. */
export type RepresentativeResponse = Representative;

/** Combined office, geography, tenure, and election-period filters after request parsing. */
export interface RepresentativeSearch extends BoundarySearch {
  title?: string;
  boundaryId?: number;
  boundaryIds?: number[];
  servingAsOf?: string;
  electionAsOf?: string;
}
