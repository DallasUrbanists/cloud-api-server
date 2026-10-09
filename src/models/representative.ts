export interface RepresentativeElection {
  label: string;
  date: string;
  early_vote_start: string;
  early_vote_end: string;
  status: string;
}

export interface Representative {
  id: number;
  entity: string | null;
  body: string | null;
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
  district: string | null;
  district_description: string | null;
  district_bounds: unknown;
}

export type RepresentativeResponse = Omit<Representative, 'district_bounds'>;

export interface RepresentativeSearch {
  entity?: string;
  body?: string;
  title?: string;
  district?: string;
  servingAsOf?: string;
  electionAsOf?: string;
  latitude?: number;
  longitude?: number;
}
