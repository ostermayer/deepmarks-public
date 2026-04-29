// Auth redirect bootstrap.
//
// When an authenticated user lands on the marketing home page (/), the
// landing template is the prerendered HTML that ships in the static
// build. By the time SvelteKit hydrates and onMount fires its
// `goto('/app')`, the marketing content has already painted — that's
// the "flash" the user sees before the redirect.
//
// Running this script in <head> (before the body paints) catches the
// redirect synchronously: if the user has a persisted session hint and
// they're at /, we navigate before any pixels land. Same-origin script,
// so it works under script-src 'self' without a CSP hash.
(function () {
  try {
    if (window.location.pathname !== '/') return;
    var hint = localStorage.getItem('deepmarks-session-hint');
    if (!hint) return;
    // location.replace so the marketing page doesn't end up in history.
    window.location.replace('/app');
  } catch (_) {
    // localStorage blocked / different origin / something weird —
    // fall through to the regular page render + onMount redirect.
  }
})();
