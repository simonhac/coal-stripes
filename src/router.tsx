import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

// Start calls this once per request on the server and once on the client, so it
// must return a fresh router each time.
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
  });
}
