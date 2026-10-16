import { BoundaryError } from '../../models/boundary.js';
import { fetchJson } from '../boundaryHttp.js';
import type { ResearchContext, ResearchPerson, ResearchResult } from './types.js';

export async function researchLegislators(params: Record<string, unknown>, context: ResearchContext): Promise<ResearchResult> {
  const key = process.env.OPEN_STATES_API_KEY?.trim();
  if (!key) throw new BoundaryError(503, 'PROVIDER_NOT_CONFIGURED', 'Open States research is not configured.');
  const chamber = params.chamber;
  const district = String(params.district);
  if (!['upper', 'lower'].includes(String(chamber)) || !/^\d{1,3}$/.test(district)) throw new BoundaryError(503, 'SERVICE_INVALID', 'Open States research configuration is invalid.');
  const url = new URL('https://v3.openstates.org/people');
  url.search = new URLSearchParams({ jurisdiction: 'ocd-jurisdiction/country:us/state:tx/government', org_classification: String(chamber), district, per_page: '50' }).toString();
  const result = await fetchJson(url, context.signal, { 'X-API-KEY': key });
  if (!Array.isArray(result.results) || Number(result.pagination?.max_page ?? 1) > 1) throw new BoundaryError(502, 'SOURCE_INVALID', 'Open States returned an incomplete roster.');
  const people: ResearchPerson[] = [];
  for (const item of result.results) {
    const role = item.current_role;
    if (!role || role.org_classification !== chamber || Number(role.district) !== Number(district)) continue;
    if (typeof item.id !== 'string' || typeof item.name !== 'string') throw new BoundaryError(502, 'SOURCE_INVALID', 'Open States returned invalid person data.');
    const person: ResearchPerson = {
      sourceKey: `openstates:${item.id}`, name: item.name,
      title: chamber === 'upper' ? 'State Senator' : 'State Representative',
      researchService: { file: 'openStates.js', function: 'researchLegislators', params },
    };
    const links = Array.isArray(item.links) ? item.links : [];
    const official = links.find((link: any) => /^https:\/\/(?:senate|house)\.texas\.gov\//.test(link.url ?? ''));
    if (official) person.webpage_url = official.url;
    const contacts = Array.isArray(item.offices) ? item.offices : [];
    const emails = [...new Set([item.email, ...contacts.map((office: any) => office.email)].filter((email): email is string => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
    if (emails.length) person.emails = emails.map(email => ({ label: 'Office', email, when_to_use: 'Constituent inquiries' }));
    const phones = contacts.map((office: any) => {
      const digits = String(office.voice ?? '').replace(/\D/g, '');
      const phone = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      return { label: String(office.classification ?? 'Office'), phone, when_to_use: 'Constituent inquiries', can_sms: false };
    }).filter((phone: any) => phone.phone.length === 10);
    if (phones.length) person.phones = phones;
    people.push(person);
  }
  if (people.length !== 1) throw new BoundaryError(502, 'SOURCE_INCOMPLETE', 'A complete current legislative district roster could not be verified.');
  return { people, sourceUrls: [url.toString()], completeRoster: true, authoritative: true };
}
