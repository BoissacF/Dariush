/*
  scrollFlipPage.js
  --------------------------------------------------------------------------
  Bascule de page façon notebook, sans changer le modèle (une seule page
  affichée). En butée de scroll, tant qu'on CONTINUE de pousser dans le même
  sens pendant DWELL_MS, on bascule (bas = page suivante, haut = précédente).

  Défilement continu : aucune obligation de relâcher la molette.
  À chaque changement de page on remet TOUT l'état de la poussée à zéro
  (sens, chrono de latence, dernier cran) : comme la nouvelle page repart de
  son haut, il faut la reparcourir jusqu'en bas avant de pouvoir rebasculer.
  Le défilement reste donc fluide, mais chaque bascule réclame une latence
  complète → on ne saute jamais deux pages d'un coup.

  Module autonome : n'appelle que l'API publique window.PagesMultiples,
  et ne fait rien si window.__groupNavLocked === true.

  Intégration (après pagesmultiples.js) :
     <script defer src="../Dariush_Commun/version3/scrollFlipPage.js?v=64466"></script>
  --------------------------------------------------------------------------
*/
(function () {
  "use strict";

  const DEBUG = false;         // true : traces de diagnostic dans la console

  // ── Réglages ──────────────────────────────────────────────────────────────
  // DWELL_MS : durée (ms) de poussée continue en butée avant de basculer (la "latence").
  const DWELL_MS = 400;
  // GAP_MAX_MS : écart max (ms) entre deux crans avant que la poussée reparte de zéro.
  //   Doit rester plus grand que l'espacement naturel des crans de molette (~250 ms).
  const GAP_MAX_MS = 800;
  // SETTLE_MS : court flottement ignoré APRÈS une bascule, le temps que la
  //   nouvelle page se positionne (loadPageIntoEditor remet le scroll en haut
  //   ~200 ms après le changement). Ce n'est PAS une pause demandée à l'élève :
  //   il continue de scroller, ces ms passent pendant qu'il parcourt le haut de
  //   la nouvelle page. 0 désactive ce délai.
  const SETTLE_MS = 250;
  const MARGE_BUTEE_PX = 2;

  // ── État ───────────────────────────────────────────────────────────────────
  let edgeDir = 0;        // sens de la poussée : +1 bas, -1 haut, 0 aucune
  let dwellStart = 0;     // début de la poussée continue
  let lastEdgeEvt = 0;    // timestamp du dernier cran en butée
  let settleUntil = 0;    // tant que now < settleUntil, on ne mesure pas

  function log() {
    if (!DEBUG) return;
    console.log.apply(console, ["[scrollFlip]"].concat([].slice.call(arguments)));
  }

  function maintenantMs() {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
  }

  function navVerrouillee() { return window.__groupNavLocked === true; }

  // Remet à zéro TOUT l'état de poussée (le cœur du correctif anti double-saut).
  function reinitialiserPoussee() {
    edgeDir = 0;
    dwellStart = 0;
    lastEdgeEvt = 0;
  }

  function trouverScroller(cible) {
    let el = cible;
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + MARGE_BUTEE_PX) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll") return el;
      }
      el = el.parentElement;
    }
    const zp = document.getElementById("zonePython");
    if (zp && zp.scrollHeight > zp.clientHeight + MARGE_BUTEE_PX) return zp;
    return document.scrollingElement || document.documentElement || document.body;
  }

  function basculer(sens) {
    const pm = window.PagesMultiples;
    if (!pm) { log("⚠ PagesMultiples absent"); return; }

    const total = (typeof pm.getPagesCount === "function") ? pm.getPagesCount() : "?";
    const idx = (typeof pm.getActivePageIndex === "function") ? pm.getActivePageIndex() : "?";
    log("➡ BASCULE sens=", sens, " pageActive=", idx, " total=", total);
    if (total === 1) log("⚠ une seule page : rien ne bougera (ajoute une page pour tester)");

    if (sens > 0 && typeof pm.goToNextPage === "function") pm.goToNextPage();
    else if (sens < 0 && typeof pm.goToPreviousPage === "function") pm.goToPreviousPage();

    // Cœur du correctif : on remet tout à zéro et on ignore brièvement le scroll
    // le temps que la nouvelle page se positionne.
    reinitialiserPoussee();
    settleUntil = maintenantMs() + SETTLE_MS;
  }

  function onWheel(e) {
    if (navVerrouillee()) { reinitialiserPoussee(); return; }

    const dy = e.deltaY;
    if (!dy) return;

    const t = maintenantMs();

    // Flottement post-bascule : on n'évalue pas la poussée tant que la nouvelle
    // page n'est pas posée. On continue de laisser scroller (passive), on ignore
    // juste la mesure, et on garde l'état à zéro.
    if (t < settleUntil) {
      reinitialiserPoussee();
      return;
    }

    const scroller = trouverScroller(e.target);

    const peutScroller = scroller.scrollHeight > scroller.clientHeight + MARGE_BUTEE_PX;
    const atTop = !peutScroller || scroller.scrollTop <= MARGE_BUTEE_PX;
    const atBottom = !peutScroller ||
      (scroller.scrollTop + scroller.clientHeight) >= (scroller.scrollHeight - MARGE_BUTEE_PX);

    let dir = 0;
    if (dy > 0 && atBottom) dir = +1;
    else if (dy < 0 && atTop) dir = -1;

    if (dir === 0) { reinitialiserPoussee(); return; }

    // (Re)démarrage de la poussée si changement de sens ou trou trop long.
    if (dir !== edgeDir || (t - lastEdgeEvt) > GAP_MAX_MS) {
      edgeDir = dir;
      dwellStart = t;
    }
    lastEdgeEvt = t;

    const ecoule = t - dwellStart;
    log("poussée sens=", dir, " écoulé=", Math.round(ecoule), "ms / ", DWELL_MS);

    if (ecoule >= DWELL_MS) basculer(dir);
  }

  function init() {
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    log("initialisé (v5).",
        " PagesMultiples présent ?", !!window.PagesMultiples,
        " zonePython présent ?", !!document.getElementById("zonePython"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();