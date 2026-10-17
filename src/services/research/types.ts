/**
 * Shared research-adapter evidence and roster contracts consumed by durable publication.
 *
 * Let's imagine a helper checking an official address book. These records carry
 * what the helper found and where it came from before anyone updates the directory.
 * @module
 */
import type { Boundary, ServiceDescriptor } from '../../models/boundary.js';
import type { Representative } from '../../models/representative.js';

/** A source-identified person; omitted optional fields preserve existing stored information on publication. */
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
/** Adapter result separating publishable people, source evidence, completeness, and unresolved proposals. */
export interface ResearchResult {
  people: ResearchPerson[];
  completeRoster: boolean;
  authoritative: boolean;
  sourceUrls: string[];
  description?: string;
  whenToContact?: string;
  proposals?: unknown;
}
/** Target scope and cancellation deadline supplied by the durable job executor. */
export interface ResearchContext {
  boundary: Boundary;
  representative?: Representative;
  signal: AbortSignal;
}
