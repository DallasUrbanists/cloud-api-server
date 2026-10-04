import type { JsonObject } from 'swagger-ui-express';

const json = (schema: JsonObject) => ({'application/json':{schema}});
const group = {$ref:'#/components/schemas/OperationGroup'};
const retry = {name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:200},description:'Exact payload/key retries replay a receipt. Corrected input needs a new key; expired actions cannot be recreated using an old UUIDv7.'};
const id = {name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const errors = Object.fromEntries([400,401,403,404,409,410,413,428,500].map(status=>[status,{description:status===410?'Group, Undo, or retry horizon expired.':status===409?'State/revision/lineage/latest-action/manifest/idempotency conflict.':status===413?'100 mutations or 1 MiB canonical payload exceeded.':'Request error; see machine-readable error and message.',content:json({type:'object',properties:{error:{type:'string'},message:{type:'string'}}})}]));
const endpoint = (summary:string,description:string,parameters:any[],status:number,schema:any,request?:any) => ({tags:['Operations'],summary,description,parameters,security:[{ApiKeyAuth:[],BearerAuth:[]}],...(request?{requestBody:{required:true,content:json(request)}}:{}),responses:{[status]:{description:'Operation receipt or discovery metadata.',content:json(schema)},...errors}});
const scope = [{name:'source',in:'query',required:true,schema:{type:'string',example:'event-view'}},{name:'event_id',in:'query',schema:{type:'string',pattern:'^[1-9][0-9]*$'}}];
export const operationPaths: JsonObject = {
  '/api/operation-groups':{
    post:endpoint('Begin an immutable operation group','Required manifest, source, action_type, and timestamp-bearing UUIDv7 client_action_id. Open deadline is 24 hours; no live records change. Maximum 100 typed targets and 1 MiB cumulative canonical UTF-8 payload. Do not split one Save/Remove into separately committed groups.',[retry],201,group,{$ref:'#/components/schemas/BeginOperationGroup'}),
    get:endpoint('Discover account-bound committed history','Committed and undone actions from the last 30 days, newest stable commit_order first. Source filter prevents mixing application histories. Cursors are opaque, account/filter-bound, high-water stable, and expire in 24 hours. Metadata never contains private inverse snapshots. Undo availability is advisory; unknown permits attempting Undo, not a guarantee.',[...scope,{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:25}},{name:'cursor',in:'query',schema:{type:'string',format:'uuid'}}],200,{type:'object',properties:{items:{type:'array',items:group},next_cursor:{type:'string',nullable:true}}})
  },
  '/api/operation-groups/{id}':{
    get:endpoint('Recover a known group','Account-only state, staged count, open deadline, commit/undo expiry and advisory restrictions. Use history discovery when the group ID is lost.',[id],200,group),
    delete:endpoint('Cancel an open group','Discard staged commands without live writes. Expired open groups return GROUP_EXPIRED (410); already committed groups cannot be cancelled.',[id,retry],200,group)
  },
  '/api/operation-groups/{id}/commit':{
    post:endpoint('Atomically commit the complete manifest','Reject missing/unexpected/duplicate stages before live writes. Revalidate permissions, revisions, dependencies, timestamp bounds and constraints. History, lineage, exact preimages, and receipt become discoverable in the same transaction. Completed retries do not apply writes again.',[id,retry],200,group)
  },
  '/api/operation-groups/{id}/undo':{
    post:endpoint('Atomically undo a committed action','Account-bound, 30-day Undo with server-managed predecessor lineage. Ordinary edits (even edit-then-revert), identity reuse and conflicts reject the entire inverse. Undo advances revisions but never creates another user-undoable action. Ctrl-Z supplies latest group/order and history scope; stale or blocked latest actions never fall back to an older action. Exact completed retries replay before reevaluating latest status.',[id,retry],200,group,{type:'object',properties:{expected_latest_group_id:{type:'string',format:'uuid'},expected_latest_commit_order:{type:'string',pattern:'^[0-9]+$'},source:{type:'string'},event_id:{type:'string',nullable:true}},description:'Empty object for explicit group Undo. Ctrl-Z requires all expected_latest fields plus source; event_id optionally narrows the history scope.'})
  }
};
export const operationSchemas: JsonObject = {
  BeginOperationGroup:{type:'object',required:['client_action_id','source','action_type','manifest'],properties:{client_action_id:{type:'string',format:'uuid',description:'UUIDv7 with embedded millisecond issue time. At most five minutes in the future and less than 90 days old. Unique per account, immutable across retries.'},source:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$',example:'event-view'},action_type:{type:'string',enum:['save','remove','update','delete'],example:'save'},event_id:{type:'string',nullable:true,description:'Existing event ID; required for event-view.'},manifest:{type:'array',minItems:1,maxItems:100,items:{type:'object',required:['resource','record_id','action'],properties:{resource:{type:'string',enum:['contacts','checkins']},record_id:{oneOf:[{type:'string',pattern:'^[1-9][0-9]*$'},{type:'integer',minimum:1}]},action:{type:'string',enum:['PUT','DELETE']}}}}}},
  OperationGroup:{type:'object',properties:{group_id:{type:'string',format:'uuid'},client_action_id:{type:'string',format:'uuid'},source:{type:'string'},action_type:{type:'string'},event_id:{oneOf:[{type:'string'},{type:'integer'}],nullable:true},commit_order:{type:'string',nullable:true,description:'Stable per-account numeric order represented as a string; compare numerically, not lexicographically.'},status:{type:'string',enum:['open','committed','undone','cancelled']},affected_record_count:{type:'integer'},display_summary:{type:'string'},open_expires_at:{type:'string',format:'date-time'},committed_at:{type:'string',format:'date-time',nullable:true},undo_expires_at:{type:'string',format:'date-time',nullable:true},retry_expires_at:{type:'string',format:'date-time'},begin_retry_expires_at:{type:'string',format:'date-time'},payload_bytes:{type:'integer'},staged_count:{type:'integer'},undo_availability:{type:'string',enum:['eligible','blocked','unknown']},undo_restrictions:{type:'array',items:{type:'string'}},restored:{type:'boolean'}}},
  StagedMutation:{type:'object',properties:{group_id:{type:'string',format:'uuid'},operation_id:{type:'string',format:'uuid'},client_action_id:{type:'string',format:'uuid'},resource:{type:'string'},record_id:{type:'string'},action:{type:'string'},staged:{type:'boolean',enum:[true]}}}
};
export const stagingParameters = [
  {name:'X-Operation-Group',in:'header',schema:{type:'string',format:'uuid'},description:'Stage instead of immediately writing. A valid user token and owner/staff authority are mandatory, including for contacts.'},
  {...retry,required:false,description:'Required with X-Operation-Group. Exact retries add neither slots nor bytes.'},
  {name:'If-Match',in:'header',schema:{type:'string'},description:'Required with X-Operation-Group. Send the quoted ETag or revision from the current record read.'}
];
export const stagingResponses: JsonObject = {
  202:{description:'Manifest item staged durably; no live records changed.',content:json({$ref:'#/components/schemas/StagedMutation'})},
  ...Object.fromEntries([401,403,409,410,413,428].map(status=>[status,errors[status]]))
};
