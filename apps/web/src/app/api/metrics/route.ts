import { register } from '@/server/metrics';

export async function GET() {
  const body = await register.metrics();
  return new Response(body, {
    headers: { 'content-type': register.contentType },
  });
}
