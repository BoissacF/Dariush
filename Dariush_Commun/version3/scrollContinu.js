/*
  scrollContinu.js
  --------------------------------------------------------------------------
  Notebook continu : tout le document est chargé en une fois.

  Le ruban #scRuban (dans #zonePython) contient UNE section par page, dans
  l'ordre, posées une fois pour toutes : au défilement on voit un texte
  continu, pas des pages qui se reconstruisent. Chaque section affiche le
  markdown rendu, le code colorié (CodeMirror en lecture seule) et la
  dernière sortie : du texte, pas du code actif.

  La zone de travail réelle (markdownsContainer + mainSplit : éditeur,
  sortie, exécution) reste UNIQUE : elle est simplement transplantée DANS la
  section de la page active. À la bascule, seules deux sections changent de
  contenu, SUR PLACE : l'ancienne page active redevient un fac-similé de
  même hauteur, la nouvelle reçoit la zone vive. Rien d'autre ne bouge, et
  l'écart résiduel de hauteur est compensé au pixel : pas de saut.

  - Page active = celle qui contient le milieu de l'écran (ligne médiane).
    Le numéro en bas suit pendant le défilement ; la bascule réelle se fait
    à l'arrêt du défilement (~160 ms), avec hystérésis : après une bascule il
    faut un vrai déplacement (> 48 px) avant d'en évaluer une autre — pas
    d'aller-retour 4/5/4/5.
  - Clic dans une section inactive : active sa page (curseur posé au clic).
  - Zoom (Ctrl+molette, panneau zoom) : répercuté sur toutes les sections.
  - Navigation verrouillée (groupe / aide) : les sections inactives sont
    masquées, on retrouve le comportement une-page actuel.

  Module autonome : ne fait RIEN si window.SCROLL_CONTINU_ACTIF !== true
  (Dariush Linux ne pose pas ce drapeau et garde scrollFlipPage).

  Intégration (après pagesmultiples.js) :
     <script defer src="../Dariush_Commun/version3/scrollContinu.js?v=NNNN"></script>
  --------------------------------------------------------------------------
*/
(function () {
  "use strict";

  const DEBUG = false;

  // ── Réglages ─────────────────────────────────────────────────────────────
  const SETTLE_MS = 160;            // immobilité du scroll avant bascule réelle
  const SEUIL_HYSTERESIS_PX = 48;   // déplacement mini avant nouvelle évaluation
  const REBUILD_DEBOUNCE_MS = 100;  // regroupement des changements externes

  // ── État ─────────────────────────────────────────────────────────────────
  let zonePython = null;
  let rubanEl = null;           // #scRuban
  let sections = [];            // [{el, cm}] ; cm = CodeMirror du fac-similé, null si vive
  let indiceLive = 0;           // index de la section qui contient la zone vive
  let mdEngine = null;

  let settleTimer = null;
  let rebuildTimer = null;
  let enActivation = false;
  let ignoreScrollJusqua = 0;   // ignorer nos propres scrollTop / reflows
  let scrollReference = 0;      // position d'ancrage pour l'hystérésis
  let verrouPrecedent = null;

  function log() {
    if (!DEBUG) return;
    console.log.apply(console, ["[scrollContinu]"].concat([].slice.call(arguments)));
  }

  function maintenantMs() {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
  }

  function pm() { return window.PagesMultiples || null; }

  function editeur() { return window.pythonEditor || null; }

  // Même règle que pageScrollbar.js : groupe ou aide => navigation inerte.
  function navAutorisee() {
    if (window.__groupNavLocked === true) return false;
    if (typeof window.groupeJoined === "function" && window.groupeJoined()) return false;
    if (window.__aideConnecte === true) return false;
    return true;
  }

  // ── Moteur markdown local (mêmes options que markdown.js) ────────────────
  function getEngine() {
    if (mdEngine) return mdEngine;
    if (typeof window.markdownit !== "function") return null;

    mdEngine = window.markdownit({
      html: true,
      linkify: true,
      breaks: false,
      typographer: false
    });

    if (typeof window.texmath === "function" && window.katex) {
      mdEngine.use(window.texmath, {
        engine: window.katex,
        delimiters: "dollars",
        katexOptions: { throwOnError: false }
      });
    }

    return mdEngine;
  }

  function rendreMarkdown(texte) {
    const engine = getEngine();
    if (!engine) {
      return String(texte ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
    }
    return engine.render(String(texte ?? ""));
  }

  // Même nettoyage léger que markdown.js (copie locale : fonction privée là-bas).
  function nettoyerApercu(root) {
    if (!root) return;
    root.querySelectorAll("script, iframe, object, embed, meta, base").forEach((el) => {
      el.remove();
    });
    root.querySelectorAll("*").forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "");
        if (name.startsWith("on")) { el.removeAttribute(attr.name); return; }
        if ((name === "src" || name === "href") && /^javascript:/i.test(value.trim())) {
          el.removeAttribute(attr.name);
        }
      });
    });
  }

  // Images "attachment:" : résolues depuis page.images (pages non actives
  // comprises, contrairement à GestionImages qui ne voit que la page active).
  function remplacerImagesAttachment(root, page) {
    if (!root) return;
    const images = (page && page.images && typeof page.images === "object")
      ? page.images : {};
    root.querySelectorAll('img[src^="attachment:"]').forEach((img) => {
      const rawSrc = String(img.getAttribute("src") || "");
      const imageName = rawSrc.slice("attachment:".length).trim();
      const dataUrl = String(images[imageName] || "");
      if (dataUrl) {
        img.setAttribute("src", dataUrl);
        img.classList.add("exercise-md-img");
        return;
      }
      const fallback = document.createElement("span");
      fallback.className = "exercise-md-img-error";
      fallback.textContent = `[image "${imageName}" introuvable]`;
      img.replaceWith(fallback);
    });
  }

  // Marqueurs [AIDE:x] / [REP:x] / [FINREP:x] : même rendu que markdown.js
  // (les boutons restent fonctionnels : markdown.js écoute .aide-btn au
  // niveau document).
  function transformerMarqueursAide(root) {
    if (!root) return;
    const RE = /\[(AIDE|REP|FINREP):([A-Za-z0-9_\-]+)\]/g;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      RE.lastIndex = 0;
      if (RE.test(node.nodeValue)) targets.push(node);
    }
    targets.forEach((textNode) => {
      const text = textNode.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      RE.lastIndex = 0;
      while ((m = RE.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const type = m[1], code = m[2];
        if (type === "AIDE") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "aide-btn";
          btn.dataset.aideCode = code;
          btn.textContent = "💡 Aide IA";
          frag.appendChild(btn);
        } else if (type === "REP") {
          const span = document.createElement("span");
          span.className = "rep-label";
          span.dataset.repCode = code;
          span.textContent = "✓ réponse";
          frag.appendChild(span);
        } else {
          const span = document.createElement("span");
          span.className = "finrep-label";
          span.dataset.finrepCode = code;
          span.textContent = "◼";
          frag.appendChild(span);
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  // ── Fac-similé : contenu d'une section inactive ──────────────────────────
  // Reprend les classes CSS du vrai système (md-block, exercise-preview,
  // two-cols, output...) pour une hauteur et un rendu identiques : l'échange
  // fac-similé <-> zone vive doit être invisible.

  function construireBarreOutilsInerte() {
    const toolbar = document.createElement("div");
    toolbar.className = "comment-toolbar md-block-toolbar";
    toolbar.style.pointerEvents = "none";
    ["+", "✂", "↑", "↓", "—"].forEach((txt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "comment-toggle-btn";
      btn.tabIndex = -1;
      btn.textContent = txt;
      toolbar.appendChild(btn);
    });
    return toolbar;
  }

  function construireBlocMarkdown(texte, page) {
    const block = document.createElement("div");
    block.className = "md-block";

    block.appendChild(construireBarreOutilsInerte());

    const wrap = document.createElement("div");
    wrap.className = "exercise-text-wrap md-block-wrap";

    const preview = document.createElement("div");
    preview.className = "exercise-preview md-block-preview sc-md";

    const normalise = String(texte ?? "").replace(/\r\n/g, "\n").trim();
    if (!normalise) {
      preview.textContent = "Entrez du texte ou collez une image";
      preview.classList.add("is-empty");
    } else {
      preview.innerHTML = rendreMarkdown(texte);
      remplacerImagesAttachment(preview, page);
      nettoyerApercu(preview);
      transformerMarqueursAide(preview);
    }

    wrap.appendChild(preview);
    block.appendChild(wrap);
    return block;
  }

  function layoutHorizontalActif() {
    const mainSplit = document.getElementById("mainSplit");
    return !!(mainSplit && mainSplit.classList.contains("horizontal-layout"));
  }

  // Même hauteur "définie" que l'éditeur vif : la formule est reprise
  // d'ajusterHauteurEditeurHorizontal (interpreteur.js / sqlInterpreteur.js) —
  // max(6 lignes, contenu + 3 lignes). Indispensable pour que l'échange
  // fac-similé <-> zone vive se fasse sans variation de hauteur.
  function ajusterHauteurFacsimile(cm) {
    if (!cm) return;
    const scroller = cm.getScrollerElement();
    const wrapper = cm.getWrapperElement();
    if (!scroller || !wrapper) return;

    const lastLine = Math.max(0, cm.lineCount() - 1);
    const lastLineTop = cm.heightAtLine(lastLine, "local");
    const lineHeight = cm.defaultTextHeight();
    const extraPixels = lineHeight * 2;

    const wantedHeight = Math.max(
      6 * lineHeight,
      lastLineTop + lineHeight + extraPixels
    );

    scroller.style.height = wantedHeight + "px";
    wrapper.style.height = wantedHeight + "px";
    scroller.style.overflowY = "hidden";
    scroller.style.overflowX = "auto";

    cm.refresh();
  }

  // Remplit la section d'index donné avec un fac-similé de sa page
  // (la section doit être vide de la zone vive).
  function remplirFacsimile(section, index) {
    const gestionnaire = pm();
    const edit = editeur();
    const page = (gestionnaire && typeof gestionnaire.getPageRef === "function")
      ? gestionnaire.getPageRef(index) : null;

    section.el.textContent = "";
    section.el.classList.add("sc-fac");
    section.el.classList.remove("sc-live");
    section.cm = null;
    if (!page) return;

    // 1. Blocs markdown.
    const mds = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page.comment || "")];
    const zoneMds = document.createElement("div");
    zoneMds.className = "sc-mds";
    mds.forEach((texte) => zoneMds.appendChild(construireBlocMarkdown(texte, page)));
    section.el.appendChild(zoneMds);

    // 2. Code + sortie, avec la même structure que #mainSplit.
    const horizontal = layoutHorizontalActif();
    const mainSplit = document.getElementById("mainSplit");

    const split = document.createElement("div");
    split.className = mainSplit ? mainSplit.className : "two-cols";
    if (mainSplit && mainSplit.style.gridTemplateColumns) {
      split.style.gridTemplateColumns = mainSplit.style.gridTemplateColumns;
    }

    const leftCol = document.createElement("div");
    leftCol.className = "left-col";
    const editorContainer = document.createElement("div");
    editorContainer.className = "editor-container";
    leftCol.appendChild(editorContainer);

    const sortieTexte = (gestionnaire && typeof gestionnaire.getPageOutputText === "function")
      ? gestionnaire.getPageOutputText(index) : "";

    if (window.CodeMirror && edit) {
      section.cm = new window.CodeMirror(editorContainer, {
        value: String(page.code || ""),
        mode: edit.getOption("mode"),
        theme: edit.getOption("theme"),
        lineNumbers: true,
        indentUnit: edit.getOption("indentUnit") || 4,
        readOnly: "nocursor",
        viewportMargin: Infinity
      });
      // Mêmes styles EN LIGNE que l'éditeur vif (updateEditorLayoutMode) :
      // indispensable, car le CSS de CodeMirror (height:300px) est chargé
      // APRÈS style.css et gagnerait sinon sur les fac-similés.
      const wrapperFac = section.cm.getWrapperElement();
      const scrollerFac = section.cm.getScrollerElement();
      if (wrapperFac) {
        wrapperFac.style.height = "auto";
        wrapperFac.style.flex = "0 0 auto";
        const wrapperVif = edit.getWrapperElement();
        if (wrapperVif && wrapperVif.style.fontSize) {
          wrapperFac.style.fontSize = wrapperVif.style.fontSize;
        }
      }
      if (scrollerFac) {
        scrollerFac.style.overflowY = "hidden";
        scrollerFac.style.overflowX = "auto";
      }
    } else {
      // Secours improbable : CodeMirror absent, simple <pre>.
      const pre = document.createElement("pre");
      pre.className = "sc-code-brut";
      pre.textContent = String(page.code || "");
      editorContainer.appendChild(pre);
    }

    if (horizontal) {
      // Mode horizontal : sortie sous l'éditeur, pas de colonne droite.
      // Mêmes dimensions que #horizontalOutputWrap / #outputhorizontal
      // (règles .sc-horiz-wrap / .sc-output-h dans style.css).
      const wrapSortie = document.createElement("div");
      wrapSortie.className = "sc-horiz-wrap";
      const sortie = document.createElement("div");
      sortie.className = "output sc-output sc-output-h";
      sortie.textContent = sortieTexte;
      wrapSortie.appendChild(sortie);
      leftCol.appendChild(wrapSortie);
      split.appendChild(leftCol);
    } else {
      split.appendChild(leftCol);

      const resizer = document.createElement("div");
      resizer.className = "col-resizer";
      resizer.style.pointerEvents = "none";
      split.appendChild(resizer);

      const rightCol = document.createElement("div");
      rightCol.className = "right-col";
      const sortie = document.createElement("div");
      sortie.className = "output sc-output";
      sortie.textContent = sortieTexte;
      rightCol.appendChild(sortie);
      split.appendChild(rightCol);
    }

    section.el.appendChild(split);
    if (section.cm) {
      section.cm.refresh();
      ajusterHauteurFacsimile(section.cm);
    }
  }

  // ── Transplantation de la zone vive, SUR PLACE ───────────────────────────
  function widgetsVifs() {
    return {
      mdc: document.getElementById("markdownsContainer"),
      split: document.getElementById("mainSplit")
    };
  }

  // Déplace la zone vive dans la section j ; l'ancienne section vive est
  // re-remplie en fac-similé depuis le modèle (déjà sauvegardé par
  // loadPageIntoEditor). Seules ces DEUX sections changent, sur place.
  function deplacerLiveVers(j) {
    if (j < 0 || j >= sections.length) return;
    const { mdc, split } = widgetsVifs();
    if (!mdc || !split) return;

    const ancienIndice = indiceLive;
    const secJ = sections[j];

    secJ.el.textContent = "";
    secJ.cm = null;
    secJ.el.classList.remove("sc-fac");
    secJ.el.classList.add("sc-live");
    secJ.el.appendChild(mdc);   // appendChild retire d'office de l'ancienne section
    secJ.el.appendChild(split);

    indiceLive = j;

    if (ancienIndice !== j && sections[ancienIndice]) {
      remplirFacsimile(sections[ancienIndice], ancienIndice);
    }
  }

  // ── Construction complète du ruban (init, ajout/suppression de page) ─────
  function construireRuban() {
    const gestionnaire = pm();
    if (!gestionnaire || !rubanEl) return;

    // Mettre la zone vive à l'abri avant de vider le ruban.
    const { mdc, split } = widgetsVifs();
    if (mdc && rubanEl.contains(mdc)) zonePython.insertBefore(mdc, rubanEl);
    if (split && rubanEl.contains(split)) zonePython.insertBefore(split, rubanEl);

    rubanEl.textContent = "";
    sections = [];

    const total = gestionnaire.getPagesCount();
    const actif = gestionnaire.getActivePageIndex();

    for (let i = 0; i < total; i++) {
      const el = document.createElement("div");
      el.className = "sc-section";
      el.dataset.scIndex = String(i);
      rubanEl.appendChild(el);
      sections.push({ el, cm: null });
    }

    indiceLive = actif;
    const secActive = sections[actif];
    if (secActive) {
      secActive.el.classList.add("sc-live");
      if (mdc) secActive.el.appendChild(mdc);
      if (split) secActive.el.appendChild(split);
    }

    for (let i = 0; i < total; i++) {
      if (i !== actif) remplirFacsimile(sections[i], i);
    }

    const edit = editeur();
    if (edit) edit.refresh();

    majVisibiliteVerrou();
    appliquerStyleEditeurReel();
    log("ruban construit :", total, "sections, page active", actif + 1);
  }

  // ── Verrou groupe / aide : une seule page visible ────────────────────────
  function majVisibiliteVerrou() {
    const verrou = navAutorisee();
    sections.forEach((s, i) => {
      s.el.style.display = (verrou || i === indiceLive) ? "" : "none";
    });
    verrouPrecedent = verrou;
  }

  // ── Zoom / thème : répercuter l'éditeur réel sur les fac-similés ─────────
  function appliquerStyleEditeurReel() {
    const edit = editeur();
    if (!edit) return;

    // Un changement de taille fait grandir/rétrécir tout le document : le
    // navigateur émet des scrolls de reflow qui ne sont pas un déplacement
    // voulu par l'élève. On les ignore, et on réarme l'hystérésis après.
    ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + 450);
    setTimeout(armerHysteresis, 460);

    const wrapper = edit.getWrapperElement();
    const fontSize = wrapper ? wrapper.style.fontSize : "";
    const theme = edit.getOption("theme");

    sections.forEach((s) => {
      if (s.cm) {
        const w = s.cm.getWrapperElement();
        if (w && w.style.fontSize !== fontSize) w.style.fontSize = fontSize;
        if (s.cm.getOption("theme") !== theme) s.cm.setOption("theme", theme);
        s.cm.refresh();
        ajusterHauteurFacsimile(s.cm);
      }
      s.el.querySelectorAll(".sc-md, .sc-output, .sc-code-brut").forEach((el) => {
        el.style.fontSize = fontSize;
      });
    });
  }

  function observerStyleEditeurReel() {
    const edit = editeur();
    if (!edit) return;
    const wrapper = edit.getWrapperElement();
    if (!wrapper) return;
    const obs = new MutationObserver(() => appliquerStyleEditeurReel());
    obs.observe(wrapper, { attributes: true, attributeFilter: ["style", "class"] });
  }

  // Disposition changée (bascule horizontal/vertical, colonnes
  // redimensionnées) : les fac-similés doivent reprendre la même structure,
  // sinon leurs hauteurs ne correspondent plus à la zone vive.
  let dispositionTimer = null;
  function observerDisposition() {
    const mainSplit = document.getElementById("mainSplit");
    if (!mainSplit) return;
    const obs = new MutationObserver(() => {
      if (dispositionTimer) clearTimeout(dispositionTimer);
      dispositionTimer = setTimeout(() => {
        dispositionTimer = null;
        ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + 450);
        sections.forEach((s, i) => {
          if (i !== indiceLive) remplirFacsimile(s, i);
        });
        appliquerStyleEditeurReel();
        setTimeout(armerHysteresis, 460);
      }, 200);
    });
    obs.observe(mainSplit, { attributes: true, attributeFilter: ["style", "class"] });
  }

  // ── Géométrie ────────────────────────────────────────────────────────────
  function pageAuMilieu() {
    if (!sections.length) return indiceLive;
    const zpRect = zonePython.getBoundingClientRect();
    const milieu = zpRect.top + zonePython.clientHeight / 2;

    let resultat = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].el.getBoundingClientRect().top <= milieu) resultat = i;
      else break;
    }
    return resultat;
  }

  function poserScroll(valeur) {
    ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + 80);
    zonePython.scrollTop = valeur;
  }

  function armerHysteresis() {
    scrollReference = zonePython.scrollTop;
  }

  // Ramène le haut de la section el à la position écran ancreViewport
  // (coordonnées viewport mesurées AVANT l'échange de contenu).
  function compenser(el, ancreViewport) {
    const delta = el.getBoundingClientRect().top - ancreViewport;
    if (Math.abs(delta) > 0.5) poserScroll(zonePython.scrollTop + delta);
  }

  // ── Indicateur "n/N" en bas pendant le défilement ────────────────────────
  function majIndicateurDefilement(indiceMedian) {
    const gestionnaire = pm();
    const indicateur = document.getElementById("pagesMultiplesIndicator");
    if (!gestionnaire || !indicateur) return;
    const texte = `${indiceMedian + 1}/${gestionnaire.getPagesCount()}`;
    if (indicateur.textContent !== texte) indicateur.textContent = texte;
  }

  // ── Bascule réelle vers une page (scroll posé ou clic) ───────────────────
  function activerPage(nouvelIndice, options = {}) {
    const gestionnaire = pm();
    const edit = editeur();
    if (!gestionnaire || !edit || enActivation) return;
    if (nouvelIndice === indiceLive) return;
    if (nouvelIndice < 0 || nouvelIndice >= sections.length) return;
    if (!navAutorisee()) return;

    enActivation = true;
    const secJ = sections[nouvelIndice].el;
    const ancre = secJ.getBoundingClientRect().top;

    log("activation page", nouvelIndice + 1);

    // Sauvegarde la page quittée (code, markdowns, sortie) et charge la
    // nouvelle dans la zone vive. En mode ruban, loadPageIntoEditor ne touche
    // ni au scroll ni au focus (voir pagesmultiples.js).
    gestionnaire.loadPageIntoEditor(nouvelIndice);
    deplacerLiveVers(nouvelIndice);
    edit.refresh();
    compenser(secJ, ancre);
    appliquerStyleEditeurReel();

    requestAnimationFrame(() => {
      compenser(secJ, ancre);
      if (options.focus) {
        edit.focus();
        if (options.curseur) edit.setCursor(options.curseur, null, { scroll: false });
        compenser(secJ, ancre);
      }
    });

    setTimeout(() => {
      compenser(secJ, ancre);
      armerHysteresis();
      enActivation = false;
    }, 250);
  }

  // ── Défilement : indicateur en direct + bascule à l'arrêt ────────────────
  function surScroll() {
    if (maintenantMs() < ignoreScrollJusqua) return;
    if (!navAutorisee() || sections.length <= 1) return;

    // Hystérésis : tant qu'on n'a pas vraiment bougé depuis le dernier
    // ancrage, on ne réévalue rien (évite les allers-retours de pages).
    if (Math.abs(zonePython.scrollTop - scrollReference) < SEUIL_HYSTERESIS_PX) return;

    majIndicateurDefilement(pageAuMilieu());

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (enActivation) return;
      if (maintenantMs() < ignoreScrollJusqua) return;
      const cible = pageAuMilieu();
      if (cible !== indiceLive) activerPage(cible, {});
      else majIndicateurDefilement(cible);
    }, SETTLE_MS);
  }

  // ── Clic dans une section inactive : activation ──────────────────────────
  function surMousedown(e) {
    const secEl = e.target && e.target.closest ? e.target.closest(".sc-section") : null;
    if (!secEl) return;
    const j = sections.findIndex((s) => s.el === secEl);
    if (j < 0 || j === indiceLive) return;
    if (!navAutorisee()) return;
    if (e.target.closest("a, .aide-btn")) return;
    e.preventDefault();

    // Clic dans le code : mémoriser la position pour y poser le curseur.
    let posCurseur = null;
    const cm = sections[j].cm;
    if (cm) {
      const wrapper = cm.getWrapperElement();
      if (wrapper && wrapper.contains(e.target)) {
        posCurseur = cm.coordsChar({ left: e.clientX, top: e.clientY }, "window");
      }
    }
    activerPage(j, { focus: true, curseur: posCurseur });
  }

  // ── Changements externes (boutons, barre latérale, import, groupe...) ────
  function surChangementExterne() {
    const gestionnaire = pm();
    if (!gestionnaire) return;

    const total = gestionnaire.getPagesCount();
    const actif = gestionnaire.getActivePageIndex();

    // Nombre de pages changé (ajout, suppression, import) : tout refaire.
    if (total !== sections.length) {
      construireRuban();
      allerAuDebutDeSection(indiceLive);
      return;
    }

    // Page active changée hors ruban (boutons, barre latérale, groupe...).
    if (actif !== indiceLive) {
      if (enActivation) return; // notre propre bascule, déjà gérée
      deplacerLiveVers(actif);
      const edit = editeur();
      if (edit) edit.refresh();
      majVisibiliteVerrou();
      appliquerStyleEditeurReel();
      allerAuDebutDeSection(actif);
      return;
    }

    // Verrou groupe/aide posé ou levé.
    if (navAutorisee() !== verrouPrecedent) majVisibiliteVerrou();
  }

  function allerAuDebutDeSection(j) {
    const sec = sections[j];
    if (!sec) return;
    poserScroll(sec.el.offsetTop);
    requestAnimationFrame(() => {
      poserScroll(sec.el.offsetTop);
      armerHysteresis();
    });
    setTimeout(armerHysteresis, 300);
  }

  function observerIndicateur() {
    const indicateur = document.getElementById("pagesMultiplesIndicator");
    if (!indicateur) return;
    const obs = new MutationObserver(() => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        rebuildTimer = null;
        surChangementExterne();
      }, REBUILD_DEBOUNCE_MS);
    });
    obs.observe(indicateur, { childList: true, subtree: true, characterData: true });
  }

  // ── Zoom Ctrl+molette au-dessus des fac-similés ──────────────────────────
  // On rejoue l'événement sur l'éditeur réel : c'est lui qui porte la logique
  // de zoom (interpreteur.js / sqlInterpreteur.js), et notre observateur de
  // style répercute ensuite la nouvelle taille partout.
  function surMoletteFacsimile(e) {
    if (!e.ctrlKey) return;
    // Dans la section vive, l'éditeur et les sorties ont déjà leurs propres
    // écouteurs : ne pas rejouer (sinon boucle d'événements).
    const secEl = e.target && e.target.closest ? e.target.closest(".sc-section") : null;
    if (secEl && sections[indiceLive] && secEl === sections[indiceLive].el) return;
    e.preventDefault();
    const edit = editeur();
    if (!edit) return;
    const wrapper = edit.getWrapperElement();
    if (!wrapper) return;
    wrapper.dispatchEvent(new WheelEvent("wheel", {
      deltaY: e.deltaY,
      ctrlKey: true,
      cancelable: true
    }));
  }

  // ── Initialisation ───────────────────────────────────────────────────────
  function demarrer() {
    zonePython = document.getElementById("zonePython");
    if (!zonePython) { log("zonePython introuvable"); return; }

    const gestionnaire = pm();
    if (!gestionnaire || typeof gestionnaire.getPageRef !== "function") {
      log("PagesMultiples.getPageRef absent : module inactif");
      return;
    }

    const { split } = widgetsVifs();
    if (!split) { log("mainSplit introuvable"); return; }

    // Repère pour offsetTop des sections.
    if (!zonePython.style.position) zonePython.style.position = "relative";

    // Le ruban prend la place de mainSplit dans le flux ; les zones de chat
    // et l'ancien système mono-bloc restent au-dessus, hors du ruban.
    rubanEl = document.createElement("div");
    rubanEl.id = "scRuban";
    zonePython.insertBefore(rubanEl, split);

    rubanEl.addEventListener("mousedown", surMousedown);
    rubanEl.addEventListener("wheel", surMoletteFacsimile, { passive: false });
    zonePython.addEventListener("scroll", surScroll, { passive: true });

    observerIndicateur();
    observerStyleEditeurReel();
    observerDisposition();
    construireRuban();
    armerHysteresis();

    log("initialisé.");
  }

  function attendrePuisDemarrer() {
    let essais = 0;
    const timer = setInterval(() => {
      essais++;
      const pret = window.PagesMultiples &&
        typeof window.PagesMultiples.getPagesCount === "function" &&
        window.pythonEditor &&
        document.getElementById("zonePython");
      if (pret) {
        clearInterval(timer);
        demarrer();
        return;
      }
      if (essais > 200) {
        clearInterval(timer);
        log("initialisation abandonnée (éditeur ou PagesMultiples introuvable)");
      }
    }, 50);
  }

  function init() {
    if (window.SCROLL_CONTINU_ACTIF !== true) {
      log("drapeau SCROLL_CONTINU_ACTIF absent : module inactif");
      return;
    }
    attendrePuisDemarrer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
