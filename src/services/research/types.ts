import type { Boundary, ServiceDescriptor } from '../../models/boundary.js';
import type { Representative } from '../../models/representative.js';

export interface ResearchPerson {
  sourceKey: string;
  name: string;
  title: string;
  webpage_url?: string | null;
  photo_url?: string | null;
  bio?: string | null;
  emails?: Array<{ label: string; email: string; when_to_use: string }>;
  phones?: Array<{ label: string; phone: string; when_to_use: string; can_sms: boolean }>;
  start?: string;
  end?: string;
  researchService?: ServiceDescriptor;
}
export interface ResearchResult {
  people: ResearchPerson[];
  completeRoster: boolean;
  authoritative: boolean;
  sourceUrls: string[];
  description?: string;
  whenToContact?: string;
  proposals?: unknown;
}
export interface ResearchContext {
  boundary: Boundary;
  representative?: Representative;
  signal: AbortSignal;
}
