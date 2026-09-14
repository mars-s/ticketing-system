import { registerOTel } from '@vercel/otel';

export function register() {
  // @vercel/otel skips itself on the edge runtime; this only runs in Node.
  registerOTel({
    serviceName: 'ticketing-web',
    traceExporter: 'otlp',
  });
}
