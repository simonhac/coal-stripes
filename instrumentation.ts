/**
 * Next.js instrumentation file
 * This runs once when the server starts
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Only run on the server
    const { initializeRequestLogger } = await import('./src/server/request-logger');
    
    // Get the port from environment or use Next.js default
    const port = parseInt(process.env.PORT || '3000', 10);
    initializeRequestLogger(port);
  }
}