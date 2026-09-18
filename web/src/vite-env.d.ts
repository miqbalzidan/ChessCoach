/// <reference types="vite/client" />

/**
 * `import.meta.env` comes from Vite, not from TypeScript's defaults. The app reads
 * `BASE_URL` to build the engine's URL and the service worker's scope, so a build
 * published under a path still finds its own files.
 */
