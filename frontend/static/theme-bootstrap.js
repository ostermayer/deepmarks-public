// Apply persisted theme before first paint to avoid FOUC.
//
// Lives in static/ (served as same-origin script) instead of inline in
// app.html so it's covered by `script-src 'self'` without needing a
// per-build SHA-256 hash. SvelteKit's csp.mode='auto' hashes the
// boot-data inline script automatically but doesn't reach into app.html
// inline blocks; externalizing this one keeps the CSP tight without
// having to maintain a hash by hand.
(function () {
  try {
    var t = localStorage.getItem('deepmarks-theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (_) {
    // localStorage refused (private mode, disabled cookies, etc.).
    // No-op — page renders default theme.
  }
})();
