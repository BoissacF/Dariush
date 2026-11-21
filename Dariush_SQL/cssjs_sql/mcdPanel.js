/*
  mcdPanel.js
  Ouvre Dariush-MCD-MLD dans un panneau (iframe) DÉPLAÇABLE par-dessus Dariush SQL.
  Même fonctionnement et mêmes classes CSS que le panneau des graphes
  (graphPanel.js) : centré à l'ouverture, fermeture par ✕ / Échap / clic sur
  le fond, déplacement en saisissant le bandeau gris.
  Le travail en cours est conservé entre une fermeture et une réouverture
  (l'iframe n'est chargée qu'une fois).

  100% autonome, aucune communication entre iframes.
*/

(function () {
  "use strict";

  const SRC_MCD = "../Dariush_MCD_MLD/index.html";

  function init() {
    const btn      = document.getElementById("mcdPanelButton");
    const overlay  = document.getElementById("mcdModalOverlay");
    const win      = document.getElementById("mcdModalWindow");
    const frame    = document.getElementById("mcdModalFrame");
    const bar      = document.getElementById("mcdModalBar");
    const closeBtn = document.getElementById("mcdModalClose");
    if (!btn || !overlay || !win || !frame) return;

    function resetPosition() {
      win.style.left = "50%";
      win.style.top = "4vh";
      win.style.transform = "translateX(-50%)";
    }

    function open() {
      if (!frame.getAttribute("src")) frame.setAttribute("src", SRC_MCD);
      resetPosition();
      overlay.classList.add("open");
      document.addEventListener("keydown", onKey);
    }
    function close() {
      overlay.classList.remove("open");
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    btn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

    // ---------- déplacement (même logique que graphPanel.js) ----------
    if (bar) {
      let dragging = false, offX = 0, offY = 0;

      bar.addEventListener("pointerdown", function (e) {
        if (e.target.closest("button")) return; // ne pas déplacer en cliquant un bouton
        dragging = true;
        const rect = win.getBoundingClientRect();
        offX = e.clientX - rect.left;
        offY = e.clientY - rect.top;
        win.style.transform = "none";
        win.style.left = rect.left + "px";
        win.style.top = rect.top + "px";
        bar.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      });

      bar.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        let left = e.clientX - offX;
        let top  = e.clientY - offY;
        const rect = win.getBoundingClientRect();
        const barH = bar.offsetHeight || 40;
        const minVisible = 40;
        const maxLeft = window.innerWidth - minVisible;
        const minLeft = -(rect.width - minVisible);
        const maxTop = window.innerHeight - barH;
        const minTop = 0;
        if (left > maxLeft) left = maxLeft;
        if (left < minLeft) left = minLeft;
        if (top > maxTop) top = maxTop;
        if (top < minTop) top = minTop;
        win.style.left = left + "px";
        win.style.top = top + "px";
      });

      function stop(e) {
        if (!dragging) return;
        dragging = false;
        bar.releasePointerCapture?.(e.pointerId);
      }
      bar.addEventListener("pointerup", stop);
      bar.addEventListener("pointercancel", stop);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
