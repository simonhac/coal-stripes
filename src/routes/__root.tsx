/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { Providers } from '@/client/providers';
import {
  BOOT_FLAG,
  FRESH_PARAM,
  SELF_HEAL_GUARD,
  STALE_DOCUMENT_TRIPWIRE,
} from '@/client/stale-document-tripwire';
import { unitMetadataScript } from '@/client/unit-metadata-inline';
import appCss from '@/styles/app.css?url';

const TITLE = 'Coal Availability';
const DESCRIPTION = 'Australian coal power plant capacity factor visualisation';
const SOCIAL_DESCRIPTION =
  'Real-time visualisation of Australian coal power plant capacity factors';
const SITE = 'https://stripes.energy';

export const Route = createRootRoute({
  /**
   * Read the unit metadata so `head` can inline it — see
   * @/client/unit-metadata-inline for why it travels in the document rather than
   * over a second request.
   *
   * The `import.meta.env.SSR` guard is load-bearing twice over. A root loader
   * re-runs on the CLIENT for subsequent navigations (`/` → `/stats`), where
   * there is no R2 binding to read; returning null there emits no second script,
   * and none is needed, because the one the SSR document carried ran at parse
   * time and set the global for the life of the tab. `staleTime: Infinity` keeps
   * even that from being attempted on a whim.
   *
   * And the import is dynamic, *inside* the guard, so the browser bundle never
   * pulls in the store: `import.meta.env.SSR` is replaced with a literal `false`
   * in the client build, which makes this whole branch dead code and takes the
   * OpenElectricity client and the R2 binding out with it. A top-level import
   * would rely on tree-shaking to achieve the same thing, and quietly stop doing
   * so the day something in that graph gained a side effect.
   */
  loader: async () => {
    if (!import.meta.env.SSR) return null;
    const { readDocumentUnitMetadata } = await import('@/server/document-unit-metadata');
    return readDocumentUnitMetadata();
  },
  staleTime: Infinity,
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },

      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: SOCIAL_DESCRIPTION },
      { property: 'og:url', content: SITE },
      { property: 'og:site_name', content: 'Coal Stripes' },
      { property: 'og:image', content: `${SITE}/og-image.png` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '516' },
      {
        property: 'og:image:alt',
        content: 'Australian coal power plant availability stripes visualisation',
      },
      { property: 'og:locale', content: 'en_AU' },
      { property: 'og:type', content: 'website' },

      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: TITLE },
      { name: 'twitter:description', content: SOCIAL_DESCRIPTION },
      { name: 'twitter:image', content: `${SITE}/og-image.png` },
    ],
    links: [
      { rel: 'icon', href: '/favicon.svg' },

      // One stylesheet, one origin. app.css bundles Tailwind (themed by Open
      // Electricity's tailwind.config.js), the three design-system faces, and
      // our own opennem.css.
      //
      // The three faces used to come from fonts.googleapis.com, which cost two
      // extra handshakes on a zone whose edge is in Singapore: the Google
      // stylesheet, then fonts.gstatic.com, whose connection could not even
      // begin until that stylesheet parsed. Two preconnect hints and a long
      // comment existed to soften that. Self-hosting via @fontsource deletes the
      // problem instead — the woff2s are same-origin assets served by this
      // Worker, fingerprinted, and cached at the same edge as everything else.
      { rel: 'stylesheet', href: appCss },
    ],

    scripts: [
      // The unit metadata every year payload joins against. First, so it is set
      // before anything that could possibly read it. Absent on a client
      // navigation, and absent if the store could not produce a blob — in which
      // case the page renders no rows rather than rows built on a guess.
      ...(loaderData ? [{ children: unitMetadataScript(loaderData) }] : []),

      // Inline, and in the head, because it has to run in the one case where
      // nothing else on the page can: when every hashed asset this document names
      // has 404ed. See @/client/stale-document-tripwire.
      { children: STALE_DOCUMENT_TRIPWIRE },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

/**
 * No analytics beacon here, deliberately.
 *
 * Cloudflare Web Analytics is configured for automatic injection, so the edge
 * adds the snippet itself once stripes.energy is proxied — see
 * docs/caching-and-diagnostics.md § Analytics. Adding a manual snippet as well
 * would be a bug, not redundancy: only one can render per page, and the two
 * report to different endpoints.
 */
function RootDocument({ children }: { children: ReactNode }) {
  useStaleDocumentTripwireDisarm();

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers>{children}</Providers>
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Tell the tripwire the app came up, and tidy up after it if it fired.
 *
 * This runs on hydration rather than on first paint or first data, and that is
 * the right moment: the tripwire's question is "did the JavaScript load", not
 * "did the chart appear". A page still waiting on OpenElectricity has booted
 * fine.
 *
 * Clearing the guard here is what makes the self-heal repeatable — it is set
 * once per failed load and would otherwise sit in sessionStorage for the rest of
 * the tab's life, disarming the tripwire for the *next* bad deploy.
 *
 * The `_fresh` parameter is stripped with a raw `replaceState` rather than a
 * router navigation: it exists only to be a different cache key, the router
 * should never see it as state, and `/`'s validateSearch would drop it on the
 * next navigation anyway (`/stats` and `/diagnostics` have no validator, so
 * doing it here covers all three in one place).
 */
function useStaleDocumentTripwireDisarm() {
  useEffect(() => {
    (window as unknown as Record<string, unknown>)[BOOT_FLAG] = true;

    try {
      window.sessionStorage.removeItem(SELF_HEAL_GUARD);
    } catch {
      // Unavailable in some privacy modes. The tripwire copes; so do we.
    }

    const url = new URL(window.location.href);
    if (url.searchParams.has(FRESH_PARAM)) {
      url.searchParams.delete(FRESH_PARAM);
      window.history.replaceState(window.history.state, '', url.toString());
    }
  }, []);
}
