/**
 * The last line of defence against a document that outlived its build.
 *
 * The SSR document names Vite's content-hashed assets. If the edge ever serves
 * a copy from a build that is no longer deployed — see src/server/deploy-purge
 * for the deploy-flip race that does this, once per deploy per colo — every
 * `/assets/*` it names 404s and the page sits on its loading spinner forever.
 * The failure is total and completely silent: no error is surfaced to the
 * visitor, nothing is reported, and the site simply looks broken to whoever
 * happened to arrive.
 *
 * Everything else in this fix addresses a *cause*. This addresses the symptom,
 * which is why it is worth having on top: it is the only mechanism that helps
 * someone already holding a poisoned document, and the only one that works
 * regardless of why the document is stale.
 *
 * Three constraints shape it, and each rules out the obvious approach:
 *
 * 1. It must be a CLASSIC inline script. Anything loaded as a module is exactly
 *    what is 404ing, and anything loaded from `/assets/` is too. So this is a
 *    string, inlined into the head by @/routes/__root, not an import.
 *
 * 2. It cannot use `location.reload()`. A reload re-requests the same URL, which
 *    the edge answers from the same poisoned entry — a loop that changes
 *    nothing. It has to reload a URL that is a different cache key, hence the
 *    `_fresh` parameter, which forces a MISS and therefore the current version.
 *
 * 3. It must be impossible to loop. If the reload also fails — the cause was
 *    something else entirely — a second attempt would spin forever. A
 *    sessionStorage flag, set before the reload and cleared once the app boots,
 *    caps it at exactly one attempt.
 *
 * One thing that looks wrong and isn't: React removes this `<script>` element
 * from the head during hydration, so you will not find it in DevTools' Elements
 * panel on a working page — only in `curl`'s output. That is harmless. Inline
 * scripts run at parse time, and the listener it registers outlives the element
 * by a long way; by the time hydration could remove anything, the app has booted
 * and the tripwire's work is done either way. Verified in Chrome against a real
 * 404: the listener still fires after the element is gone.
 */

/** Set on `window` by @/routes/__root once React has hydrated. */
export const BOOT_FLAG = '__stripesBooted';

/** sessionStorage key holding "a self-heal reload has already been tried". */
export const SELF_HEAL_GUARD = 'stripes:self-heal';

/** The cache-busting parameter the reload adds, and the app strips on boot. */
export const FRESH_PARAM = '_fresh';

/**
 * How long to wait before assuming the app is never coming up.
 *
 * Only a backstop — a 404ing asset fires an error event within milliseconds, and
 * that is the path this bug actually takes. This covers a failure mode we have
 * not seen, so it is tuned to avoid false positives rather than to be quick:
 * the deployed bundle is ~163 KB compressed, which is a few seconds even on a
 * slow connection, and reloading a page that was merely being slow is a real
 * cost to the one visitor least able to afford it.
 */
export const BOOT_TIMEOUT_MS = 10_000;

/**
 * The tripwire, as source to inline.
 *
 * Written as a template literal over the constants above so the script and the
 * code that clears its flag cannot drift apart — the guard key in particular is
 * written here and cleared in @/routes/__root, and a typo in either would be
 * invisible until the one moment it mattered.
 *
 * `try/catch` around sessionStorage is not defensive padding: it throws outright
 * in some privacy modes, and a tripwire that can throw is worse than no tripwire
 * at all. When it is unavailable the heal still runs, just unguarded — one
 * reload of a broken page beats leaving it broken, and the `healed` local still
 * prevents a loop within a single page.
 */
export const STALE_DOCUMENT_TRIPWIRE = `(function(){
  var booted = function(){ return window.${BOOT_FLAG} === true; };
  var healed = false;
  var store = function(){ try { return window.sessionStorage; } catch (e) { return null; } };
  var heal = function(reason){
    if (healed || booted()) return;
    var s = store();
    try {
      if (s && s.getItem('${SELF_HEAL_GUARD}')) {
        console.error('[stripes] still cannot load assets after a self-heal reload (' + reason + '); giving up');
        return;
      }
      if (s) s.setItem('${SELF_HEAL_GUARD}', '1');
    } catch (e) {}
    healed = true;
    console.warn('[stripes] this document is stale (' + reason + '); reloading past the cache');
    var u = new URL(window.location.href);
    u.searchParams.set('${FRESH_PARAM}', String(Date.now()));
    window.location.replace(u.toString());
  };
  window.addEventListener('error', function(e){
    var t = e.target;
    if (!t || t === window) return;
    var raw = t.src || t.href;
    if (typeof raw !== 'string') return;
    var path;
    try { path = new URL(raw, window.location.href).pathname; } catch (err) { return; }
    if (path.lastIndexOf('/assets/', 0) !== 0) return;
    heal('asset ' + path);
  }, true);
  setTimeout(function(){ heal('timeout'); }, ${BOOT_TIMEOUT_MS});
})();`;
