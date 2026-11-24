import { Fault } from '../warden/policy.mjs';
import { endpoint, fetchJson, uuid } from './common.mjs';
import { baseline, capped, invalid, target, version } from './lab.mjs';

const queries = Object.freeze({
  healthy: `ops_lab_config_healthy{job="${target}"}`,
  version: `ops_lab_config_version{job="${target}"}`,
});
const budgets = { [baseline]: 5, [capped]: 2, [invalid]: -1 };

function validConfig(data) {
  return typeof data?.instanceId === 'string' && uuid.test(data.instanceId) && version(data.version) &&
    Object.hasOwn(budgets, data.preset) && data.retryBudget === budgets[data.preset];
}

function configuration(data) {
  return { instanceId: data.instanceId, version: data.version, preset: data.preset, retryBudget: data.retryBudget };
}

export function matchesConfig(data, instanceId, atVersion, preset) {
  return data?.instanceId === instanceId && data.version === atVersion && data.preset === preset;
}

export function executorTools({ prometheusUrl, labUrl, labToken }) {
  const promBase = endpoint(prometheusUrl, 'OPS_PROMETHEUS_URL');
  const labBase = endpoint(labUrl, 'OPS_LAB_URL');
  const auth = { Authorization: `Bearer ${labToken}` };

  async function prometheus(queryName, query) {
    const url = new URL('api/v1/query', promBase);
    url.searchParams.set('query', query);
    const { status, data } = await fetchJson(url, { headers: { Accept: 'application/json' } });
    const samples = data?.data?.result;
    if (status !== 200 || data.status !== 'success' || data.data?.resultType !== 'vector' ||
        !Array.isArray(samples) || samples.length > 32) throw new Error('Invalid fixed query response');
    const result = samples.map(({ metric, value }) => {
      if (metric?.job !== target || typeof metric.instance !== 'string' || metric.instance.length > 256 ||
          !Array.isArray(value) || value.length !== 2 || !Number.isFinite(value[0]) ||
          typeof value[1] !== 'string' || value[1].length > 32 || !/^(?:0|[1-9]\d*)$/.test(value[1]) ||
          !Number.isSafeInteger(Number(value[1])) || (queryName === 'healthy' && Number(value[1]) > 1)) {
        throw new Error('Invalid fixed query sample');
      }
      return { metric: { job: metric.job, instance: metric.instance }, value };
    });
    return { source: 'prometheus', queryName, query, result, analysis: 'observed' };
  }

  async function readLab(path) {
    const { status, data } = await fetchJson(new URL(path.slice(1), labBase), { headers: auth });
    if (!validConfig(data)) throw new Error('Invalid lab configuration response');
    const response = configuration(data);
    if (path === '/health') {
      if (typeof data.healthy !== 'boolean' || data.check !== 'retry-budget' || status !== (data.healthy ? 200 : 503)) {
        throw new Error('Invalid lab health response');
      }
      Object.assign(response, { healthy: data.healthy, check: data.check });
    } else if (status !== 200) throw new Error('Lab configuration unavailable');
    return { source: 'lab', path, httpStatus: status, response, analysis: 'observed' };
  }

  return {
    async inspect() {
      const sources = [
        ...Object.entries(queries).map(([name, query]) => [{ source: 'prometheus', queryName: name, query }, prometheus(name, query)]),
        ...['/config', '/health'].map((path) => [{ source: 'lab', path }, readLab(path)]),
      ];
      const results = await Promise.allSettled(sources.map(([, read]) => read));
      return results.map((result, index) => result.status === 'fulfilled' ? result.value :
        { ...sources[index][0], error: 'Source unavailable or invalid', analysis: 'rule-based' });
    },
    async write(input, nextPreset) {
      const { status, data } = await fetchJson(new URL('config', labBase), {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      if (status === 409) throw new Fault(409, 'Lab CAS rejected the mutation');
      if (status !== 200 || !validConfig(data) || !matchesConfig(data, input.instanceId, input.expectedVersion + 1, nextPreset)) {
        throw new Error('Lab mutation result could not be confirmed');
      }
      return { source: 'lab', path: '/config', httpStatus: status, response: configuration(data), phase: input.phase, analysis: 'observed' };
    },
    async verify(instanceId, atVersion, preset, phase) {
      const paths = [['/health', `${phase}-health`], ['/config', `${phase}-readback`]];
      const results = await Promise.allSettled(paths.map(([path]) => readLab(path)));
      const evidence = results.map((result, index) => ({
        ...(result.status === 'fulfilled' ? result.value : { source: 'lab', path: paths[index][0], error: 'Source unavailable or invalid', analysis: 'rule-based' }),
        phase: paths[index][1],
      }));
      const healthy = evidence[0].response?.healthy === true && evidence[0].httpStatus === 200 &&
        evidence.every(({ response }) => matchesConfig(response, instanceId, atVersion, preset));
      return { healthy, collected: results.every(({ status }) => status === 'fulfilled'), evidence };
    },
  };
}
