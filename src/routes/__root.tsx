/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Providers } from '@/client/providers';
import globalsCss from '@/styles/globals.css?url';
import opennemCss from '@/styles/opennem.css?url';

const TITLE = 'Coal Availability';
const DESCRIPTION = 'Australian coal power plant capacity factor visualisation';
const SOCIAL_DESCRIPTION =
  'Real-time visualisation of Australian coal power plant capacity factors';
const SITE = 'https://stripes.energy';

export const Route = createRootRoute({
  head: () => ({
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

      // DM Sans, linked here rather than @import-ed from opennem.css.
      //
      // An @import is only discovered once the importing sheet has been
      // downloaded AND parsed, so the font stylesheet sat behind opennem.css in
      // a serial chain and could not start until it landed — measured at ~340 ms
      // on this zone, whose edge is in Singapore. Linked from the head it is in
      // the initial HTML, so the browser's preload scanner starts all three
      // sheets together.
      //
      // The preconnects cover the second hop: fonts.googleapis.com returns
      // @font-face rules pointing at fonts.gstatic.com, a different origin whose
      // handshake would otherwise begin only after that CSS parses. gstatic
      // needs crossOrigin because fonts are fetched in CORS mode; without it the
      // browser opens a second, unusable connection.
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&display=swap',
      },

      // Next let each page import its own CSS; here both sheets are linked once
      // from the root so /diagnostics stops being the odd one out.
      { rel: 'stylesheet', href: globalsCss },
      { rel: 'stylesheet', href: opennemCss },
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
