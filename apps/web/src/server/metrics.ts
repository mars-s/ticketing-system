import client from 'prom-client';

// Next.js dev/hot-reload re-evaluates this module repeatedly in the same process;
// guard against registering the default collectors (and crashing) more than once.
const globalForMetrics = globalThis as unknown as { __metricsRegistered?: boolean };

export const register = client.register;

if (!globalForMetrics.__metricsRegistered) {
  client.collectDefaultMetrics({ register });
  globalForMetrics.__metricsRegistered = true;
}
