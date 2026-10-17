/**
 * Congress.gov current Texas delegation research with chamber, session, and roster-size checks.
 * Produces evidence-backed people for the sync publisher without writing directory records itself.
 * @module
 */
import { BoundaryError, dallasDate } from '../../models/boundary.js';
import { fetchJson } from '../boundaryHttp.js';
import type { ResearchContext, ResearchPerson, ResearchResult } from './types.js';

/**
 * Verifies current chamber membership through roster/detail calls before returning a complete scoped result.
 * @remarks Rejects incomplete pagination, unavailable configured sessions, and unexpected roster sizes.
 * Contact fields are populated only when the response supports the expected format.
 */
export async function researchMembers(params: Record<string, unknown>, context: ResearchContext): Promise<ResearchResult> {
  const key = process.env.CONGRESS_GOV_API_KEY?.trim();
  if (!key) throw new BoundaryError(503, 'PROVIDER_NOT_CONFIGURED', 'Congress.gov research is not configured.');
  const today = dallasDate();
  const year = Number(today.slice(0, 4)) - (today.slice(5) < '01-03' ? 1 : 0);
  const session = Math.floor((year - 1789) / 2) + 1;
  if (params.session !== undefined && params.session !== session) throw new BoundaryError(503, 'RESEARCH_PERIOD_UNAVAILABLE', 'The requested congressional term is not currently researchable with the live-member adapter.');
  const chamber = params.chamber;
  const district = params.district;
  if (chamber !== 'Senate' && chamber !== 'House of Representatives') throw new BoundaryError(503, 'SERVICE_INVALID', 'Congress research chamber is invalid.');
  if (chamber === 'House of Representatives' && !/^\d{1,2}$/.test(String(district))) throw new BoundaryError(503, 'SERVICE_INVALID', 'Congress research district is invalid.');
  const base = 'https://api.congress.gov/v3';
  const url = new URL(`${base}/member/TX${chamber === 'Senate' ? '' : `/${district}`}`);
  url.search = new URLSearchParams({ currentMember: 'true', limit: '250', format: 'json' }).toString();
  const headers = { 'X-Api-Key': key };
  const result = await fetchJson(url, context.signal, headers);
  if (!Array.isArray(result.members) || result.pagination?.next) throw new BoundaryError(502, 'SOURCE_INVALID', 'Congress roster is missing or incomplete.');
  const current = result.members.filter((member: any) => member.terms?.item?.some((term: any) =>
    term.chamber === chamber && (term.endYear == null || Number(term.endYear) >= new Date().getUTCFullYear())));
  const people: ResearchPerson[] = [];
  const sourceUrls: string[] = [url.toString()];
  for (const member of current) {
    if (!/^[A-Z]\d{6}$/.test(member.bioguideId)) throw new BoundaryError(502, 'SOURCE_INVALID', 'Congress returned an invalid member identifier.');
    const detailUrl = `${base}/member/${member.bioguideId}?format=json`;
    const detail = (await fetchJson(detailUrl, context.signal, headers)).member;
    if (detail?.currentMember !== true || typeof detail.directOrderName !== 'string' || !detail.directOrderName.trim()) continue;
    if (params.session !== undefined) {
      const terms = Array.isArray(detail.terms) ? detail.terms : detail.terms?.item;
      if (!Array.isArray(terms) || !terms.some((term: any) => Number(term.congress) === params.session && term.chamber === chamber
        && term.stateCode === 'TX' && (chamber === 'Senate' || Number(term.district) === Number(district)))) continue;
    }
    const digits = String(detail.addressInformation?.phoneNumber ?? '').replace(/\D/g, '');
    const phone = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    const person: ResearchPerson = {
      sourceKey: `congress:${member.bioguideId}`, name: detail.directOrderName,
      title: chamber === 'Senate' ? 'U.S. Senator' : 'U.S. Representative',
      researchService: { file: 'congress.js', function: 'researchMembers', params },
    };
    if (typeof detail.officialWebsiteUrl === 'string' && /^https?:\/\//.test(detail.officialWebsiteUrl)) person.webpage_url = detail.officialWebsiteUrl;
    const image = detail.depiction?.imageUrl ?? member.depiction?.imageUrl;
    if (typeof image === 'string' && /^https?:\/\//.test(image)) person.photo_url = image;
    if (phone.length === 10) person.phones = [{ label: 'Office', phone, when_to_use: 'Constituent inquiries', can_sms: false }];
    people.push(person);
    sourceUrls.push(detailUrl);
  }
  if (chamber === 'Senate' && people.length !== 2) throw new BoundaryError(502, 'SOURCE_INCOMPLETE', 'Texas Senate roster could not be verified as complete.');
  if (chamber === 'House of Representatives' && people.length !== 1) throw new BoundaryError(502, 'SOURCE_INCOMPLETE', 'A current member for the requested congressional term and district could not be verified.');
  return { people, sourceUrls, completeRoster: people.length > 0, authoritative: true };
}
