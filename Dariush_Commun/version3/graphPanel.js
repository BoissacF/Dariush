/*
  graphPanel.js
  Ouvre Dariush-Code-Graphe dans un panneau (iframe) DÉPLAÇABLE par-dessus Dariush.
  Bouton de bascule (sens unique) vers Dariush-Graphe (création d'images au clic).

  Comportement :
  - Le panneau ouvre toujours sur Dariush-Code-Graphe (génération de CODE), centré.
  - Le bouton du bandeau bascule l'iframe vers Dariush-Graphe (IMAGES).
  - Pour revenir au code : fermer (✕ / Échap / clic fond) puis rouvrir.
  - On peut déplacer la fenêtre en saisissant le bandeau gris (même logique que
    le modal image : pointer events + setPointerCapture, pour draguer même
    au-dessus de l'iframe).

  100% autonome, aucune communication entre iframes.
*/

(function () {
  "use strict";

  // Chemins des deux générateurs de graphes.
  const SRC_CODE  = "../Dariush_Code_Graphe/index.html"; // génère du code
  const SRC_IMAGE = "../DariushGraphes/index.html";      // génère des images

  function init() {
    const btn      = document.getElementById("graphPanelButton");
    const overlay  = document.getElementById("graphModalOverlay");
    const win       = document.getElementById("graphModalWindow");
    const frame    = document.getElementById("graphModalFrame");
    const bar      = document.getElementById("graphModalBar");
    const closeBtn = document.getElementById("graphModalClose");
    const switchBtn= document.getElementById("graphSwitchButton");
    const title    = document.getElementById("graphModalTitle");
    const info     = document.getElementById("graphModalInfo");
    if (!btn || !overlay || !win || !frame) return;

    let mode = "code"; // "code" ou "image"

    function updateBar() {
      if (mode === "code") {
        if (title) title.textContent = "Dariush-Code-Graphe";
        if (info)  info.innerHTML = "Génère du <b>code</b> (Mermaid pour le markdown, Python pour exécuter).";
        if (switchBtn) switchBtn.hidden = false;
        frame.setAttribute("title", "Dariush-Code-Graphe");
      } else {
        if (title) title.textContent = "Dariush-Graphe";
        if (info)  info.innerHTML = "Dessine et exporte des <b>images</b>. Ferme puis rouvre le panneau pour revenir au code.";
        if (switchBtn) switchBtn.hidden = true;
        frame.setAttribute("title", "Dariush-Graphe");
      }
    }

    function resetPosition() {
      win.style.left = "50%";
      win.style.top = "4vh";
      win.style.transform = "translateX(-50%)";
    }

    function open() {
      // On recharge le code seulement si on n'y est pas déjà (préserve le travail
      // en cours entre fermeture/réouverture, mais réinitialise depuis les images).
      if (mode === "image" || !frame.getAttribute("src")) {
        mode = "code";
        frame.setAttribute("src", SRC_CODE);
      }
      updateBar();
      resetPosition();
      overlay.classList.add("open");
      document.addEventListener("keydown", onKey);
    }
    function close() {
      overlay.classList.remove("open");
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    function goImage() {
      // En portable : Dariush-Graphe n'est pas embarqué (trop gros). S'il y a
      // internet, on l'ouvre dans un nouvel onglet (évite le blocage iframe).
      if (window.MODE_PORTABLE === true) {
        window.open("https://physalgo.fr/DariushGraphes/index.html", "_blank", "noopener");
        return; // l'iframe reste sur le code Mermaid
      }
      mode = "image";
      frame.setAttribute("src", SRC_IMAGE);
      updateBar();
    }

    btn.addEventListener("click", open);
    if (closeBtn)  closeBtn.addEventListener("click", close);
    if (switchBtn) switchBtn.addEventListener("click", goImage);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

    // ---------- déplacement (calqué sur initImageModal d'importer.js) ----------
    if (bar) {
      let dragging = false, offX = 0, offY = 0;

      bar.addEventListener("pointerdown", function (e) {
        if (e.target.closest("button")) return; // ne pas draguer en cliquant un bouton
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