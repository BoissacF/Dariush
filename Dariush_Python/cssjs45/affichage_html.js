/*
  affichage_html.js
  ------------------------------------------------------------------
  Module dédié à l'affichage de sorties HTML interactives générées
  par des libraries Python (folium, plotly, bokeh, graphviz, etc.).

  Architecture symétrique à celle de gestionimages.js :
   - une modal réutilisable
   - navigation entre plusieurs sorties HTML d'une même exécution
   - téléchargement en .html
   - reset au début de chaque exécution

  API publique exposée sur window.AffichageHTML :
    show(htmlString, options)   ouvre la modal avec ce HTML
                                options = { title, filename }
    reset()                     vide la liste (appelé en début d'exécution)
    count()                     nombre de sorties HTML accumulées
*/

(function () {
  "use strict";

  // ===== État interne =====
  var htmlOutputs = [];       // [{ html, title, filename }, ...]
  var currentIndex = -1;

  // ===== Références DOM (résolues à l'initialisation) =====
  var modal = null;
  var modalBox = null;
  var header = null;
  var titleEl = null;
  var counterEl = null;
  var prevBtn = null;
  var nextBtn = null;
  var downloadBtn = null;
  var closeBtn = null;
  var iframeEl = null;

  // ===== Init paresseuse (au premier show) =====
  var initialized = false;

  function init() {
    if (initialized) return;

    modal       = document.getElementById("htmlModal");
    modalBox    = document.getElementById("htmlModalBox");
    header      = document.getElementById("htmlModalHeader");
    titleEl     = document.getElementById("htmlModalTitle");
    counterEl   = document.getElementById("htmlCounter");
    prevBtn     = document.getElementById("prevHtmlBtn");
    nextBtn     = document.getElementById("nextHtmlBtn");
    downloadBtn = document.getElementById("downloadHtmlBtn");
    closeBtn    = document.getElementById("closeHtmlModal");
    iframeEl    = document.getElementById("pythonHtmlViewer");

    if (!modal || !modalBox || !iframeEl) {
      console.warn("[affichage_html] Modal HTML introuvable dans index.html.");
      return;
    }

    if (closeBtn)    closeBtn.addEventListener("click", closeModal);
    if (prevBtn)     prevBtn.addEventListener("click", showPrev);
    if (nextBtn)     nextBtn.addEventListener("click", showNext);
    if (downloadBtn) downloadBtn.addEventListener("click", downloadCurrent);

    // Drag modal par le header (même esprit que la modal images)
    if (header) {
      enableDrag(header, modalBox);
    }

    // Echap pour fermer
    document.addEventListener("keydown", function (e) {
      if (!modal || modal.classList.contains("hidden")) return;
      if (e.key === "Escape") closeModal();
    });

    initialized = true;
  }

  // ===== Drag du modal par le header =====
  // ===== Drag du modal par le header =====
  // On contraint le header à rester visible dans le viewport, pour que
  // l'utilisateur puisse toujours reprendre le drag.
  function enableDrag(handle, box) {
    var dragging = false;
    var startX = 0;
    var startY = 0;
    var boxStartLeft = 0;
    var boxStartTop = 0;

    handle.addEventListener("mousedown", function (e) {
      // Ignorer les clics sur les boutons à l'intérieur du header
      if (e.target.tagName === "BUTTON") return;

      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      var rect = box.getBoundingClientRect();
      boxStartLeft = rect.left;
      boxStartTop = rect.top;
      box.style.transform = "none";
      box.style.left = boxStartLeft + "px";
      box.style.top = boxStartTop + "px";
      e.preventDefault();
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;

      var newLeft = boxStartLeft + dx;
      var newTop = boxStartTop + dy;

      // Contraintes : le header doit rester visible et cliquable
      var boxRect = box.getBoundingClientRect();
      var headerHeight = handle.offsetHeight || 40;
      var minVisible = 40;  // au moins 40px du header visibles à droite/gauche

      var maxLeft = window.innerWidth - minVisible;
      var minLeft = -(boxRect.width - minVisible);
      var maxTop = window.innerHeight - headerHeight;
      var minTop = 0;  // jamais au-dessus du haut de l'écran

      if (newLeft > maxLeft) newLeft = maxLeft;
      if (newLeft < minLeft) newLeft = minLeft;
      if (newTop > maxTop) newTop = maxTop;
      if (newTop < minTop) newTop = minTop;

      box.style.left = newLeft + "px";
      box.style.top = newTop + "px";
    });

    document.addEventListener("mouseup", function () {
      dragging = false;
    });
  }

  // ===== Affichage =====
  function showAt(index) {
    if (!initialized) init();
    if (!modal || !iframeEl) return;
    if (index < 0 || index >= htmlOutputs.length) return;

    currentIndex = index;
    var entry = htmlOutputs[currentIndex];

    if (titleEl) {
      titleEl.textContent = entry.title || "Affichage HTML";
    }

    if (counterEl) {
      counterEl.textContent = (currentIndex + 1) + "/" + htmlOutputs.length;
    }

    // srcdoc = isolation totale, scripts exécutés normalement
    iframeEl.srcdoc = entry.html || "";

    modal.classList.remove("hidden");
  }

  function showPrev() {
    if (htmlOutputs.length === 0) return;
    var newIndex = currentIndex - 1;
    if (newIndex < 0) newIndex = htmlOutputs.length - 1;
    showAt(newIndex);
  }

  function showNext() {
    if (htmlOutputs.length === 0) return;
    var newIndex = currentIndex + 1;
    if (newIndex >= htmlOutputs.length) newIndex = 0;
    showAt(newIndex);
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.add("hidden");
    // libérer la mémoire de l'iframe
    if (iframeEl) iframeEl.srcdoc = "";
  }

  // ===== Téléchargement du HTML courant =====
  function downloadCurrent() {
    if (currentIndex < 0 || currentIndex >= htmlOutputs.length) return;
    var entry = htmlOutputs[currentIndex];

    var blob = new Blob([entry.html || ""], { type: "text/html;charset=utf-8" });
    var url = URL.createObjectURL(blob);

    var a = document.createElement("a");
    a.href = url;
    a.download = entry.filename || ("sortie_" + (currentIndex + 1) + ".html");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ===== API publique =====

  /**
   * Ajoute un HTML à la liste et l'affiche.
   * @param {string} htmlString  HTML autonome à afficher
   * @param {object} options     { title, filename }
   */
  function show(htmlString, options) {
    if (!initialized) init();
    if (!modal) return;  // pas de modal présente, on abandonne silencieusement

    var opts = options || {};
    htmlOutputs.push({
      html: String(htmlString || ""),
      title: String(opts.title || "Affichage HTML"),
      filename: String(opts.filename || "sortie.html")
    });

    showAt(htmlOutputs.length - 1);
  }

  /**
   * Réinitialise la liste (à appeler au début de chaque runPythonCode).
   */
  function reset() {
    htmlOutputs = [];
    currentIndex = -1;
    if (iframeEl) iframeEl.srcdoc = "";
  }

  function count() {
    return htmlOutputs.length;
  }

  // ===== Export global =====
  window.AffichageHTML = {
    show: show,
    reset: reset,
    count: count
  };

  // Init dès que le DOM est prêt
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();