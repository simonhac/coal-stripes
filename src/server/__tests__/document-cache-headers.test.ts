/**
 * The SSR document's cache policy.
 *
 * Worth testing because every property here failed silently in production
 * exactly once: an unset `Cache-Control` was cached anyway and outlived its
 * build (docs/workers-behaviour-measured.md § Correction: cross_version_cache),
 * and `no-transform` would switch off Cloudflare's analytics injection without
 * changing a single visible header.
 */
import {
  DOCUMENT_CACHE_CONTROL,
  DOCUMENT_TAG,
  applyDocumentCacheHeaders,
} from '@/server/cache-headers';

function html(headers: Record<string, string> = {}): Response {
  return new Response('<!DOCTYPE html><html></html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

describe('applyDocumentCacheHeaders', () => {
  it('gives an unheadered document an explicit policy and a purgeable tag', () => {
    const response = applyDocumentCacheHeaders(html());

    expect(response.headers.get('Cache-Control')).toBe(DOCUMENT_CACHE_CONTROL);
    expect(response.headers.get('Cache-Tag')).toBe(DOCUMENT_TAG);
  });

  it('caches in the shared layer but never in the browser', () => {
    // The browser copy is the one layer no purge can reach.
    expect(DOCUMENT_CACHE_CONTROL).toMatch(/\bmax-age=0\b/);
    expect(DOCUMENT_CACHE_CONTROL).toMatch(/\bs-maxage=\d+\b/);
  });

  it('never emits no-transform, which would silently disable RUM injection', () => {
    const response = applyDocumentCacheHeaders(html());

    expect(response.headers.get('Cache-Control')).not.toContain('no-transform');
  });

  it('leaves a document that already stated its own policy alone', () => {
    const response = applyDocumentCacheHeaders(html({ 'Cache-Control': 'no-store' }));

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Cache-Tag')).toBeNull();
  });

  it('leaves non-HTML responses alone — /api sets its own headers', () => {
    const json = new Response('{}', {
      headers: { 'Content-Type': 'application/json' },
    });

    const response = applyDocumentCacheHeaders(json);

    expect(response).toBe(json);
    expect(response.headers.get('Cache-Tag')).toBeNull();
  });

  it('leaves a response with no Content-Type alone', () => {
    const bare = new Response(null, { status: 204 });

    expect(applyDocumentCacheHeaders(bare)).toBe(bare);
  });

  it('preserves status and existing headers', () => {
    const notFound = new Response('<!DOCTYPE html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html', 'X-Marker': 'kept' },
    });

    const response = applyDocumentCacheHeaders(notFound);

    expect(response.status).toBe(404);
    expect(response.headers.get('X-Marker')).toBe('kept');
  });

  it('passes a streamed body through without reading it', async () => {
    // The document is streamed; buffering it here would undo the TTFB work in
    // #27. Constructing the wrapper must not consume the stream.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<!DOCTYPE html>'));
        controller.close();
      },
    });
    const streamed = new Response(stream, {
      headers: { 'Content-Type': 'text/html' },
    });

    const response = applyDocumentCacheHeaders(streamed);

    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('<!DOCTYPE html>');
  });
});
