import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const required = ['cloudflare.account_id', 'cloudflare.api_token', 'worker.name', 'worker.domain', 'database.name', 'database.id', 'database.binding'];
const valueAt = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);

export function parseConfig(raw) {
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('LOG_SERVICE_CONFIG 必须是有效的 JSON。'); }
  for (const key of required) {
    const value = valueAt(config, key);
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
      throw new Error(`LOG_SERVICE_CONFIG 缺少有效字符串字段：${key}`);
    }
  }
  if (!/^[a-f\d]{32}$/i.test(config.cloudflare.account_id)) throw new Error('cloudflare.account_id 格式错误。');
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(config.database.id)) throw new Error('database.id 必须为 D1 UUID。');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.worker.name)) throw new Error('worker.name 格式错误。');
  if (!/^[\w-]{1,64}$/.test(config.database.name)) throw new Error('database.name 格式错误。');
  if (config.database.binding !== 'LOGS_DB') throw new Error('database.binding 必须为 LOGS_DB。');
  const hostname = config.worker.domain;
  if (hostname.length > 253 || !hostname.includes('.') || !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || hostname.endsWith('.workers.dev')) {
    throw new Error('worker.domain 必须为自定义域名，不含协议、端口或路径。');
  }
  return config;
}

// Register individual JSON strings before validation or subprocess diagnostics.
export function secretStrings(raw) {
  const values = [raw];
  const visit = (value) => {
    if (typeof value === 'string' && value) values.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  try { visit(JSON.parse(raw)); } catch { /* Invalid JSON is never echoed. */ }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function redact(text, secrets) {
  let result = String(text);
  for (const value of secrets) {
    result = result.split(value).join('[redacted]');
    result = result.split(encodeURIComponent(value)).join('[redacted]');
  }
  return result;
}

export async function preflight(config, fetchImpl = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.account_id}`;
  const get = async (resource, label) => {
    let response;
    try {
      response = await fetchImpl(`${base}${resource}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.cloudflare.api_token}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new Error(`${label}预检请求失败；请检查网络后重试。`); }
    if (!response.ok) throw new Error(`${label}预检失败（HTTP ${response.status}）；请确认资源已创建且 Token 有访问权限。`);
    let data;
    try { data = await response.json(); } catch { throw new Error(`${label}预检响应不是 JSON。`); }
    if (data.success !== true) throw new Error(`${label}预检未成功；请检查资源和 Token 权限。`);
    return data.result;
  };
  await get(`/workers/scripts/${encodeURIComponent(config.worker.name)}/settings`, 'Worker');
  const database = await get(`/d1/database/${config.database.id}`, 'D1');
  if (database?.uuid !== config.database.id || database?.name !== config.database.name) {
    throw new Error('D1 名称或 ID 不匹配；不会迁移或部署。');
  }
  const domains = await get(`/workers/domains?hostname=${encodeURIComponent(config.worker.domain)}`, '自定义域名');
  if (!Array.isArray(domains) || !domains.some((domain) => domain.hostname === config.worker.domain && domain.service === config.worker.name && domain.enabled === true && (!domain.environment || domain.environment === 'production'))) {
    throw new Error('自定义域名未启用或未关联到指定 Worker；请在 Cloudflare 面板完成绑定。');
  }
}

export async function smokeTest(config, fetchImpl = fetch) {
  const id = randomUUID();
  const request = async (url, init, label) => {
    let response;
    try { response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error(`${label}请求失败；代码可能已部署，请检查工作流后重试。`); }
    if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）。`);
    try { return await response.json(); } catch { throw new Error(`${label}响应无效。`); }
  };
  const inserted = await request(`https://${config.worker.domain}/v1/logs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, source: 'log-service-smoke', event: 'deployment_check', level: 'info', version: '1', message: 'Synthetic deployment verification', context: { synthetic: true } }),
  }, '日志写入验证');
  if (inserted.ok !== true || inserted.duplicate !== false) throw new Error('日志写入验证返回异常。');
  const queried = await request(`https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.account_id}/d1/database/${config.database.id}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.cloudflare.api_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT id FROM logs WHERE source = ? AND id = ?', params: ['log-service-smoke', id] }),
  }, '数据库回读验证');
  if (queried.success !== true || queried.result?.[0]?.success !== true || queried.result[0].results?.[0]?.id !== id) throw new Error('数据库未确认收到本次验证日志。');
}

export async function runWrangler(args, options) {
  try {
    const result = await execFileAsync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd: root, env: options.env, maxBuffer: 4 * 1024 * 1024, timeout: 5 * 60 * 1000,
    });
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    // execFile's default message includes argv. Report captured diagnostics only.
    throw new Error(`Wrangler 执行失败（${error.code ?? 'unknown'}）。\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  }
}

export async function deployLogService({ env = process.env, fetchImpl = fetch, run = runWrangler, log = console.log, mask = (value) => console.log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`), tempRoot = path.join(root, '.local/log-service-deploy') } = {}) {
  const raw = env.LOG_SERVICE_CONFIG;
  if (!raw?.trim()) {
    if (env.GITHUB_EVENT_NAME === 'push') {
      log('日志服务未部署：请设置 GitHub Actions Secret LOG_SERVICE_CONFIG 后手动运行工作流。');
      return { skipped: true };
    }
    throw new Error('缺少 GitHub Actions Secret LOG_SERVICE_CONFIG。');
  }
  const secrets = secretStrings(raw);
  if (env.GITHUB_ACTIONS === 'true') secrets.forEach(mask);
  const safeLog = (text) => log(redact(text, secrets));
  let directory;
  try {
    const config = parseConfig(raw);
    if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF !== 'refs/heads/main') throw new Error('日志服务仅允许 main 分支部署。');
    await preflight(config, fetchImpl);
    safeLog('现有 Worker、D1 和自定义域名预检通过。');
    await mkdir(tempRoot, { recursive: true });
    directory = await mkdtemp(path.join(tempRoot, 'update-'));
    const local = JSON.parse(await readFile(path.join(root, 'server/logs/wrangler.json'), 'utf8'));
    const { $schema, ...base } = local;
    const generated = {
      ...base, name: config.worker.name,
      main: path.join(root, 'src/server/logs-worker.js'),
      d1_databases: [{ binding: config.database.binding, database_name: config.database.name, database_id: config.database.id, migrations_dir: path.join(root, 'server/logs/migrations') }],
    };
    // route/routes deliberately absent: custom domains remain dashboard-managed.
    const configPath = path.join(directory, 'wrangler.json');
    await writeFile(configPath, JSON.stringify(generated, null, 2), { mode: 0o600 });
    const { LOG_SERVICE_CONFIG, ...childEnv } = env;
    Object.assign(childEnv, {
      CLOUDFLARE_ACCOUNT_ID: config.cloudflare.account_id,
      CLOUDFLARE_API_TOKEN: config.cloudflare.api_token,
      WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG_PATH: path.join(directory, 'wrangler.log'), CI: 'true',
    });
    safeLog(await run(['d1', 'migrations', 'apply', 'LOGS_DB', '--remote', '--config', configPath], { env: childEnv }));
    safeLog(await run(['deploy', '--config', configPath], { env: childEnv }));
    await smokeTest(config, fetchImpl);
    safeLog('数据库迁移、Worker 更新和线上写入回读验证成功。');
    return { skipped: false };
  } catch (error) {
    throw new Error(redact(error.message, secrets));
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = async (message) => {
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  };
  deployLogService().then(async ({ skipped }) => {
    await summary(skipped ? '日志服务部署已跳过：尚未设置 LOG_SERVICE_CONFIG。' : '日志服务更新成功，线上写入和数据库回读验证通过。');
  }).catch(async (error) => {
    console.error(error.message);
    process.exitCode = 1;
    await summary('日志服务部署或验证失败；请查看屏蔽后的步骤诊断。线上状态可能已更新。');
  });
}
