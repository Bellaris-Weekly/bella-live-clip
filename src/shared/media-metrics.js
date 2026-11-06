// Install at the transport boundary, below caches and retry loops. A transport
// with a fallback can expose its individual attempts through withMetrics.
const activeRequests = new WeakMap();
export function measureMediaRequest(api, metrics) {
  const transport = typeof api === 'function' ? api : api.request;
  const request = typeof api === 'function' ? api : (...args) => api.request(...args);
  if (!metrics) return request;
  if (transport.withMetrics) return transport.withMetrics(metrics);
  return async (...args) => {
    const finish = metrics.start('mediaRequest');
    const change = delta => {
      const active = (activeRequests.get(metrics) ?? 0) + delta;
      activeRequests.set(metrics, active);
      metrics.gauge('activeRequests', active);
    };
    change(1);
    try {
      const response = await request(...args);
      metrics.add('mediaRequestBytes', response.data.byteLength);
      return response;
    } finally {
      finish();
      change(-1);
    }
  };
}
