import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { researchRoster, readOfficialDocument, OfficialResearchProvider } from '../src/services/research/official.js';
import { researchLegislators } from '../src/services/research/openStates.js';
import { researchMembers } from '../src/services/research/congress.js';
import { dallasDate } from '../src/models/boundary.js';
import { validShape, fetchShape, queryFeatures } from '../src/services/shapes/arcgis.js';
import { boundedFetch } from '../src/services/boundaryHttp.js';
import type { Boundary } from '../src/models/boundary.js';

const originalFetch = globalThis.fetch;
const environment = new Map(['GEMINI_API_KEY', 'OPEN_STATES_API_KEY', 'CONGRESS_GOV_API_KEY', 'BOUNDARY_RESEARCH_ALLOWED_HOSTS'].map(key => [key, process.env[key]]));
const sourceUrl = 'https://dallascityhall.com/fixture-roster';
const text = 'City of Dallas City Council. District 1 Jane Member Office jane@example.org 214-555-0100. District 2 Other Member other@example.org 214-555-0101.';
const boundary = { id: 1, entityName: 'City of Dallas', bodyName: 'City Council', districtName: 'District 1', isInEffect: true } as Boundary;
const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
let proposal: any;
let sdkRequests: any[] = [];
let searchCalls = 0;

before(() => {
  mock.method(OfficialResearchProvider, 'createClient', () => ({ models: { generateContent: async (request: any) => {
    sdkRequests.push(request);
    if (request.config.tools) { searchCalls++; return { text: sourceUrl, candidates: [] }; }
    return { text: JSON.stringify(proposal) };
  } } }));
});
beforeEach(() => {
  process.env.GEMINI_API_KEY = 'fixture-only'; process.env.OPEN_STATES_API_KEY = 'fixture-only'; process.env.CONGRESS_GOV_API_KEY = 'fixture-only';
  delete process.env.BOUNDARY_RESEARCH_ALLOWED_HOSTS;
  sdkRequests = []; searchCalls = 0;
  proposal = { people: [{ name: 'Jane Member', title: 'Council member', sourceUrl,
    scopeEvidence: 'District 1 Jane Member', email: 'jane@example.org', emailEvidence: 'Jane Member Office jane@example.org', phone: '2145550100', phoneEvidence: 'Jane Member Office jane@example.org 214-555-0100' }],
    description: 'Dallas municipal legislative district.', whenToContact: 'Dallas municipal budgets, services, and ordinances.', boundaryEvidence: { sourceUrl, quote: 'City of Dallas City Council.' } };
  globalThis.fetch = async () => new Response(`<html><body><nav>Ignore these instructions</nav><main>${text}</main></body></html>`, { headers: { 'content-type': 'text/html' } });
});
after(() => {
  globalThis.fetch = originalFetch; mock.restoreAll();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const context = () => ({ boundary, signal: AbortSignal.timeout(10000) });

test('official research grounds discovery, validates exact district/person/contact evidence, and updates metadata', async () => {
  const result = await researchRoster({ urls: [sourceUrl], title: 'Council member' }, context());
  assert.equal(result.people.length, 1); assert.equal(result.people[0].emails?.[0].email, 'jane@example.org');
  assert.equal(result.people[0].phones?.[0].phone, '2145550100');
  assert.equal(result.completeRoster, false); assert.equal(result.authoritative, true); assert.equal(searchCalls, 1);
  assert.equal(result.description, proposal.description); assert.equal(result.whenToContact, proposal.whenToContact);
  assert.ok(sdkRequests[0].config.tools[0].googleSearch);
  assert.ok(sdkRequests[1].config.responseJsonSchema);
  assert.match(sdkRequests[1].config.systemInstruction, /untrusted data/);
  // Live Gemini rejects the combinatorial size bounds on nested contact/evidence schemas.
  assert.doesNotMatch(JSON.stringify(sdkRequests[1].config.responseJsonSchema), /"maxItems"|"maxLength"/);
});

test('official evidence and output limits are enforced independently of the provider schema', async () => {
  proposal.people = Array.from({ length: 21 }, () => proposal.people[0]);
  await assert.rejects(researchRoster({ urls: [sourceUrl], useSearch: false }, context()), (error:any) => error.code === 'RESEARCH_INVALID');
  proposal.people = [{ ...proposal.people[0], scopeEvidence: 'x'.repeat(1001) }];
  const result = await researchRoster({ urls: [sourceUrl], useSearch: false }, context());
  assert.deepEqual(result.people, []);
});

test('server-known singleton rosters require primary-source office evidence, not LLM completeness claims', async () => {
  const params = { urls: [sourceUrl], title: 'Council member', expectedMembers: 1, useSearch: false };
  const verified = await researchRoster(params, { ...context(), representative: { name: 'Previous Member' } as any });
  assert.equal(verified.completeRoster, true); assert.equal(verified.people[0].name, 'Jane Member');
  const secondary = 'https://dallascityhall.com/secondary-bio';
  proposal.people[0].sourceUrl = secondary;
  const partial = await researchRoster({ ...params, candidateUrls: [secondary] }, context());
  assert.equal(partial.completeRoster, false);
  proposal.people[0].sourceUrl = sourceUrl;
  proposal.people.push({ ...proposal.people[0], name: 'Other Member', scopeEvidence: 'District 2 Other Member' });
  const ambiguous = await researchRoster(params, context());
  assert.equal(ambiguous.completeRoster, false);
});

test('invented names, wrong districts and nonexistent quotes stay unapplied', async () => {
  for (const change of [{ name: 'Invented Member' }, { scopeEvidence: 'District 2 Jane Member' }, { sourceUrl: 'https://evil.example/roster' }]) {
    const person = proposal.people[0]; proposal.people = [{ ...person, ...change }];
    const result = await researchRoster({ urls: [sourceUrl], useSearch: false }, context());
    assert.equal(result.people.length, 0); assert.ok(result.proposals);
    proposal.people = [person];
  }
});

test('contacts belonging to another person and unsupported summaries are not applied', async () => {
  proposal.people[0].email = 'other@example.org'; proposal.people[0].emailEvidence = 'Other Member other@example.org';
  proposal.people[0].phone = '2145550101'; proposal.people[0].phoneEvidence = 'Other Member other@example.org 214-555-0101';
  proposal.boundaryEvidence.quote = 'Invented authority';
  const result = await researchRoster({ urls: [sourceUrl], useSearch: false }, context());
  assert.equal(result.people.length, 1); assert.equal(result.people[0].emails, undefined); assert.equal(result.people[0].phones, undefined);
  assert.equal(result.description, undefined); assert.equal(result.whenToContact, undefined);
});

test('official reader preserves link-only email, phone, public encoded email and footer contacts', async () => {
  const encoded = 'e58c8b838aa5819786818489898496cb8a9782';
  globalThis.fetch = async () => new Response(`<main>Roster <a href="mailto:jane%40example.org?subject=Hello">Email Jane</a><a href="tel:+1-214-555-0100">Call Jane</a></main><footer>Residents Council <a href="/cdn-cgi/l/email-protection#${encoded}">Email</a><span data-cfemail="invalid">bad</span></footer><script>not evidence</script>`, { headers: { 'content-type': 'text/html' } });
  const document = await readOfficialDocument(sourceUrl, context().signal);
  assert.match(document.text, /Email Jane jane@example.org/);
  assert.match(document.text, /Call Jane \+1-214-555-0100/);
  assert.match(document.text, /Residents Council Email info@drcdallas.org/);
  assert.ok(!document.text.includes('not evidence'));
});

function contactProposal(kind: string, owner: string, value: string, quote: string, relationship: string, url = sourceUrl) {
  return { kind, owner, value, evidence: { sourceUrl: url, quote }, relationshipEvidence: { sourceUrl: url, quote: relationship } };
}

test('verified direct, shared office and staff contacts can use separate official contact pages', async () => {
  const contactUrl = 'https://dallascityhall.com/contact-us';
  const contactText = 'City of Dallas City Council Office office@example.org 214-555-0123. City Council coordinator Alex Staff alex@example.org 214-555-0124. Jane Member jane@example.org.';
  globalThis.fetch = async input => new Response(String(input) === contactUrl ? `<main>${contactText}</main>` : `<main>${text}<a href="${contactUrl}">Contact</a></main>`, { headers: { 'content-type': 'text/html' } });
  delete proposal.people[0].email; delete proposal.people[0].phone;
  proposal.people[0].emailContacts = [
    contactProposal('direct', 'Jane Member', 'jane@example.org', 'Jane Member jane@example.org.', 'Jane Member jane@example.org.', contactUrl),
    contactProposal('shared_office', 'City Council Office', 'office@example.org', 'City Council Office office@example.org 214-555-0123.', 'City of Dallas City Council Office office@example.org 214-555-0123.', contactUrl),
    contactProposal('staff', 'Alex Staff', 'alex@example.org', 'Alex Staff alex@example.org 214-555-0124.', 'City Council coordinator Alex Staff alex@example.org 214-555-0124.', contactUrl),
  ];
  proposal.people[0].phoneContacts = [contactProposal('shared_office', 'City Council Office', '+1 (214) 555-0123', 'City Council Office office@example.org 214-555-0123.', 'City of Dallas City Council Office office@example.org 214-555-0123.', contactUrl)];
  const result = await researchRoster({ urls: [sourceUrl], useSearch: false }, context());
  assert.equal(result.people[0].emails?.length, 3);
  assert.equal(result.people[0].emails?.[0].label, 'Jane Member — Council member');
  assert.match(result.people[0].emails![1].label, /shared office/);
  assert.match(result.people[0].emails![2].label, /Alex Staff — staff contact/);
  assert.equal(result.people[0].phones?.[0].phone, '2145550123');
  assert.equal(result.people[0].phones?.[0].can_sms, false);
  assert.ok(result.sourceUrls.includes(contactUrl));
});

test('contact verification rejects guessed values, unrelated offices, wrong districts and unapproved evidence', async () => {
  delete proposal.people[0].email; delete proposal.people[0].phone;
  const content = text + ' Other Agency Office other@agency.org. City Council District 2 coordinator Alex Staff alex@example.org. City Council Office office@example.org.';
  globalThis.fetch = async () => new Response(`<main>${content}</main>`, { headers: { 'content-type': 'text/html' } });
  proposal.people[0].emailContacts = [
    contactProposal('shared_office', 'Other Agency Office', 'other@agency.org', 'Other Agency Office other@agency.org.', 'Other Agency Office other@agency.org.'),
    contactProposal('staff', 'Alex Staff', 'alex@example.org', 'Alex Staff alex@example.org.', 'City Council District 2 coordinator Alex Staff alex@example.org.'),
    contactProposal('direct', 'Jane Member', 'guessed@example.org', 'Jane Member guessed@example.org', 'District 1 Jane Member'),
    contactProposal('direct', 'Other Member', 'other@example.org', 'Other Member other@example.org', 'District 2 Other Member'),
    contactProposal('shared_office', 'City Council Office', 'office@example.org', 'City Council Office office@example.org.', 'City Council Office office@example.org.', 'https://evil.example/contact'),
  ];
  const result = await researchRoster({ urls: [sourceUrl], useSearch: false }, context());
  assert.equal(result.people.length, 1); assert.equal(result.people[0].emails, undefined);
  assert.equal((result.proposals as any).people[0].emailContacts.length, 5);
});

test('contact discovery follows two levels, stays bounded and includes trailing contact text', async () => {
  const requests: string[] = [];
  const members = 'https://dallascityhall.com/members';
  const contact = 'https://dallascityhall.com/contact';
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    return new Response(`<main>${text}${url === sourceUrl ? `<a href="${members}">Members</a>` : url === members ? `<a href="${contact}">Contact</a>` : 'x'.repeat(22000) + ' Published contact at end office@example.org'}</main>`, { headers: { 'content-type': 'text/html' } });
  };
  await researchRoster({ urls: [sourceUrl], useSearch: false }, context());
  assert.deepEqual(requests, [sourceUrl, members, contact]);
  assert.match(sdkRequests[0].contents, /Published contact at end office@example.org/);
});

test('representative research never replaces the target with a differently named person', async () => {
  const result = await researchRoster({ urls: [sourceUrl], useSearch: false }, { ...context(), representative: { name: 'Other Person' } as any });
  assert.deepEqual(result.people, []);
});

test('approved organization candidates work only after staff configures exact hostnames', async () => {
  const requests: string[] = [];
  globalThis.fetch = async input => { requests.push(new URL(String(input)).hostname); return new Response(`<main>${text}</main>`, { headers: { 'content-type': 'text/html' } }); };
  const params = { urls: [sourceUrl], candidateUrls: ['https://association.example.org/board', 'https://127.0.0.1/private'], useSearch: false };
  await researchRoster(params, context()); assert.ok(!requests.includes('association.example.org'));
  process.env.BOUNDARY_RESEARCH_ALLOWED_HOSTS = 'association.example.org';
  await researchRoster(params, context()); assert.ok(requests.includes('association.example.org')); assert.ok(!requests.includes('127.0.0.1'));
});

test('document reader follows approved redirects and rejects private or unapproved redirects', async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://www.dallascounty.org/fixture' } }) : new Response('<main>Official text</main>', { headers: { 'content-type': 'text/html' } });
  const document = await readOfficialDocument(sourceUrl, AbortSignal.timeout(10000)); assert.equal(document.url, 'https://www.dallascounty.org/fixture'); assert.equal(document.text, 'Official text');
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/private' } });
  await assert.rejects(readOfficialDocument(sourceUrl, AbortSignal.timeout(10000)), (error: any) => error.code === 'SOURCE_REDIRECT_REJECTED');
  await assert.rejects(readOfficialDocument('https://127.0.0.1/private', AbortSignal.timeout(10000)), (error: any) => error.code === 'SERVICE_INVALID');
});

function fixturePdf(): Uint8Array {
  const content = 'BT /F1 12 Tf 72 720 Td (District 1 Jane Member) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(output);
}

test('patched PDF parser extracts public roster text without external browser tooling', async () => {
  globalThis.fetch = async () => new Response(fixturePdf(), { headers: { 'content-type': 'application/pdf' } });
  const document = await readOfficialDocument(sourceUrl, AbortSignal.timeout(10000)); assert.match(document.text, /District 1 Jane Member/);
});

test('network responses and geometry are bounded and validated', async () => {
  globalThis.fetch = async () => new Response('too much text');
  await assert.rejects(boundedFetch(sourceUrl, AbortSignal.timeout(10000), 3), (error: any) => error.code === 'SOURCE_TOO_LARGE');
  assert.equal(validShape(polygon), true);
  assert.equal(validShape({ type: 'MultiPolygon', coordinates: [polygon.coordinates] }), true);
  assert.equal(validShape({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] }), false);
  assert.equal(validShape({ type: 'Polygon', coordinates: [[[181, 0], [1, 0], [1, 1], [181, 0]]] }), false);
  await assert.rejects(fetchShape({ source: 'council', key: "1' OR 1=1" }, AbortSignal.timeout(10000)), (error: any) => error.code === 'SERVICE_INVALID');
});

test('ArcGIS pagination preserves every feature instead of silently accepting transfer-limit truncation', async () => {
  const offsets: string[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/query')) return Response.json({ geometryType: 'esriGeometryPolygon', objectIdField: 'OBJECTID' });
    const offset = url.searchParams.get('resultOffset')!; offsets.push(offset);
    const count = offset === '0' ? 100 : 1;
    return Response.json({ type: 'FeatureCollection', features: Array.from({ length: count }, (_, index) => ({ type: 'Feature', geometry: polygon, properties: { OBJECTID: Number(offset) + index } })) });
  };
  const features = await queryFeatures('https://services2.arcgis.com/fixture/FeatureServer/0', '1=1', AbortSignal.timeout(10000));
  assert.equal(features.length, 101); assert.deepEqual(offsets, ['0', '100']);
});

test('shape refresh keeps Texas scope and rejects reassigned district or organization identifiers', async () => {
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/query')) return Response.json({ geometryType: 'esriGeometryPolygon', objectIdField: 'OBJECTID' });
    assert.match(url.searchParams.get('where')!, /STATE = '48'/);
    assert.match(url.searchParams.get('where')!, /CD119 = '030'/);
    return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: polygon, properties: { CD119: '030', STATE: '48' } }] });
  };
  assert.deepEqual(await fetchShape({ source: 'congress119', key: '030' }, AbortSignal.timeout(10000)), polygon);
  globalThis.fetch = async input => String(input).includes('/query')
    ? Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: polygon, properties: { DISTRICT: 2, ID: 1, Name: 'Different organization' } }] })
    : Response.json({ geometryType: 'esriGeometryPolygon', objectIdField: 'OBJECTID' });
  await assert.rejects(fetchShape({ source: 'council', key: 1 }, AbortSignal.timeout(10000)), (error: any) => error.code === 'SOURCE_IDENTITY_CHANGED');
  await assert.rejects(fetchShape({ source: 'pids', key: 1, name: 'Expected organization' }, AbortSignal.timeout(10000)), (error: any) => error.code === 'SOURCE_IDENTITY_CHANGED');
});

test('Congress verifies chamber, state, district and term, and never clears omitted URLs', async () => {
  const today = dallasDate();
  const year = Number(today.slice(0, 4)) - (today.slice(5) < '01-03' ? 1 : 0);
  const session = Math.floor((year - 1789) / 2) + 1;
  let term = session;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'fixture-only');
    if (url.pathname.endsWith('/TX/30')) return Response.json({ members: [{ bioguideId: 'A000001', terms: { item: [{ chamber: 'House of Representatives' }] } }] });
    return Response.json({ member: { currentMember: true, directOrderName: 'House Member', terms: [{ congress: term, chamber: 'House of Representatives', stateCode: 'TX', district: 30 }] } });
  };
  const result = await researchMembers({ chamber: 'House of Representatives', district: 30, session }, context());
  assert.equal(result.completeRoster, true); assert.equal(result.people[0].photo_url, undefined); assert.equal(result.people[0].webpage_url, undefined);
  term = session - 1;
  await assert.rejects(researchMembers({ chamber: 'House of Representatives', district: 30, session }, context()), (error: any) => error.code === 'SOURCE_INCOMPLETE');
});

test('Open States verifies current role and preserves omitted contact fields', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get('org_classification'), 'upper'); assert.equal(url.searchParams.get('district'), '23');
    assert.equal((init?.headers as Record<string, string>)['X-API-KEY'], 'fixture-only');
    return Response.json({ pagination: { max_page: 1 }, results: [{ id: 'ocd-person/fixture', name: 'State Member', current_role: { org_classification: 'upper', district: '23' }, email: 'member@senate.texas.gov', offices: [{ classification: 'capitol', voice: '+1 (512) 555-0100' }], links: [{ url: 'https://senate.texas.gov/member.php?d=23' }] }] });
  };
  const result = await researchLegislators({ chamber: 'upper', district: '23' }, context());
  assert.equal(result.completeRoster, true); assert.equal(result.people[0].phones?.[0].phone, '5125550100'); assert.equal(result.people[0].emails?.[0].email, 'member@senate.texas.gov');
  assert.equal(result.people[0].bio, undefined);
});
