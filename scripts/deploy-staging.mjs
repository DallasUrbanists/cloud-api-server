/** Staging-only source deployment. Report-only unless --apply; never receives secret values. */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const project = 'urbanists-mixer-slides-helper';
const service = 'urbanists-cloud-api-staging';
const region = 'us-central1';
const account = id => `${id}@${project}.iam.gserviceaccount.com`;

export function deploymentArgs(sha, env, existingService = true) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('A full tested commit SHA is required.');
  const settings = {
    '--cpu': 'STAGING_CPU', '--memory': 'STAGING_MEMORY', '--concurrency': 'STAGING_CONCURRENCY',
    '--min-instances': 'STAGING_MIN_INSTANCES', '--max-instances': 'STAGING_MAX_INSTANCES', '--ingress': 'STAGING_INGRESS',
  };
  const sizing = [];
  for (const [flag, key] of Object.entries(settings)) {
    if (!env[key]?.trim() || env[key].startsWith('-')) throw new Error(`Missing reviewed runtime setting: ${key}`);
    sizing.push(flag, env[key]);
  }
  if (!['true', 'false'].includes(env.STAGING_CPU_THROTTLING)) throw new Error('Set STAGING_CPU_THROTTLING from reviewed runtime metadata.');
  const values = {
    DEPLOY_ENV: 'staging', NODE_ENV: 'production', GOOGLE_CLOUD_PROJECT: project,
    PUBLIC_IMPROVEMENTS_DB: 'public-improvements-staging', ASSIST_QUOTA_DB: 'public-improvements-staging',
    SUGGESTION_PHOTOS_BUCKET: 'urbanists-suggestion-photos-staging-143738155808',
    DB_NAME: 'urbanists_staging', DB_USER: 'urbanists_staging',
    INSTANCE_CONNECTION_NAME: `${project}:us-south1:contacts-relationships-db`,
    ALLOWED_ORIGINS: 'https://map-staging-143738155808.web.app', BUILD_COMMIT: sha,
    BOUNDARY_SYNC_ENABLED: 'false', STREETMIX_ENABLED: 'false', PRESENTATION_ENABLED: 'false', PRESENTATION_WEBSOCKET_ENABLED: 'false',
  };
  return ['run', 'deploy', service, '--project', project, '--region', region, '--source', '.',
    '--service-account', account('api-staging-runtime'), '--build-service-account', `projects/${project}/serviceAccounts/${account('api-staging-build')}`,
    '--set-cloudsql-instances', values.INSTANCE_CONNECTION_NAME, '--timeout', '3600', '--allow-unauthenticated',
    '--set-env-vars', Object.entries(values).map(([key, value]) => `${key}=${value}`).join(','),
    '--set-secrets', 'API_KEYS_JSON=improvement-map-staging-api-keys:latest,DB_PASSWORD=urbanists-staging-db-password:latest',
    '--set-build-env-vars', 'GOOGLE_NODEJS_VERSION=24.x.x',
    ...(existingService ? ['--no-traffic'] : []), '--tag', 'candidate', ...sizing,
    env.STAGING_CPU_THROTTLING === 'true' ? '--cpu-throttling' : '--no-cpu-throttling', '--quiet'];
}

export function assertHealth(body, sha, revision) {
  if (body.status !== 'ok' || body.service !== 'urbanists-cloud-api-server' || body.environment !== 'staging'
    || body.buildCommit !== sha || body.revision !== revision
    || JSON.stringify(body.databases) !== JSON.stringify(['public-improvements-staging'])) {
    throw new Error('Staging health identity mismatch; inspect the recorded deployment and traffic.');
  }
}

export function validateManifest(paths, trackedPaths) {
  const tracked = new Set(trackedPaths);
  if (!paths.length || paths.some(path => !tracked.has(path)
    || !/^(src\/.*|package\.json|package-lock\.json|tsconfig\.json)$/.test(path)
    || /(^|\/)(\.env[^/]*|gha-creds-[^/]*|.*\.(pem|key))$/.test(path))) {
    throw new Error('Unexpected or untracked source upload entry.');
  }
}

const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const cloud = args => process.platform === 'win32'
  ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$cloudArgs = [Console]::In.ReadToEnd() | ConvertFrom-Json; & gcloud @cloudArgs; exit $LASTEXITCODE'], {
    input: JSON.stringify(args), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
  }).trim()
  : command('gcloud', args);
const scope = ['--project', project, '--region', region];

async function stillCurrent(sha) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/staging`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Could not verify current staging branch.');
    return (await response.json()).object.sha === sha;
  }
  return command('git', ['ls-remote', 'origin', 'refs/heads/staging']).split(/\s/)[0] === sha;
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; deployment target is fixed.');
  const sha = command('git', ['rev-parse', 'HEAD']);
  const args = deploymentArgs(sha, process.env);
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'report', project, service, region, sha, args }, null, 2));
  if (!process.argv.includes('--apply')) return;
  if (command('git', ['status', '--porcelain'])) throw new Error('Refusing dirty/untracked source deployment.');
  const branch = process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_REF : `refs/heads/${command('git', ['branch', '--show-current'])}`;
  if (branch !== 'refs/heads/staging' || (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_SHA !== sha)) throw new Error('Deploy only the tested staging commit.');
  if (!(await stillCurrent(sha))) { console.log('Superseded staging commit; skipped.'); return; }
  const manifest = cloud(['meta', 'list-files-for-upload']).split(/\r?\n/).map(path => path.replaceAll('\\', '/').replace(/^\.\//, ''));
  validateManifest(manifest, command('git', ['ls-files']).split(/\r?\n/));
  console.log(`Reviewed upload manifest: ${manifest.length} source files.`);
  const list = JSON.parse(cloud(['run', 'services', 'list', ...scope, '--filter', `metadata.name=${service}`, '--format=json(metadata.name,status.traffic)']));
  const previousTraffic = list[0]?.status?.traffic?.filter(entry => entry.percent > 0) ?? [];
  const rollbackRecord = JSON.stringify({ backendSha: sha, previousTraffic }, null, 2);
  console.log(`Before deployment / rollback record:\n${rollbackRecord}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nBefore staging deployment:\n\n\`\`\`json\n${rollbackRecord}\n\`\`\`\n`);
  if (!list.length) console.log('Initial staging bootstrap: Cloud Run assigns initial traffic before verification; no previous revision exists.');
  cloud(deploymentArgs(sha, process.env, list.length > 0));
  const result = JSON.parse(cloud(['run', 'services', 'describe', service, ...scope, '--format=json(status.url,status.latestReadyRevisionName,status.traffic)']));
  const revision = result.status.latestReadyRevisionName;
  const candidateRecord = JSON.stringify({ apiOrigin: result.status.url, candidateRevision: revision, backendSha: sha }, null, 2);
  console.log(`Candidate deployment (not yet verified):\n${candidateRecord}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nStaging candidate (not yet verified):\n\n\`\`\`json\n${candidateRecord}\n\`\`\`\n`);
  const candidate = result.status.traffic.find(entry => entry.tag === 'candidate' && entry.revisionName === revision)?.url;
  if (!candidate || !revision) throw new Error('Missing candidate revision URL; inspect recorded staging traffic.');
  const response = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Candidate health failed; inspect recorded staging traffic.');
  assertHealth(await response.json(), sha, revision);
  if (!(await stillCurrent(sha))) { console.log('Superseded before publication; candidate retained without traffic.'); return; }
  cloud(['run', 'services', 'update-traffic', service, ...scope, '--to-revisions', `${revision}=100`, '--quiet']);
  const live = await fetch(`${result.status.url}/api/health`, { signal: AbortSignal.timeout(30000) });
  if (!live.ok) throw new Error('Published health failed; use recorded previous traffic for rollback.');
  assertHealth(await live.json(), sha, revision);
  const receipt = { apiOrigin: result.status.url, revision, backendSha: sha, previousTraffic };
  console.log(JSON.stringify(receipt, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nStaging deployment receipt:\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => { console.error('Staging deployment failed; inspect the failed command and recorded traffic.'); process.exitCode = 1; });
