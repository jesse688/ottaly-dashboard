// Ottaly 2.0 splash — fires ONLY on a manual page reload (Cmd-R, browser
// refresh button, F5) or direct URL entry. Internal nav clicks within the
// app don't trigger it. Also doubles as a loading buffer so users don't
// see the half-rendered state while charts, caches, and webhook
// reprocessing settle.
(function ottalySplash() {
  // Detect manual reload via Navigation Timing API. type === 'reload' covers
  // Cmd-R / browser refresh; 'navigate' covers direct URL / new tab / back-
  // forward. We treat both as "fresh entry to the app" — what we EXCLUDE is
  // any case where the user click-navigated from another internal page.
  // For a multi-page app like this, click-nav also reports 'navigate', so
  // we further filter using document.referrer: if the referrer matches the
  // current origin AND it's not a reload, we assume it was a click-nav and
  // skip the splash.
  function shouldShowSplash() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      const type = nav ? nav.type : (performance.navigation && performance.navigation.type === 1 ? 'reload' : 'navigate');
      if (type === 'reload') return true;
      // Direct URL / new tab → no internal referrer → show
      if (!document.referrer) return true;
      // Came from a different origin (e.g. bookmark, email link) → show
      try {
        const refOrigin = new URL(document.referrer).origin;
        if (refOrigin !== location.origin) return true;
      } catch { return true; }
      // Same-origin referrer + not a reload → user clicked from another
      // page in the app → skip splash.
      return false;
    } catch {
      return true; // err on the side of showing
    }
  }
  if (!shouldShowSplash()) return;

  function show() {
    const root = document.createElement('div');
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:#050C29',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'z-index:2147483647',
      'opacity:1',                   // start visible — splash IS the page until charts/data load behind it
      'transition:opacity 400ms ease',
      // Block clicks/scrolling underneath. Users won't accidentally interact
      // with the half-rendered page during the splash.
      'pointer-events:auto',
      'font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif',
      'color:#ffffff',
    ].join(';');
    root.innerHTML = `
      <div style="font-size:64px;font-weight:700;letter-spacing:-0.02em;line-height:1;">
        OTTALY <span style="color:#7C89CD;">2.0</span>
      </div>
      <div style="margin-top:18px;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:#7C89CD;opacity:0.85;">
        Faster. Smarter.
      </div>
    `;
    document.body.appendChild(root);

    // Start fully visible (covers loading state), hold 4500ms, fade out 400ms.
    // Total cover time ~5s — gives charts, mailbox cache, revenue cache,
    // etc. time to settle in the background.
    setTimeout(() => { root.style.opacity = '0'; }, 4500);
    setTimeout(() => { root.remove(); }, 4900);
  }

  // Run as soon as body is available so the splash paints over the FIRST
  // frame, not after charts try to render underneath.
  try {
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  } catch {
    // Splash is non-critical — never block page on failure.
  }
})();
