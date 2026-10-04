import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';

export type Resource = 'contacts' | 'checkins';
type TrackedResource = Resource | 'events';
type Action = 'PUT' | 'DELETE';
export interface Actor { uid: string; staff: boolean; }
export interface QueryClient {
  query(text: string, values?: any[]): Promise<any>;
  release(): void;
}
export interface Database { connect(): Promise<QueryClient>; query(text: string, values?: any[]): Promise<any>; }
interface State { resource: TrackedResource; id: string; revision: string; incarnation: string; head: string; present: boolean; }
interface ManifestItem { resource: Resource; record_id: string; action: Action; }
const MAX_BYTES = 1_048_576;
const RETRY_DAYS = 90;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ['name','emails','phones','zip_home','zip_other','roles','firebase_uid'];

export class OperationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new OperationError(status, code, message); }
function plain(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'INVALID_INPUT','A JSON object is required.');
  return value as Record<string, any>;
}
export function recordId(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') fail(400,'INVALID_ID','A positive BIGINT record ID is required.');
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(400,'INVALID_ID','Unsafe numeric IDs must be sent as strings.');
  const text = String(value);
  if (!/^\d+$/.test(text) || BigInt(text) < 1n || BigInt(text) > 9223372036854775807n) fail(400,'INVALID_ID','A positive BIGINT record ID is required.');
  return BigInt(text).toString();
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: any): string { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function bytes(value: any): number { return Buffer.byteLength(canonical(value), 'utf8'); }
function key(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) fail(400,'IDEMPOTENCY_KEY_REQUIRED','A 1–200 character Idempotency-Key is required.');
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400,'INVALID_GROUP_ID','An operation group UUID is required.');
  return value.toLowerCase();
}
function actionId(value: unknown, now: number): string {
  const id = uuid(value);
  if (id[14] !== '7') fail(400,'INVALID_ACTION_ID','client_action_id must be a timestamp-bearing UUIDv7.');
  const timestamp = parseInt(id.replace(/-/g,'').slice(0,12),16);
  if (timestamp > now + 300_000) fail(400,'INVALID_ACTION_ID','The action identifier is more than five minutes in the future.');
  if (timestamp <= now - RETRY_DAYS * 86_400_000) fail(410,'RETRY_HORIZON_EXPIRED','The 90-day retry horizon has expired; use a new action ID for a new action.');
  return id;
}
export function revisionToken(state: Pick<State,'incarnation'|'revision'>): string { return `${state.incarnation}:${state.revision}`; }
function etag(value: unknown): string {
  if (typeof value !== 'string') fail(428,'REVISION_REQUIRED','If-Match is required when staging.');
  const token = value.replace(/^"|"$/g,'');
  if (!/^[0-9a-f-]{36}:\d+$/.test(token)) fail(400,'INVALID_REVISION','If-Match must contain the record revision token.');
  return token;
}
function normalizePhone(value: string): string {
  const trimmed = value.trim(); const digits = trimmed.replace(/\D/g,'');
  if (digits.length === 10) return `+1-${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+1-${digits.slice(1,4)}-${digits.slice(4,7)}-${digits.slice(7)}`;
  return digits.length > 11 && trimmed.startsWith('+') ? `+${digits}` : trimmed;
}
export function normalizeCommand(resource: Resource, action: Action, input: unknown, actor: Actor): Record<string, any> {
  if (action === 'DELETE') return {};
  const body = plain(input); const result: Record<string, any> = {};
  if (resource === 'contacts') {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(body,field)) continue;
      if ((field === 'roles' || field === 'firebase_uid') && !actor.staff) continue;
      const value = body[field];
      if (field === 'name') {
        if (typeof value !== 'string' || !value.trim()) fail(400,'INVALID_NAME','name must be a nonempty string.');
        result.name = value.trim().toUpperCase();
      } else if (['emails','phones','zip_other','roles'].includes(field)) {
        if (value === null || value === '') { result[field] = null; continue; }
        const list = typeof value === 'string' ? [value] : value;
        if (!Array.isArray(list) || list.some(v => typeof v !== 'string')) fail(400,'INVALID_FIELD',`${field} must be strings, an array of strings, or null.`);
        const cleaned = list.map(v => v.trim()).filter(Boolean).map(v => field === 'emails' ? v.toLowerCase() : field === 'phones' ? normalizePhone(v) : v);
        result[field] = cleaned.length ? cleaned : null;
      } else {
        if (value !== null && typeof value !== 'string') fail(400,'INVALID_FIELD',`${field} must be a string or null.`);
        result[field] = value === null ? null : value.trim() || null;
      }
    }
  } else {
    for (const field of ['contact_id','event_id','submitted_on']) {
      if (!Object.prototype.hasOwnProperty.call(body,field)) continue;
      const value = body[field];
      if (field === 'contact_id' && (value === null || value === '')) result[field] = null;
      else if (field !== 'submitted_on') result[field] = recordId(value);
      else {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400,'INVALID_TIMESTAMP','submitted_on must be an RFC 3339 timestamp with an explicit offset.');
        if (Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) fail(400,'INVALID_TIMESTAMP','submitted_on has an invalid time of day.');
        const datePart = value.slice(0,10); const [year,month,day] = datePart.split('-').map(Number);
        if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate()) fail(400,'INVALID_TIMESTAMP','submitted_on has an invalid calendar date.');
        result[field] = value;
      }
    }
  }
  if (!Object.keys(result).length) fail(400,'EMPTY_UPDATE','At least one writable field must be supplied.');
  return result;
}

export class OperationService {
  constructor(private db: Database = pool as unknown as Database) {}
  private async transaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Serialize against all tracked writers, including legacy and external writers.
      await client.query('LOCK TABLE events, contacts, checkins IN SHARE ROW EXCLUSIVE MODE');
      const value = await fn(client); await client.query('COMMIT'); return value;
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error instanceof OperationError) throw error;
      if (['23505','23503','23502','23514','40001','40P01'].includes(error.code)) fail(409,'RESTORATION_CONFLICT','A resource, relationship, or concurrent operation conflicts with this request.');
      if (['22007','22008','22009','22P02'].includes(error.code)) fail(400,'INVALID_INPUT','A supplied value is invalid.');
      throw error;
    } finally { client.release(); }
  }
  private async clock(client: QueryClient): Promise<number> {
    const r = await client.query('SELECT extract(epoch FROM clock_timestamp())::double precision * 1000 AS now');
    return Number(r.rows[0].now);
  }
  private async group(client: QueryClient, actor: Actor, id: string): Promise<any> {
    const r = await client.query('SELECT *, committed_at::text AS committed_at, undo_expires_at::text AS undo_expires_at, created_at::text AS created_at, open_expires_at::text AS open_expires_at, commit_order::text AS commit_order, event_id::text AS event_id FROM operation_groups WHERE id=$1 AND owner_uid=$2 FOR UPDATE',[uuid(id),actor.uid]);
    if (!r.rows[0]) fail(404,'GROUP_NOT_FOUND','Operation group not found.');
    return r.rows[0];
  }
  private async fresh(client: QueryClient, group: any): Promise<void> {
    if (Date.parse(group.created_at) <= await this.clock(client) - RETRY_DAYS * 86_400_000) fail(410,'RETRY_HORIZON_EXPIRED','The group retry horizon has expired.');
  }
  private async open(client: QueryClient, group: any): Promise<void> {
    if (group.state !== 'open') fail(409,'GROUP_NOT_OPEN','The group is not open; recover its completed state.');
    if (Date.parse(group.open_expires_at) <= await this.clock(client)) fail(410,'GROUP_EXPIRED','The open group expired; begin a new group.');
  }
  private async replay(client: QueryClient, actor: Actor, scope: string, retryKey: string, hash: string): Promise<any | undefined> {
    const r = await client.query('SELECT request_hash,receipt FROM operation_retries WHERE owner_uid=$1 AND scope=$2 AND key=$3',[actor.uid,scope,retryKey]);
    if (!r.rows.length) return undefined;
    if (r.rows[0].request_hash !== hash) fail(409,'IDEMPOTENCY_CONFLICT','This idempotency key was used for different input.');
    return r.rows[0].receipt;
  }
  private async remember(client: QueryClient, actor: Actor, scope: string, retryKey: string, hash: string, receipt: any): Promise<void> {
    await client.query('INSERT INTO operation_retries(owner_uid,scope,key,request_hash,receipt) VALUES($1,$2,$3,$4,$5)',[actor.uid,scope,retryKey,hash,JSON.stringify(receipt)]);
  }
  private async state(client: QueryClient, resource: TrackedResource, id: string): Promise<State> {
    const r = await client.query('SELECT resource,record_id::text AS id,revision::text AS revision,incarnation::text,head,present FROM resource_revisions WHERE resource=$1 AND record_id=$2',[resource,id]);
    if (!r.rows[0]) fail(404,'RECORD_NOT_FOUND','Record not found.');
    return r.rows[0];
  }
  private async snapshot(client: QueryClient, resource: TrackedResource, id: string): Promise<string | null> {
    const idColumns = resource === 'checkins' ? ", 'contact_id',t.contact_id::text,'event_id',t.event_id::text" : '';
    const r = await client.query(`SELECT (to_jsonb(t) || jsonb_build_object('id',t.id::text${idColumns}))::text AS snapshot FROM ${resource} t WHERE id=$1`,[id]);
    return r.rows[0]?.snapshot ?? null;
  }
  private async authorize(client: QueryClient, actor: Actor, resource: Resource, id: string, snapshot?: string | null): Promise<void> {
    if (!snapshot) snapshot = await this.snapshot(client,resource,id);
    if (!snapshot) fail(404,'RECORD_NOT_FOUND','Record not found.');
    if (actor.staff) return;
    const row = JSON.parse(snapshot);
    const uid = resource === 'contacts' ? row.firebase_uid : row.contact_id ? JSON.parse(await this.snapshot(client,'contacts',row.contact_id) || '{}').firebase_uid : null;
    if (!uid || uid !== actor.uid) fail(403,'RECORD_FORBIDDEN','You are not authorized to modify this record.');
  }
  private async dependencies(client: QueryClient, resource: Resource, id: string, command: any): Promise<State[]> {
    if (resource === 'contacts') return [];
    const row = JSON.parse(await this.snapshot(client,resource,id) || '{}');
    const pairs: Array<[TrackedResource,string]> = [];
    for (const value of [row.contact_id, command.contact_id]) if (value) pairs.push(['contacts',recordId(value)]);
    for (const value of [row.event_id, command.event_id]) if (value) pairs.push(['events',recordId(value)]);
    const unique = new Map(pairs.map(pair => [`${pair[0]}:${pair[1]}`,pair]));
    return Promise.all([...unique.values()].map(([r,i]) => this.state(client,r,i)));
  }
  private async validate(client: QueryClient, actor: Actor, resource: Resource, id: string, action: Action, command: any): Promise<void> {
    await this.authorize(client,actor,resource,id);
    if (resource !== 'checkins' || action === 'DELETE') return;
    const row = JSON.parse((await this.snapshot(client,resource,id))!);
    const contact = Object.prototype.hasOwnProperty.call(command,'contact_id') ? command.contact_id : row.contact_id;
    if (contact !== null) {
      const snapshot = await this.snapshot(client,'contacts',contact);
      if (!snapshot) fail(400,'INVALID_CONTACT','contact_id must reference a contact.');
      if (Object.prototype.hasOwnProperty.call(command,'contact_id') && !actor.staff && JSON.parse(snapshot).firebase_uid !== actor.uid) fail(403,'RECORD_FORBIDDEN','The new contact must belong to the caller.');
    }
    const eventId = command.event_id ?? row.event_id;
    if (!await this.snapshot(client,'events',eventId)) fail(400,'INVALID_EVENT','event_id must reference an event.');
    if ('submitted_on' in command || 'event_id' in command) {
      const timestamp = command.submitted_on ?? row.submitted_on;
      const bounds = await client.query(`SELECT start_at IS NOT NULL AND (end_at IS NULL OR end_at >= start_at) AND $2::timestamptz >= start_at - interval '2 hours' AND $2::timestamptz <= CASE WHEN end_at IS NULL THEN start_at + interval '4 hours' ELSE end_at + interval '1 hour' END AS valid FROM events WHERE id=$1`,[eventId,timestamp]);
      if (!bounds.rows[0]?.valid) fail(400,'TIMESTAMP_OUT_OF_BOUNDS','submitted_on must be within the event check-in time bounds.');
    }
    if (contact !== null) {
      const duplicate = await client.query('SELECT 1 FROM checkins WHERE contact_id=$1 AND event_id=$2 AND id<>$3',[contact,eventId,id]);
      if (duplicate.rows.length) fail(409,'DUPLICATE_CHECKIN','This contact is already checked in for this event.');
    }
  }
  private async apply(client: QueryClient, resource: Resource, id: string, action: Action, command: any): Promise<any> {
    if (action === 'DELETE') {
      if (resource === 'checkins') await client.query('DELETE FROM checkins WHERE id=$1',[id]);
      else await client.query("UPDATE contacts SET name='DELETED USER',emails=NULL,phones=NULL,zip_home=NULL,zip_other=NULL,roles=NULL,firebase_uid=NULL WHERE id=$1",[id]);
      return {message: `${resource === 'contacts' ? 'Contact' : 'Checkin'} with ID ${id} has been deleted successfully.`};
    }
    const entries = Object.entries(command);
    const result = await client.query(`UPDATE ${resource} SET ${entries.map(([field],i) => `${field}=$${i+1}`).join(',')} WHERE id=$${entries.length+1} RETURNING *`,[...entries.map(([,v]) => v),id]);
    return result.rows[0];
  }
  private async account(client: QueryClient, actor: Actor): Promise<void> {
    await client.query('INSERT INTO operation_accounts(owner_uid) VALUES($1) ON CONFLICT DO NOTHING',[actor.uid]);
    await client.query('SELECT owner_uid FROM operation_accounts WHERE owner_uid=$1 FOR UPDATE',[actor.uid]);
  }
  async begin(actor: Actor, input: unknown, retryKey: string): Promise<any> {
    const body = plain(input); retryKey = key(retryKey);
    return this.transaction(async client => {
      await this.account(client,actor);
      const clientActionId = actionId(body.client_action_id,await this.clock(client));
      if (typeof body.source !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(body.source)) fail(400,'INVALID_SOURCE','source must be a lowercase application/source marker.');
      if (!['save','remove','update','delete'].includes(body.action_type)) fail(400,'INVALID_ACTION_TYPE','action_type must be save, remove, update, or delete.');
      const eventId = body.event_id === null || body.event_id === undefined ? null : recordId(body.event_id);
      if (body.source === 'event-view' && !eventId) fail(400,'EVENT_REQUIRED','EventView history requires event_id.');
      if (!Array.isArray(body.manifest) || !body.manifest.length) fail(400,'MANIFEST_REQUIRED','A nonempty mutation manifest is required.');
      if (body.manifest.length > 100) fail(413,'GROUP_LIMIT_EXCEEDED','A group may contain at most 100 mutations; do not split one action into separate commits.');
      const manifest: ManifestItem[] = body.manifest.map((value: any) => {
        const item = plain(value);
        if (!['contacts','checkins'].includes(item.resource) || !['PUT','DELETE'].includes(item.action)) fail(400,'INVALID_MANIFEST','Manifest resources/actions must be contacts/checkins and PUT/DELETE.');
        return {resource:item.resource,record_id:recordId(item.record_id),action:item.action};
      }).sort((a,b) => `${a.resource}:${a.record_id}`.localeCompare(`${b.resource}:${b.record_id}`));
      if (new Set(manifest.map(item => `${item.resource}:${item.record_id}`)).size !== manifest.length) fail(409,'DUPLICATE_TARGET','A manifest may contain only one mutation per resource type and ID.');
      const metadata = {client_action_id:clientActionId,source:body.source,action_type:body.action_type,event_id:eventId,manifest};
      const size = bytes(metadata); if (size > MAX_BYTES) fail(413,'GROUP_LIMIT_EXCEEDED','The group canonical payload exceeds 1 MiB.');
      const hash = digest(metadata); const scope = 'begin';
      const replay = await this.replay(client,actor,scope,retryKey,hash); if (replay) return replay;
      const existing = await client.query('SELECT id,begin_hash FROM operation_groups WHERE owner_uid=$1 AND client_action_id=$2',[actor.uid,clientActionId]);
      if (existing.rows.length) {
        if (existing.rows[0].begin_hash !== hash) fail(409,'ACTION_ID_CONFLICT','The client action identifier is already bound to different input.');
        const receipt = this.publicGroup(await this.group(client,actor,existing.rows[0].id));
        await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt;
      }
      if (eventId && !await this.snapshot(client,'events',eventId)) fail(400,'INVALID_EVENT','The history event must exist.');
            const id = crypto.randomUUID();
            const beginRetryExpiry = new Date(parseInt(clientActionId.replace(/-/g,'').slice(0,12),16) + RETRY_DAYS * 86_400_000).toISOString();
      await client.query('INSERT INTO operation_groups(id,owner_uid,client_action_id,source,action_type,event_id,manifest,begin_hash,payload_bytes,begin_retry_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,actor.uid,clientActionId,body.source,body.action_type,eventId,JSON.stringify(manifest),hash,size,beginRetryExpiry]);
      const receipt = this.publicGroup(await this.group(client,actor,id));
      await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt;
    });
  }
  private publicGroup(group: any): any {
    return {group_id:group.id,client_action_id:group.client_action_id,source:group.source,action_type:group.action_type,event_id:group.event_id === null ? null : String(group.event_id),status:group.state,open_expires_at:group.open_expires_at,committed_at:group.committed_at,undo_expires_at:group.undo_expires_at,commit_order:group.commit_order,affected_record_count:group.manifest.length,display_summary:`${group.action_type}: ${group.manifest.length} record(s)`,payload_bytes:group.payload_bytes,retry_expires_at:new Date(new Date(group.created_at).getTime() + RETRY_DAYS * 86_400_000).toISOString(),begin_retry_expires_at:new Date(parseInt(group.client_action_id.replace(/-/g,'').slice(0,12),16) + RETRY_DAYS * 86_400_000).toISOString(),undo_availability:group.state === 'committed' ? 'unknown' : 'blocked',undo_restrictions:group.state === 'undone' ? ['ALREADY_UNDONE'] : []};
  }
  async mutate(actor: Actor, resource: Resource, idValue: unknown, action: Action, body: unknown, grouped?: {id:string;match:unknown;key:string}): Promise<any> {
    const id = recordId(idValue); const command = normalizeCommand(resource,action,body,actor);
    return this.transaction(async client => {
      if (!grouped) { await this.validate(client,actor,resource,id,action,command); return this.apply(client,resource,id,action,command); }
      const group = await this.group(client,actor,grouped.id); await this.fresh(client,group);
      const retryKey = key(grouped.key); const expectedToken = etag(grouped.match);
      const scope = `stage:${group.id}:${resource}:${id}`; const hash = digest({resource,id,action,command,expectedToken});
      const replay = await this.replay(client,actor,scope,retryKey,hash); if (replay) return replay;
      await this.open(client,group);
      if (!group.manifest.some((item:ManifestItem) => item.resource === resource && item.record_id === id && item.action === action)) fail(409,'OUTSIDE_MANIFEST','The resource, record ID, or action is not in the immutable manifest.');
      const duplicate = await client.query('SELECT 1 FROM operation_items WHERE group_id=$1 AND resource=$2 AND record_id=$3',[group.id,resource,id]);
      if (duplicate.rows.length) fail(409,'DUPLICATE_TARGET','This target is already staged. Retry using the original key and payload.');
      const size = bytes({resource,record_id:id,action,command});
      if (group.payload_bytes + size > MAX_BYTES) fail(413,'GROUP_LIMIT_EXCEEDED','The group canonical payload exceeds 1 MiB; no live records changed.');
      await this.validate(client,actor,resource,id,action,command);
      const target = await this.state(client,resource,id);
      if (revisionToken(target) !== expectedToken) fail(409,'REVISION_CONFLICT','The record changed; refresh its revision.');
      const expected = {target,dependencies:await this.dependencies(client,resource,id,command),authority:actor.staff ? 'staff' : 'owner'};
      const operationId = crypto.randomUUID();
      await client.query('INSERT INTO operation_items(id,group_id,resource,record_id,action,command,expected) VALUES($1,$2,$3,$4,$5,$6,$7)',[operationId,group.id,resource,id,action,JSON.stringify(command),JSON.stringify(expected)]);
      await client.query('UPDATE operation_groups SET payload_bytes=payload_bytes+$2 WHERE id=$1',[group.id,size]);
      const receipt = {group_id:group.id,operation_id:operationId,staged:true,resource,record_id:id,action,client_action_id:group.client_action_id};
      await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt;
    });
  }
  private async sameRevision(client: QueryClient, expected: State): Promise<void> {
    const actual = await this.state(client,expected.resource,expected.id);
    if (revisionToken(actual) !== revisionToken(expected) || actual.present !== expected.present) fail(409,'REVISION_CONFLICT','A staged resource or dependency has changed.');
  }
  private async items(client: QueryClient, id: string): Promise<any[]> {
    return (await client.query('SELECT *,record_id::text AS record_id,preimage::text AS preimage FROM operation_items WHERE group_id=$1 ORDER BY operation_items.resource,operation_items.record_id',[id])).rows;
  }
  private complete(group: any, items: any[]): void {
    const intended = new Set(group.manifest.map((i:ManifestItem) => `${i.resource}:${i.record_id}:${i.action}`));
    const actual = new Set(items.map(i => `${i.resource}:${i.record_id}:${i.action}`));
    if (!items.length || items.length !== group.manifest.length || actual.size !== items.length || intended.size !== group.manifest.length || [...actual].some(i => !intended.has(i))) fail(409,'MANIFEST_INCOMPLETE','Successfully staged mutations must match the manifest exactly; stage the missing items before retrying commit.');
  }
  private async classify(client: QueryClient, state: State, kind: 'commit'|'undo', groupId: string, head: string, incarnation: string): Promise<State> {
    await client.query('UPDATE resource_revisions SET head=$3,incarnation=$4 WHERE resource=$1 AND record_id=$2',[state.resource,state.id,head,incarnation]);
    await client.query('UPDATE resource_transitions SET kind=$4,group_id=$5 WHERE resource=$1 AND record_id=$2 AND revision=$3',[state.resource,state.id,state.revision,kind,groupId]);
    return {...state,head,incarnation};
  }
  async commit(actor: Actor, id: string, retryKey: string): Promise<any> {
    retryKey = key(retryKey);
    return this.transaction(async client => {
      await this.account(client,actor); const group = await this.group(client,actor,id); await this.fresh(client,group);
      const scope = `commit:${group.id}`; const hash = digest({id:group.id});
      const replay = await this.replay(client,actor,scope,retryKey,hash); if (replay) return replay;
      if (['committed','undone'].includes(group.state)) { const receipt = this.publicGroup(group); await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt; }
      await this.open(client,group); const items = await this.items(client,group.id); this.complete(group,items);
            if (items.length > 100 || group.payload_bytes > MAX_BYTES) fail(413,'GROUP_LIMIT_EXCEEDED','The group exceeds the mutation or payload limit.');
            for (const item of items) {
        if (item.expected.authority === 'staff' && !actor.staff) fail(403,'PERMISSION_REVOKED','Staff permission is required for this operation.');
        await this.sameRevision(client,item.expected.target);
        for (const dependency of item.expected.dependencies) await this.sameRevision(client,dependency);
        await this.validate(client,actor,item.resource,item.record_id,item.action,item.command);
        item.preimage = await this.snapshot(client,item.resource,item.record_id);
        item.predecessors = {target:await this.state(client,item.resource,item.record_id),dependencies:await this.dependencies(client,item.resource,item.record_id,item.command)};
      }
      // Contacts first; check-in commands use already validated preimages and final constraints.
      for (const item of items) await this.apply(client,item.resource,item.record_id,item.action,item.command);
      for (const item of items) {
        const state = await this.state(client,item.resource,item.record_id);
        item.post_state = {target:await this.classify(client,state,'commit',group.id,`operation:${item.id}`,item.predecessors.target.incarnation),dependencies:[] as State[]};
      }
      for (const item of items) {
        for (const dependency of item.predecessors.dependencies) item.post_state.dependencies.push(await this.state(client,dependency.resource,dependency.id));
        await client.query('UPDATE operation_items SET preimage=$2,predecessors=$3,post_state=$4 WHERE id=$1',[item.id,item.preimage,JSON.stringify(item.predecessors),JSON.stringify(item.post_state)]);
      }
      const order = await client.query('UPDATE operation_accounts SET next_order=next_order+1 WHERE owner_uid=$1 RETURNING next_order::text',[actor.uid]);
      await client.query("UPDATE operation_groups SET state='committed',committed_at=clock_timestamp(),undo_expires_at=clock_timestamp()+interval '30 days',commit_order=$2 WHERE id=$1",[group.id,order.rows[0].next_order]);
      const receipt = this.publicGroup(await this.group(client,actor,group.id));
      await client.query('UPDATE operation_groups SET receipt=$2 WHERE id=$1',[group.id,JSON.stringify(receipt)]);
      await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt;
    });
  }
  private async lineage(client: QueryClient, expected: State): Promise<void> {
    const current = await this.state(client,expected.resource,expected.id);
    if (current.incarnation !== expected.incarnation || current.head !== expected.head || current.present !== expected.present || BigInt(current.revision) < BigInt(expected.revision)) fail(409,'UNDO_CONFLICT','A resource or dependency no longer has the required undo lineage.');
    if (current.revision === expected.revision) return;
    const transitions = await client.query("SELECT count(*)::text AS count, bool_or(kind='ordinary') AS barrier FROM resource_transitions WHERE resource=$1 AND record_id=$2 AND revision>$3 AND revision<=$4",[expected.resource,expected.id,expected.revision,current.revision]);
    if (transitions.rows[0].barrier || BigInt(transitions.rows[0].count) !== BigInt(current.revision)-BigInt(expected.revision)) fail(409,'UNDO_CONFLICT','An ordinary edit or missing lineage proof blocks Undo.');
  }
  private async restore(client: QueryClient, resource: Resource, id: string, snapshot: string): Promise<void> {
    const columns = (await client.query('SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=\'\' ORDER BY attnum',[resource])).rows.map((row:any) => row.attname as string);
    const quote = (column:string) => `"${column.replace(/"/g,'""')}"`;
    if (await this.snapshot(client,resource,id)) {
      const writable = columns.filter((column:string) => column !== 'id');
      await client.query(`UPDATE ${resource} t SET ${writable.map((column:string) => `${quote(column)}=s.${quote(column)}`).join(',')} FROM jsonb_populate_record(NULL::${resource},$1::jsonb) s WHERE t.id=$2`,[snapshot,id]);
    } else {
      await client.query(`INSERT INTO ${resource} (${columns.map(quote).join(',')}) OVERRIDING SYSTEM VALUE SELECT ${columns.map(quote).join(',')} FROM jsonb_populate_record(NULL::${resource},$1::jsonb)`,[snapshot]);
    }
  }
  async undo(actor: Actor, id: string, retryKey: string, input: unknown = {}): Promise<any> {
    retryKey = key(retryKey); const body = plain(input);
    const latest = body.expected_latest_group_id === undefined ? null : {group_id:uuid(body.expected_latest_group_id),commit_order:String(body.expected_latest_commit_order),source:body.source,event_id:body.event_id === undefined || body.event_id === null ? null : recordId(body.event_id)};
    if (latest && (typeof latest.source !== 'string' || !/^\d+$/.test(latest.commit_order))) fail(400,'INVALID_LATEST_PRECONDITION','Latest-action Undo requires source, expected_latest_group_id and expected_latest_commit_order.');
    return this.transaction(async client => {
      await this.account(client,actor); const group = await this.group(client,actor,id); await this.fresh(client,group);
      const scope = `undo:${group.id}`; const hash = digest({id:group.id,latest});
      const replay = await this.replay(client,actor,scope,retryKey,hash); if (replay) return replay;
      if (group.state === 'undone') { const receipt = group.undo_receipt || {...this.publicGroup(group),restored:true}; await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt; }
      if (group.state !== 'committed') fail(409,'GROUP_NOT_COMMITTED','Only a committed operation can be undone.');
      if (Date.parse(group.undo_expires_at) <= await this.clock(client)) fail(410,'UNDO_EXPIRED','The 30-day Undo period has expired.');
      if (latest) {
        const candidate = await client.query("SELECT id,commit_order::text FROM operation_groups WHERE owner_uid=$1 AND source=$2 AND ($3::bigint IS NULL OR event_id=$3) AND state='committed' AND undo_expires_at>clock_timestamp() ORDER BY operation_groups.commit_order DESC LIMIT 1",[actor.uid,latest.source,latest.event_id]);
        if (candidate.rows[0]?.id !== group.id || group.id !== latest.group_id || candidate.rows[0]?.commit_order !== latest.commit_order) fail(409,'LATEST_ACTION_CHANGED','Refresh history; the selected action is no longer latest.');
      }
      const items = await this.items(client,group.id); this.complete(group,items);
      for (const item of items) {
        if (!item.preimage || !item.post_state || !item.predecessors) fail(409,'UNDO_HISTORY_UNAVAILABLE','Trusted Undo evidence is unavailable.');
        if (item.expected.authority === 'staff' && !actor.staff) fail(403,'PERMISSION_REVOKED','Staff permission is required for this inverse.');
        await this.lineage(client,item.post_state.target);
        for (const dependency of item.post_state.dependencies) await this.lineage(client,dependency);
        if (!actor.staff) {
          // Verified deleted/soft-deleted self ownership is proven by the trusted preimage.
          const original = JSON.parse(item.preimage);
          if (item.resource === 'contacts') {
            if (original.firebase_uid !== actor.uid) fail(403,'RECORD_FORBIDDEN','The original contact was not owned by this account.');
          } else {
            const contactItem = items.find(other => other.resource === 'contacts' && other.record_id === original.contact_id);
            const contact = contactItem?.preimage ?? (original.contact_id ? await this.snapshot(client,'contacts',original.contact_id) : null);
            if (!contact || JSON.parse(contact).firebase_uid !== actor.uid) fail(403,'RECORD_FORBIDDEN','The original check-in contact is not owned by this account.');
          }
        }
      }
      const transitions = [];
      // Restore contacts before check-ins so restored foreign keys exist.
      for (const item of items) {
        const before = await this.state(client,item.resource,item.record_id);
        await this.restore(client,item.resource,item.record_id,item.preimage);
        const restored = await this.state(client,item.resource,item.record_id);
        const after = await this.classify(client,restored,'undo',group.id,item.predecessors.target.head,item.predecessors.target.incarnation);
        transitions.push({resource:item.resource,record_id:item.record_id,before,after});
      }
      const receipt = {...this.publicGroup({...group,state:'undone'}),restored:true};
      await client.query("UPDATE operation_groups SET state='undone',undo_receipt=$2 WHERE id=$1",[group.id,JSON.stringify(receipt)]);
      await client.query('INSERT INTO operation_inverse_receipts(group_id,transitions) VALUES($1,$2)',[group.id,JSON.stringify(transitions)]);
      await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt;
    });
  }
  async cancel(actor: Actor, id: string, retryKey: string): Promise<any> {
    retryKey = key(retryKey);
    return this.transaction(async client => {
      const group = await this.group(client,actor,id); await this.fresh(client,group); const scope = `cancel:${group.id}`; const hash = digest({id:group.id});
      const replay = await this.replay(client,actor,scope,retryKey,hash); if (replay) return replay;
      if (group.state !== 'cancelled') { await this.open(client,group); await client.query("UPDATE operation_groups SET state='cancelled' WHERE id=$1",[group.id]); await client.query('DELETE FROM operation_items WHERE group_id=$1',[group.id]); }
      const receipt = this.publicGroup({...group,state:'cancelled'}); await this.remember(client,actor,scope,retryKey,hash,receipt); return receipt;
    });
  }
  async status(actor: Actor, id: string): Promise<any> {
    const result = await this.db.query('SELECT *,commit_order::text AS commit_order,event_id::text AS event_id FROM operation_groups WHERE id=$1 AND owner_uid=$2',[uuid(id),actor.uid]);
    if (!result.rows[0]) fail(404,'GROUP_NOT_FOUND','Operation group not found.');
    const group = result.rows[0];
    const count = await this.db.query('SELECT count(*)::integer AS count FROM operation_items WHERE group_id=$1',[group.id]);
    return {...this.publicGroup(group),...await this.availability(actor,group),staged_count:count.rows[0].count};
  }
      private async availability(actor: Actor, group: any): Promise<any> {
        if (group.state !== 'committed') return {undo_availability:'blocked',undo_restrictions:[group.state === 'undone' ? 'ALREADY_UNDONE' : 'NOT_COMMITTED']};
        const client = this.db as unknown as QueryClient;
        if (Date.parse(group.undo_expires_at) <= await this.clock(client)) return {undo_availability:'blocked',undo_restrictions:['UNDO_EXPIRED']};
        try {
          const items = (await client.query('SELECT expected,post_state FROM operation_items WHERE group_id=$1',[group.id])).rows;
          if (!items.length) return {undo_availability:'blocked',undo_restrictions:['UNDO_HISTORY_UNAVAILABLE']};
          for (const item of items) {
            if (item.expected.authority === 'staff' && !actor.staff) return {undo_availability:'blocked',undo_restrictions:['PERMISSION_REVOKED']};
            if (!item.post_state) return {undo_availability:'blocked',undo_restrictions:['UNDO_HISTORY_UNAVAILABLE']};
            await this.lineage(client,item.post_state.target);
            for (const dependency of item.post_state.dependencies) await this.lineage(client,dependency);
          }
          // Restoration constraints and current permissions are rechecked only under Undo locks.
          return {undo_availability:'unknown',undo_restrictions:[]};
        } catch(error) {
          if (error instanceof OperationError) return {undo_availability:'blocked',undo_restrictions:[error.code === 'RECORD_NOT_FOUND' ? 'DEPENDENCY_UNAVAILABLE' : error.code]};
          throw error;
        }
      }
      async history(actor: Actor, query: Record<string, any>): Promise<any> {
    if (typeof query.source !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(query.source)) fail(400,'INVALID_SOURCE','A history source filter is required.');
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400,'INVALID_LIMIT','limit must be between 1 and 100.');
    const event = query.event_id === undefined ? null : recordId(query.event_id);
    let high: string | null = null; let before: string | null = null;
    if (query.cursor !== undefined) {
          if (typeof query.cursor !== 'string' || !UUID.test(query.cursor)) fail(400,'INVALID_CURSOR','The history cursor is invalid.');
          const saved = await this.db.query('SELECT scope FROM operation_history_cursors WHERE id=$1 AND owner_uid=$2 AND expires_at>clock_timestamp()',[query.cursor,actor.uid]);
          const cursor = saved.rows[0]?.scope;
          if (!cursor || cursor.source !== query.source || cursor.event !== event) fail(400,'INVALID_CURSOR','The cursor expired or belongs to a different account/filter scope; restart pagination.');
          high = cursor.high; before = cursor.before;
    }
    const result = await this.db.query(`SELECT *,commit_order::text AS commit_order,event_id::text AS event_id FROM operation_groups WHERE owner_uid=$1 AND source=$2 AND ($3::bigint IS NULL OR event_id=$3) AND state IN ('committed','undone') AND undo_expires_at>clock_timestamp() AND ($4::bigint IS NULL OR commit_order<=$4) AND ($5::bigint IS NULL OR commit_order<$5) ORDER BY operation_groups.commit_order DESC LIMIT $6`,[actor.uid,query.source,event,high,before,limit+1]);
    const rows = result.rows; if (high === null) high = rows[0]?.commit_order ?? '0';
    const page = rows.slice(0,limit); const more = rows.length>limit;
    const cursor = more ? crypto.randomUUID() : null;
        if (cursor) await this.db.query('INSERT INTO operation_history_cursors(id,owner_uid,scope) VALUES($1,$2,$3)',[cursor,actor.uid,JSON.stringify({source:query.source,event,high,before:page[page.length-1].commit_order})]);
        return {items:await Promise.all(page.map(async (group:any) => ({...this.publicGroup(group),...await this.availability(actor,group)}))),next_cursor:cursor};
  }
}
export const operationService = new OperationService();
export function actorFromRequest(req: Request): Actor {
  if (!req.user) fail(401,'AUTHENTICATION_REQUIRED','A valid user token is required.');
  return {uid:req.user.uid,staff:req.user.roles.includes('staff')};
}
export function sendOperationError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof OperationError) { res.status(error.status).json({error:error.code,message:error.message}); return; }
  console.error('Operation request failed with an unexpected server error.');
    res.status(500).json({error:'INTERNAL_ERROR',message:'The operation could not be completed. Recover its status before retrying.'});
  }
  export function recordMutationHandler(resource: Resource) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const group = req.header('X-Operation-Group');
      const result = await operationService.mutate(actorFromRequest(req),resource,req.params.id,req.method as Action,req.body,group !== undefined ? {id:group,match:req.header('If-Match'),key:req.header('Idempotency-Key')!} : undefined);
            res.setHeader('Cache-Control','private, no-store');
            res.status(group !== undefined ? 202 : 200).json(result);
    } catch (error) { sendOperationError(error,res,next); }
  };
}
export async function getRecordRevision(resource: TrackedResource, id: unknown): Promise<string | null> {
  const result = await pool.query('SELECT incarnation::text,revision::text FROM resource_revisions WHERE resource=$1 AND record_id=$2',[resource,id]);
  return result.rows[0] ? revisionToken(result.rows[0]) : null;
}
