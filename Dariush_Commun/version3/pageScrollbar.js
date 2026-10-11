/*
  pageScrollbar.js
  Curseur draggable sur barre colorée représentant les pages du notebook.
  Synchronisation via MutationObserver sur #pagesMultiplesIndicator
*/

(function () {
  "use strict";

  const COLORS = ["#e74c3c", "#2ecc71", "#3498db", "#f1c40f", "#9b59b6", "#1abc9c"];
  const BAR_WIDTH = 14;
  const CURSOR_HEIGHT = 8;
  const MIN_SEGMENT_PX = 5;

  let barEl = null;
  let cursorEl = null;
  let isDragging = false;
  let lastIndex = -1;

  // ── Création DOM ──────────────────────────────────────────────
  function createBar() {
    barEl = document.createElement("div");
    barEl.id = "pageScrollbar";
    barEl.style.cssText = `
      position: fixed;
      right: 0;
      top: 0;
      width: ${BAR_WIDTH}px;
      height: 100vh;
      z-index: 9999;
      display: none;
      overflow: visible;
      box-shadow: -1px 0 3px rgba(0,0,0,0.2);
      user-select: none;
    `;

    cursorEl = document.createElement("div");
    cursorEl.style.cssText = `
      position: absolute;
      left: -3px;
      width: ${BAR_WIDTH + 6}px;
      height: ${CURSOR_HEIGHT}px;
      background: #fff;
      border: 2px solid #555;
      border-radius: 3px;
      cursor: grab;
      z-index: 10000;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      user-select: none;
    `;

    cursorEl.addEventListener("mousedown", (e) => {
      if (!isNavigationAllowed()) return;
      isDragging = true;
      cursorEl.style.cursor = "grabbing";
      e.preventDefault();
      e.stopPropagation();
    });


  

    barEl.appendChild(cursorEl);
    document.body.appendChild(barEl);
  }

  // ── Lire total/active depuis l'indicateur ─────────────────────
  function getPageInfo() {
    const pm = window.PagesMultiples;
    if (!pm) return { total: 1, active: 0 };
    return {
      total: pm.getPagesCount(),
      active: pm.getActivePageIndex()
    };
  }

  // ── Position Y du curseur pour un index donné ─────────────────
  function getYForIndex(index, total) {
    const segH = window.innerHeight / total;
    return Math.round(index * segH + segH / 2 - CURSOR_HEIGHT / 2);
  }

  // ── Index de page pour une position Y souris ──────────────────
  function getIndexForY(clientY, total) {
    const ratio = Math.max(0, Math.min(0.9999, clientY / window.innerHeight));
    return Math.min(total - 1, Math.floor(ratio * total));
  }

  // ── Rendu de la barre ─────────────────────────────────────────
  function renderBar(total, active) {
    // Supprimer les segments précédents (pas le curseur)
    Array.from(barEl.children).forEach(child => {
      if (child !== cursorEl) barEl.removeChild(child);
    });

    const barH = window.innerHeight;
    const segH = barH / total;

    if (segH >= MIN_SEGMENT_PX) {
      barEl.style.background = "";
      for (let i = 0; i < total; i++) {
        const seg = document.createElement("div");
        const top = Math.floor((i / total) * barH);
        const bottom = i === total - 1 ? barH : Math.floor(((i + 1) / total) * barH);
        seg.style.cssText = `
          position: absolute;
          left: 0;
          top: ${top}px;
          width: 100%;
          height: ${bottom - top}px;
          background: ${COLORS[i % COLORS.length]};
          pointer-events: none;
        `;
        barEl.insertBefore(seg, cursorEl);
      }
    } else {
      barEl.style.background = "#bdc3c7";
    }

    // Positionner le curseur
    cursorEl.style.top = getYForIndex(active, total) + "px";
    lastIndex = active;
  }

  // ── Mise à jour principale ────────────────────────────────────
  function updateScrollbar() {
    if (!barEl) return;
    const { total, active } = getPageInfo();

    if (total <= 1) {
      barEl.style.display = "none";
      return;
    }

    barEl.style.display = "block";
    renderBar(total, active);
  }

 
  // ── Droits de navigation ──────────────────────────────────────
  function isNavigationAllowed() {
    // Verrou explicite (élève en groupe via lockPageNavigation)
    if (window.__groupNavLocked === true) return false;
    // Connecté à un groupe (prof ou élève) → scrollbar inerte
    if (typeof window.groupeJoined === "function" && window.groupeJoined()) return false;
    // Connecté à l'aide (prof ou élève) → scrollbar inerte
    if (window.__aideConnecte === true) return false;
    return true;
  }

  // ── Observer l'indicateur de page (source de vérité) ─────────
  function observeIndicator() {
    const indicator = document.getElementById("pagesMultiplesIndicator");
    if (!indicator) return;

    const observer = new MutationObserver(() => {
      updateScrollbar();
    });

    observer.observe(indicator, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    createBar();

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      if (!isNavigationAllowed()) return;

      const { total } = getPageInfo();
      const newTop = Math.max(0, Math.min(
        window.innerHeight - CURSOR_HEIGHT,
        e.clientY - CURSOR_HEIGHT / 2
      ));
      cursorEl.style.top = newTop + "px";

      const newIndex = getIndexForY(e.clientY, total);
      if (newIndex !== lastIndex) {
        lastIndex = newIndex;
        window.PagesMultiples.loadPageIntoEditor(newIndex);
      }
    });

    document.addEventListener("mouseup", () => {
      if (!isDragging) return;
      isDragging = false;
      cursorEl.style.cursor = "grab";
      // Recentrer le curseur sur le milieu du segment actif
      updateScrollbar();
    });


    
   barEl.addEventListener("mouseup", (e) => {
      if (isDragging) return;
      if (!isNavigationAllowed()) return;

      const { total } = getPageInfo();
      const newTop = Math.max(0, Math.min(
        window.innerHeight - CURSOR_HEIGHT,
        e.clientY - CURSOR_HEIGHT / 2
      ));
      cursorEl.style.top = newTop + "px";

      const newIndex = getIndexForY(e.clientY, total);
      if (newIndex !== lastIndex) {
        lastIndex = newIndex;
        window.PagesMultiples.loadPageIntoEditor(newIndex);
      }
      updateScrollbar();
    });





    window.addEventListener("resize", updateScrollbar);

    // Attendre PagesMultiples puis observer l'indicateur
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (window.PagesMultiples && window.PagesMultiples.getPagesCount) {
        clearInterval(timer);
        observeIndicator();
        updateScrollbar();
      }
      if (tries > 200) clearInterval(timer);
    }, 50);
  }

  document.addEventListener("DOMContentLoaded", init);
})();