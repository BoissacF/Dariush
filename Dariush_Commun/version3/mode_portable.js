// mode_portable.js — desactive les fonctions indisponibles en version portable.
(function () {
  if (!window.MODE_PORTABLE) return;
  const MESSAGE = "Cette fonction n'est pas disponible dans la version portable.";

  function bloquerBouton(el) {
    if (!el) return;
    el.style.opacity = "0.5";
    el.style.cursor = "not-allowed";
    el.setAttribute("aria-disabled", "true");
    el.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();   // passe AVANT les gestionnaires existants
      alert(MESSAGE);
    }, true);                          // true = phase de capture
  }

  function appliquer() {
    bloquerBouton(document.getElementById("boutonmenuconnexion")); // Travail en groupe
    bloquerBouton(document.getElementById("boutonAide"));          // Aide
    const sel = document.getElementById("dariushAppSelect");       // bascule SQL/Linux
    if (sel) {
      sel.disabled = true;
      sel.style.opacity = "0.5";
      sel.style.cursor = "not-allowed";
      sel.title = "Verrouille sur Dariush Python (version portable)";
    }
  }

  if (document.readyState === "complete") appliquer();
  else window.addEventListener("load", appliquer);
})();
