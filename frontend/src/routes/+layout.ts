// Pure SPA — render everything in the browser. The frontend talks straight to
// relays + payment-proxy; there is no server-side data fetch.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';
