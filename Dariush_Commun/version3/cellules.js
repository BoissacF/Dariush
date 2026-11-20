/*
  cellules.js
  --------------------------------------------------------------------------
  Notebook par cellules (Dariush Python et SQL).

  Les pages restent le modèle interne (pagesmultiples.js) : une page = un
  ou plusieurs markdowns puis UNE zone de code. À l'écran, on manipule les
  cellules une par une, comme dans un notebook :
  - un "+" bien visible entre deux cellules : petite fenêtre "Voulez-vous
    ajouter ici : un markdown / une zone de code". Un "+" aussi tout en
    haut du document (un markdown seulement : le document commence
    toujours par un markdown).
    Une zone de code ne peut pas suivre une zone de code : le choix est
    alors grisé, avec la raison. Sous la dernière zone de code, le "+"
    ajoute directement une page (un markdown + une zone de code) ;
  - au-dessus de chaque zone de code, une barre comme celle des markdowns :
    ✂ (supprimer la zone de code, ou toute la page), ↑ et ↓ (déplacer) ;
  - les ↑ ↓ des markdowns franchissent les zones de code (le markdown
    change alors de page) ;
  - un bouton grisé dit pourquoi dans son infobulle.
  Le "+" de la barre des markdowns et le "+" / ✂ du haut disparaissent.

  Les règles et les opérations sont dans PagesMultiples.cellules ; ce
  fichier ne fait que l'affichage et les clics. Le ruban du notebook
  continu (scrollContinu.js) appelle creerSeparateur, creerBarreCode,
  majEtatsFacsimile pour que les pages inactives aient exactement les
  mêmes éléments (même hauteur) que la page active.

  Module autonome : ne fait RIEN si window.NOTEBOOK_CELLULES_ACTIF !== true
  (Dariush Linux ne pose pas ce drapeau).

  Intégration (après pagesmultiples.js) :
     <script defer src="../Dariush_Commun/version3/cellules.js?v=NNNN"></script>
  --------------------------------------------------------------------------
*/
(function () {
  "use strict";

  if (window.NOTEBOOK_CELLULES_ACTIF !== true) return;

  function pm() { return window.PagesMultiples || null; }

  function regles() {
    const gestionnaire = pm();
    return (gestionnaire && gestionnaire.cellules) ? gestionnaire.cellules : null;
  }

  function pluriel(n, mot) {
    return `${n} ${mot}${n > 1 ? "s" : ""}`;
  }

  // ── Éléments ─────────────────────────────────────────────────────────────
  // apres : "md" (sous un markdown), "code" (sous la zone de code) ou
  // "debut" (tout en haut du document).
  function creerSeparateur(apres) {
    const sep = document.createElement("div");
    sep.className = "nc-sep";
    sep.dataset.apres = apres;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nc-sep-btn nc-ctrl";
    btn.tabIndex = -1;
    btn.textContent = "+";
    sep.appendChild(btn);
    return sep;
  }

  function creerBarreCode() {
    const barre = document.createElement("div");
    barre.className = "comment-toolbar code-block-toolbar";
    [
      ["nc-code-cut", "✂"],
      ["nc-code-up", "↑"],
      ["nc-code-down", "↓"]
    ].forEach(([classe, texte]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `comment-toggle-btn nc-ctrl ${classe}`;
      btn.tabIndex = -1;
      btn.textContent = texte;
      barre.appendChild(btn);
    });
    return barre;
  }

  // Un "+" sous chaque bloc markdown du conteneur (zone vive ou fac-similé).
  function insererSeparateursMd(conteneur) {
    if (!conteneur) return;
    conteneur.querySelectorAll(".nc-sep").forEach((s) => s.remove());
    conteneur.querySelectorAll(".md-block").forEach((bloc) => {
      bloc.parentNode.insertBefore(creerSeparateur("md"), bloc.nextSibling);
    });
  }

  // ── États des boutons ────────────────────────────────────────────────────
  // Pas d'attribut disabled : le bouton grisé garde son infobulle (la
  // raison) ; l'opération elle-même refuse ce qui est interdit.
  function poserEtat(btn, verdict, titreSiOk) {
    if (!btn || !verdict) return;
    btn.disabled = false;
    btn.classList.toggle("is-disabled", !verdict.ok);
    btn.setAttribute("aria-disabled", verdict.ok ? "false" : "true");
    btn.title = verdict.ok ? titreSiOk : verdict.raison;
  }

  // "+" tout en haut du document : au-dessus du premier markdown de la
  // page 1 seulement (zone vive comme fac-similé : même hauteur).
  function majSepDebut(conteneur, p) {
    const existant = conteneur.querySelector(':scope > .nc-sep[data-apres="debut"]');
    if (p === 0) {
      const premier = conteneur.querySelector(":scope > .md-block");
      if (!existant && premier) conteneur.insertBefore(creerSeparateur("debut"), premier);
    } else if (existant) {
      existant.remove();
    }
  }

  function majEtatsMarkdowns(conteneur, p, vive) {
    const r = regles();
    if (!conteneur || !r) return;
    majSepDebut(conteneur, p);
    conteneur.querySelectorAll(".md-block").forEach((bloc, j) => {
      const coupe = bloc.querySelector(".md-btn-cut");
      const haut = bloc.querySelector(".md-btn-up");
      const bas = bloc.querySelector(".md-btn-down");
      // Fac-similé : ces boutons sont pris en charge ici (la zone vive a ses
      // propres écouteurs, posés par markdown.js).
      if (!vive) [coupe, haut, bas].forEach((b) => { if (b) b.classList.add("nc-ctrl"); });
      poserEtat(coupe, r.peutCouperMarkdown(p), "Supprimer ce markdown");
      poserEtat(haut, r.peutDeplacerMarkdown(p, j, -1), "Déplacer ce markdown vers le haut");
      poserEtat(bas, r.peutDeplacerMarkdown(p, j, +1), "Déplacer ce markdown vers le bas");
    });

    const blocs = conteneur.querySelectorAll(".md-block");
    const dernier = blocs.length - 1;
    conteneur.querySelectorAll(".nc-sep").forEach((sep) => {
      const btn = sep.querySelector(".nc-sep-btn");
      if (!btn) return;
      if (sep.dataset.apres === "debut") {
        btn.title = "Ajouter un markdown tout en haut du document";
        return;
      }
      const j = indexMarkdownAvant(sep);
      btn.title = j === dernier
        ? "Ajouter un markdown ici (une zone de code suit déjà ce markdown)"
        : "Ajouter un markdown ou une zone de code ici";
    });
  }

  function majEtatsCode(barre, sepCode, p) {
    const r = regles();
    const gestionnaire = pm();
    if (!r || !gestionnaire) return;
    if (barre) {
      poserEtat(barre.querySelector(".nc-code-cut"), r.peutCouperCode(p, "page"),
        "Supprimer cette zone de code (ou toute sa page)");
      poserEtat(barre.querySelector(".nc-code-up"), r.peutDeplacerCode(p, -1),
        "Déplacer la zone de code vers le haut");
      poserEtat(barre.querySelector(".nc-code-down"), r.peutDeplacerCode(p, +1),
        "Déplacer la zone de code vers le bas");
    }
    const btn = sepCode ? sepCode.querySelector(".nc-sep-btn") : null;
    if (btn) {
      const derniere = p === gestionnaire.getPagesCount() - 1;
      btn.title = derniere
        ? "Ajouter une page : un markdown + une zone de code"
        : "Ajouter un markdown ici";
    }
  }

  // Zone vive (page active) : appelée à chaque rendu des markdowns et à
  // chaque mise à jour de la pagination.
  function majEtatsVifs() {
    const gestionnaire = pm();
    if (!gestionnaire || !gestionnaire.cellules) return;
    const p = gestionnaire.getActivePageIndex();
    majEtatsMarkdowns(document.getElementById("markdownsContainer"), p, true);
    poserBarreCodeVive();
    majEtatsCode(
      document.querySelector("#mainSplit .code-block-toolbar"),
      document.getElementById("ncSepApresCode"),
      p
    );
  }

  // Page inactive du ruban (fac-similé) : mêmes règles, avec son index.
  function majEtatsFacsimile(sectionEl, p) {
    if (!sectionEl) return;
    majEtatsMarkdowns(sectionEl.querySelector(".sc-mds"), p, false);
    majEtatsCode(
      sectionEl.querySelector(".code-block-toolbar"),
      sectionEl.querySelector(':scope > .nc-sep[data-apres="code"]'),
      p
    );
  }

  function apresRenduMarkdowns(conteneur) {
    insererSeparateursMd(conteneur);
    majEtatsVifs();
  }

  // ── Zone vive : barre de code et "+" sous le code ────────────────────────
  function poserSepCodeVif() {
    if (document.getElementById("ncSepApresCode")) return;
    const split = document.getElementById("mainSplit");
    if (!split || !split.parentNode) return;
    const sep = creerSeparateur("code");
    sep.id = "ncSepApresCode";
    split.parentNode.insertBefore(sep, split.nextSibling);
  }

  function poserBarreCodeVive() {
    const editeur = window.pythonEditor;
    if (!editeur || typeof editeur.getWrapperElement !== "function") return;
    const wrapper = editeur.getWrapperElement();
    if (!wrapper || !wrapper.parentNode) return;
    const precedent = wrapper.previousElementSibling;
    if (precedent && precedent.classList.contains("code-block-toolbar")) return;
    wrapper.parentNode.insertBefore(creerBarreCode(), wrapper);
  }

  // ── Où se trouve le bouton cliqué ? ──────────────────────────────────────
  function indexPage(el) {
    const gestionnaire = pm();
    const section = el.closest(".sc-section");
    if (section && section.classList.contains("sc-fac") &&
        window.ScrollContinu && typeof window.ScrollContinu.indexSection === "function") {
      return window.ScrollContinu.indexSection(section);
    }
    return gestionnaire ? gestionnaire.getActivePageIndex() : -1;
  }

  function indexMarkdown(bloc) {
    const conteneur = bloc ? bloc.parentNode : null;
    if (!conteneur) return -1;
    return Array.prototype.indexOf.call(conteneur.querySelectorAll(":scope > .md-block"), bloc);
  }

  function indexMarkdownAvant(sep) {
    let el = sep.previousElementSibling;
    while (el && !el.classList.contains("md-block")) el = el.previousElementSibling;
    return el ? indexMarkdown(el) : -1;
  }

  // ── Garde-fous ───────────────────────────────────────────────────────────
  // Exécution en cours (pas le simple chargement de l'interpréteur) : la
  // structure ne bouge pas, sinon la sortie atterrirait dans une autre page.
  let interpreteurPret = false;
  function surveillerExecution() {
    const bouton = document.getElementById("runButton");
    if (!bouton) return;
    const maj = () => { if (!bouton.disabled) interpreteurPret = true; };
    maj();
    new MutationObserver(maj).observe(bouton, { attributes: true, attributeFilter: ["disabled"] });
  }

  function executionEnCours() {
    const bouton = document.getElementById("runButton");
    return !!(bouton && bouton.disabled && interpreteurPret);
  }

  // Élève en travail de groupe ou en aide : la structure est réservée au
  // professeur (comme le + et le ✂ du haut auparavant).
  function structureVerrouillee() {
    return window.__groupNavLocked === true;
  }

  function surveillerVerrou() {
    const appliquer = () => {
      document.body.classList.toggle("nc-verrou", structureVerrouillee());
    };
    appliquer();
    setInterval(appliquer, 400);
  }

  // ── Menu du "+" ──────────────────────────────────────────────────────────
  let menuOuvert = null;

  function fermerMenu() {
    if (!menuOuvert) return;
    menuOuvert.remove();
    menuOuvert = null;
    document.removeEventListener("mousedown", surMousedownHorsMenu, true);
    document.removeEventListener("keydown", surToucheMenu, true);
    window.removeEventListener("resize", fermerMenu);
    const zone = document.getElementById("zonePython");
    if (zone) zone.removeEventListener("scroll", fermerMenu);
  }

  function surMousedownHorsMenu(e) {
    if (menuOuvert && !menuOuvert.contains(e.target)) fermerMenu();
  }

  function surToucheMenu(e) {
    if (e.key === "Escape") { e.preventDefault(); fermerMenu(); }
  }

  function ajouterChoix(menu, libelle, verdict, action) {
    const choix = document.createElement("button");
    choix.type = "button";
    choix.className = "nc-menu-choix";
    choix.textContent = libelle;
    if (!verdict.ok) {
      choix.classList.add("is-disabled");
      choix.setAttribute("aria-disabled", "true");
      choix.title = verdict.raison;
    }
    choix.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!verdict.ok) return;
      fermerMenu();
      action();
    });
    menu.appendChild(choix);
    if (!verdict.ok) {
      const note = document.createElement("div");
      note.className = "nc-menu-note";
      note.textContent = verdict.raison;
      menu.appendChild(note);
    }
  }

  function ouvrirMenu(btn, p, apres) {
    const r = regles();
    if (!r) return;
    fermerMenu();

    const menu = document.createElement("div");
    menu.className = "nc-menu";
    menu.setAttribute("role", "menu");
    const question = document.createElement("div");
    question.className = "nc-menu-question";
    question.textContent = "Voulez-vous ajouter ici :";
    menu.appendChild(question);
    ajouterChoix(menu, "Un markdown", { ok: true, raison: "" },
      () => r.insererApres(p, apres, "markdown"));
    ajouterChoix(menu, "Une zone de code", r.peutInsererCode(p, apres),
      () => r.insererApres(p, apres, "code"));
    document.body.appendChild(menu);

    // Sous le "+", centré ; au-dessus s'il n'y a pas la place en bas.
    const rect = btn.getBoundingClientRect();
    const largeur = menu.offsetWidth;
    const hauteur = menu.offsetHeight;
    let gauche = rect.left + rect.width / 2 - largeur / 2;
    gauche = Math.max(8, Math.min(gauche, window.innerWidth - largeur - 8));
    let haut = rect.bottom + 4;
    if (haut + hauteur > window.innerHeight - 8) haut = Math.max(8, rect.top - hauteur - 4);
    menu.style.left = `${Math.round(gauche)}px`;
    menu.style.top = `${Math.round(haut)}px`;

    menuOuvert = menu;
    document.addEventListener("mousedown", surMousedownHorsMenu, true);
    document.addEventListener("keydown", surToucheMenu, true);
    window.addEventListener("resize", fermerMenu);
    const zone = document.getElementById("zonePython");
    if (zone) zone.addEventListener("scroll", fermerMenu, { passive: true });
  }

  // ── Fenêtre du ✂ d'une zone de code ──────────────────────────────────────
  function ouvrirDialogueCoupe(p) {
    const r = regles();
    const gestionnaire = pm();
    if (!r || !gestionnaire) return;
    fermerMenu();

    const total = gestionnaire.getPagesCount();
    const n = r.nombreMarkdowns(p);
    const numero = `${p + 1}/${total}`;
    const verdictCode = r.peutCouperCode(p, "code");

    const fond = document.createElement("div");
    fond.className = "nc-dialog-fond";
    const boite = document.createElement("div");
    boite.className = "nc-dialog";
    boite.setAttribute("role", "dialog");
    boite.setAttribute("aria-modal", "true");

    const titre = document.createElement("div");
    titre.className = "nc-dialog-titre";
    titre.textContent = `Supprimer la zone de code de la page ${numero}`;
    boite.appendChild(titre);

    const question = document.createElement("p");
    question.className = "nc-dialog-question";
    question.textContent =
      `Voulez-vous supprimer toute la page ${numero} (= ${pluriel(n, "markdown")} + zone de code) ` +
      "ou uniquement la zone de code ?";
    boite.appendChild(question);

    const cases = [];
    function ajouterCase(valeur, texte, verdict) {
      const ligne = document.createElement("label");
      ligne.className = "nc-dialog-choix";
      const caseACocher = document.createElement("input");
      caseACocher.type = "checkbox";
      caseACocher.value = valeur;
      if (!verdict.ok) {
        caseACocher.disabled = true;
        ligne.classList.add("is-disabled");
      }
      const libelle = document.createElement("span");
      libelle.textContent = texte;
      ligne.appendChild(caseACocher);
      ligne.appendChild(libelle);
      boite.appendChild(ligne);
      if (!verdict.ok) {
        const note = document.createElement("div");
        note.className = "nc-dialog-note";
        note.textContent = verdict.raison;
        boite.appendChild(note);
      }
      cases.push(caseACocher);
    }

    ajouterCase("page",
      `Toute la page ${numero} : ${n > 1 ? `ses ${pluriel(n, "markdown")}` : "son markdown"} et sa zone de code`,
      { ok: true, raison: "" });
    ajouterCase("code",
      `Uniquement la zone de code : ${n > 1 ? `ses ${pluriel(n, "markdown")} rejoignent` : "son markdown rejoint"} la page suivante`,
      verdictCode);

    const actions = document.createElement("div");
    actions.className = "nc-dialog-actions";
    const annuler = document.createElement("button");
    annuler.type = "button";
    annuler.className = "nc-dialog-btn";
    annuler.textContent = "Annuler";
    const valider = document.createElement("button");
    valider.type = "button";
    valider.className = "nc-dialog-btn nc-dialog-btn-danger";
    valider.textContent = "Supprimer";
    valider.disabled = true;
    actions.appendChild(annuler);
    actions.appendChild(valider);
    boite.appendChild(actions);

    // Cases exclusives : en cocher une décoche l'autre.
    cases.forEach((c) => {
      c.addEventListener("change", () => {
        if (c.checked) cases.forEach((autre) => { if (autre !== c) autre.checked = false; });
        valider.disabled = !cases.some((x) => x.checked);
      });
    });

    function fermer() {
      fond.remove();
      document.removeEventListener("keydown", surTouche, true);
    }
    function confirmer() {
      const choisi = cases.find((x) => x.checked);
      if (!choisi) return;
      fermer();
      r.couperZoneCode(p, choisi.value);
    }
    function surTouche(e) {
      if (e.key === "Escape") { e.preventDefault(); fermer(); }
      else if (e.key === "Enter" && !valider.disabled) { e.preventDefault(); confirmer(); }
    }

    annuler.addEventListener("click", fermer);
    valider.addEventListener("click", confirmer);
    fond.addEventListener("mousedown", (e) => { if (e.target === fond) fermer(); });
    document.addEventListener("keydown", surTouche, true);

    fond.appendChild(boite);
    document.body.appendChild(fond);
    annuler.focus({ preventScroll: true });
  }

  // ── Clics ────────────────────────────────────────────────────────────────
  // mousedown : ni perte de focus (un markdown en cours d'édition garde sa
  // hauteur sous la souris), ni activation de page par le ruban.
  function surMousedown(e) {
    const btn = e.target && e.target.closest ? e.target.closest(".nc-ctrl") : null;
    if (btn) e.preventDefault();
  }

  function surClic(e) {
    const btn = e.target && e.target.closest ? e.target.closest(".nc-ctrl") : null;
    if (!btn) return;
    // Zone vive : les boutons des markdowns ont leurs écouteurs (markdown.js).
    if (btn.closest(".md-block") && !btn.closest(".sc-fac")) return;
    e.preventDefault();
    e.stopPropagation();

    const r = regles();
    if (!r) return;
    if (btn.classList.contains("is-disabled")) return;
    if (structureVerrouillee()) return;
    if (executionEnCours()) {
      alert("Une exécution est en cours : attendez qu'elle se termine pour modifier les cellules.");
      return;
    }

    const p = indexPage(btn);
    if (p < 0) return;
    const gestionnaire = pm();

    if (btn.classList.contains("nc-sep-btn")) {
      const sep = btn.closest(".nc-sep");
      if (sep.dataset.apres === "debut") {
        ouvrirMenu(btn, p, "debut");
        return;
      }
      if (sep.dataset.apres === "code") {
        if (p === gestionnaire.getPagesCount() - 1) {
          r.insererApres(p, "code", "markdown");
        } else {
          ouvrirMenu(btn, p, "code");
        }
        return;
      }
      const j = indexMarkdownAvant(sep);
      if (j >= 0) ouvrirMenu(btn, p, j);
      return;
    }

    if (btn.classList.contains("nc-code-cut")) { ouvrirDialogueCoupe(p); return; }
    if (btn.classList.contains("nc-code-up")) { r.deplacerZoneCode(p, -1); return; }
    if (btn.classList.contains("nc-code-down")) { r.deplacerZoneCode(p, +1); return; }

    // Boutons des markdowns d'une page inactive (fac-similé du ruban).
    const bloc = btn.closest(".md-block");
    const j = indexMarkdown(bloc);
    if (j < 0) return;
    if (btn.classList.contains("md-btn-cut")) r.couperMarkdown(p, j);
    else if (btn.classList.contains("md-btn-up")) r.deplacerMarkdown(p, j, -1);
    else if (btn.classList.contains("md-btn-down")) r.deplacerMarkdown(p, j, +1);
  }

  // ── Démarrage ────────────────────────────────────────────────────────────
  function demarrer() {
    document.body.classList.add("notebook-cellules");
    poserSepCodeVif();
    document.addEventListener("mousedown", surMousedown, true);
    document.addEventListener("click", surClic);
    surveillerVerrou();

    // L'éditeur (et donc la barre de code vive) arrive un peu plus tard.
    let essais = 0;
    const attente = setInterval(() => {
      essais++;
      const pret = window.pythonEditor && pm() && pm().cellules;
      if (pret || essais > 400) {
        clearInterval(attente);
        if (!pret) return;
        surveillerExecution();
        const conteneur = document.getElementById("markdownsContainer");
        if (conteneur && conteneur.querySelector(".md-block")) insererSeparateursMd(conteneur);
        majEtatsVifs();
      }
    }, 50);
  }

  window.NotebookCellules = {
    creerSeparateur,
    creerBarreCode,
    insererSeparateursMd,
    apresRenduMarkdowns,
    majEtatsVifs,
    majEtatsFacsimile
  };

  // Le "+" sous le code doit exister avant que le ruban ne déplace la zone
  // vive : posé dès maintenant (script defer, le document est déjà lu).
  poserSepCodeVif();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", demarrer);
  } else {
    demarrer();
  }
})();
