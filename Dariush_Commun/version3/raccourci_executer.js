/*
  raccourci_executer.js
  Raccourci clavier Maj+Entrée, comme dans Basthon / Jupyter : exécute la cellule active.
    - curseur dans un markdown en cours de saisie      → le texte est validé, le rendu s'affiche ;
    - curseur dans l'éditeur de code (Python ou SQL)   → même effet qu'un clic sur "Exécuter".
  Partout ailleurs (chat, champ input(), terminal...), Maj+Entrée garde son comportement habituel.
  Module autonome.
*/

(function () {
  "use strict";

  // ── Où se trouve le curseur ? ─────────────────────────────────
  // Zone de saisie d'un markdown : les blocs de #markdownsContainer et l'ancien #exerciseText
  // portent tous la classe "exercise-text".
  function estSaisieMarkdown(cible) {
    return !!(
      cible &&
      cible.tagName === "TEXTAREA" &&
      cible.classList.contains("exercise-text")
    );
  }

  // Éditeur de code : window.pythonEditor est le CodeMirror de Python comme de SQL.
  // Dans Dariush Linux c'est un éditeur fantôme sans cadre (getWrapperElement renvoie null).
  function estDansEditeurDeCode(cible) {
    const editeur = window.pythonEditor;
    if (!editeur || typeof editeur.getWrapperElement !== "function") return false;

    const cadre = editeur.getWrapperElement();
    return !!(cadre && cadre.contains(cible));
  }

  // ── Actions ───────────────────────────────────────────────────
  // Quitter la zone de saisie suffit : markdown.js affiche le rendu sur l'événement "blur".
  function validerMarkdown(zoneSaisie) {
    zoneSaisie.blur();
  }

  // On passe par le bouton : il est désactivé quand l'exécution est impossible
  // (moteur pas encore chargé, exécution déjà en cours, débogage pas à pas).
  function executerCode() {
    const bouton = document.getElementById("runButton");
    if (bouton && !bouton.disabled) {
      bouton.click();
    }
  }

  // ── Raccourci ─────────────────────────────────────────────────
  function surToucheEnfoncee(e) {
    if (e.key !== "Enter" || !e.shiftKey) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;

    const cible = e.target;

    if (estSaisieMarkdown(cible)) {
      e.preventDefault();
      e.stopPropagation();
      validerMarkdown(cible);
      return;
    }

    if (estDansEditeurDeCode(cible)) {
      e.preventDefault();
      e.stopPropagation();
      // Touche maintenue enfoncée : une seule exécution
      if (!e.repeat) {
        executerCode();
      }
    }
  }

  // Phase de capture : on passe avant CodeMirror, qui insérerait sinon un saut de ligne
  document.addEventListener("keydown", surToucheEnfoncee, true);
})();
