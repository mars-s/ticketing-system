import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
  'http://otel-collector-opentelemetry-collector.monitoring.svc.cluster.local:4318';

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'ticketing-bot' }),
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
  ],
});
provider.register();

// BatchSpanProcessor holds completed spans for up to a few seconds before
// exporting; without this, SIGTERM/process.exit on a poll cycle boundary
// silently drops whatever's still queued. index.ts's shutdown handlers call this.
export function shutdownTracing(): Promise<void> {
  return provider.shutdown();
}

export const tracer = trace.getTracer('ticketing-bot');

// Wraps a poll-loop unit of work in a span so each sync cycle / poll run shows
// up as a traced operation, not just a log line.
export function traced<T>(spanName: string, fn: () => Promise<T>): () => Promise<T> {
  return () =>
    tracer.startActiveSpan(spanName, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error as Error);
        // recordException alone leaves span status UNSET -- error-rate
        // queries filtering on span status would silently undercount these.
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    });
}
