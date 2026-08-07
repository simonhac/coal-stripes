import { createFileRoute } from '@tanstack/react-router';

// Placeholder. Phase 3 replaces this with the real visualisation from
// src/app/page.tsx, including ?fleet= as a typed search param.
export const Route = createFileRoute('/')({
  component: () => (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>coal-stripes on Cloudflare Workers</h1>
      <p>Scaffold is live. The visualisation lands in Phase 3.</p>
    </main>
  ),
});
