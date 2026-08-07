/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Providers } from '@/app/providers';
import globalsCss from '@/app/globals.css?url';
import opennemCss from '@/app/opennem.css?url';

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
