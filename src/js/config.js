// Build-time switches. The Dockerfile rewrites this file when building with
// ENABLE_SYNC=true; the source default is off, so a plain checkout and the
// default build make no network requests after the page loads.
export const SYNC_ENABLED = false;
