export interface RepresentativeElection {
  label: string;
  date: string;
  early_vote_start: string;
  early_vote_end: string;
  status: string;
}

import type { Boundary, ServiceDescriptor, BoundarySearch } from './boundary.js';

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

export type RepresentativeResponse = Representative;

export interface RepresentativeSearch extends BoundarySearch {
  title?: string;
  boundaryId?: number;
  servingAsOf?: string;
  electionAsOf?: string;
}
