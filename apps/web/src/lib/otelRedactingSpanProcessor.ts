import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Context } from '@opentelemetry/api';

// Ticket-share links, Discord-link-claim, and directory-service calls carry
// bearer-equivalent tokens / emails / Discord usernames in the query string
// (see apps/web/src/app/t/[id]/{page,share/page}.tsx, link-discord/claim/page.tsx,
// lib/directoryService.ts). Next's built-in server spans and @vercel/otel's fetch
// instrumentation both record the *full* URL (including query string) on
// http.url/http.target and in the span name -- registered before this fix, that
// data would leave the process on every request. Strip query strings before any
// exporter sees them; running first in the spanProcessors chain (see
// instrumentation.ts) means every later processor -- including the OTLP exporter
// -- only ever sees the redacted values.
function stripQuery(url: string): string {
  const qIndex = url.indexOf('?');
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

const URL_ATTRIBUTE_KEYS = ['http.url', 'http.target', 'url.full', 'url.path'] as const;

function redact(span: ReadableSpan | Span): void {
  const attrs = span.attributes as Record<string, unknown>;
  for (const key of URL_ATTRIBUTE_KEYS) {
    const value = attrs[key];
    if (typeof value === 'string' && value.includes('?')) {
      attrs[key] = stripQuery(value);
    }
  }
}

export class RedactQueryStringSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    redact(span);
  }

  onEnd(span: ReadableSpan): void {
    redact(span);
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
