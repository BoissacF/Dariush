/*
bottomPageNav.js — Dariush Linux
- Câble les clics du bandeau bas vers les boutons du haut
- Met à jour l'indicateur N/Total et l'état grisé des boutons Prec/Suiv
*/
(function () {
  "use strict";

  function getCounts() {
    const indicator = document.getElementById("pagesMultiplesIndicator");
    if (!indicator) return { current: 1, total: 1 };
    const m = (indicator.textContent || "").trim().match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) return { current: 1, total: 1 };
    return { current: parseInt(m[1], 10) || 1, total: parseInt(m[2], 10) || 1 };
  }

  function updateBottom() {
    const navIndicator = document.getElementById("bottomPageNavIndicator");
    const prevBtn      = document.getElementById("bottomPrevPageButton");
    const nextBtn      = document.getElementById("bottomNextPageButton");
    if (!navIndicator || !prevBtn || !nextBtn) return;

    const { current, total } = getCounts();
    navIndicator.textContent = current + "/" + total;

    // Si la navigation est verrouillée (élève en groupe ou élève actif en aide),
    // on force disabled = true. Sinon comportement normal.
    if (window.__groupNavLocked === true) {
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    prevBtn.disabled = current <= 1;
    nextBtn.disabled = current >= total;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const bottomPrev = document.getElementById("bottomPrevPageButton");
    const bottomNext = document.getElementById("bottomNextPageButton");
    const topPrev    = document.getElementById("pagesPrevButton");
    const topNext    = document.getElementById("pagesNextButton");
    const indicator  = document.getElementById("pagesMultiplesIndicator");

    if (bottomPrev && topPrev) bottomPrev.addEventListener("click", () => topPrev.click());
    if (bottomNext && topNext) bottomNext.addEventListener("click", () => topNext.click());

    // Observer les changements de l'indicateur du haut pour synchroniser le bas
    if (indicator) {
      const obs = new MutationObserver(updateBottom);
      obs.observe(indicator, { childList: true, subtree: true, characterData: true });
    }

    updateBottom();
  });
})();