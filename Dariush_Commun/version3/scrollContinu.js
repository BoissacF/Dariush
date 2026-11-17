/*
  scrollContinu.js
  --------------------------------------------------------------------------
  Défilement continu façon "vrai notebook" (ruban de pages).

  Principe : la zone de travail réelle (markdowns, éditeur CodeMirror, zone
  d'exécution) reste UNIQUE et à sa place dans #zonePython. Autour d'elle, ce
  module insère des fac-similés des autres pages (texte rendu + code colorié
  inertes) dans deux conteneurs : #scPagesAvant (pages précédentes) et
  #scPagesApres (pages suivantes). On peut donc faire défiler plusieurs pages
  à l'écran, y compris plusieurs pages courtes à la fois.

  - La page ACTIVE est celle qui contient le milieu de l'écran (ligne médiane).
    Le numéro en bas suit cette règle pendant le défilement.
  - Quand le défilement se pose (~180 ms d'immobilité) sur une autre page,
    on bascule réellement : loadPageIntoEditor + reconstruction des
    fac-similés + compensation du scroll pour que rien ne saute.
  - Un clic dans un fac-similé active sa page (curseur posé où l'on a cliqué).
  - Le zoom (Ctrl+molette ou panneau zoom) s'applique aussi aux fac-similés :
    on observe la taille de police de l'éditeur réel et on la répercute.
  - Si la navigation est verrouillée (groupe / aide), les fac-similés sont
    masqués : on retrouve exactement le comportement une-page actuel.

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
  const SETTLE_MS = 180;        // immobilité du scroll avant bascule réelle
  const REBUILD_DEBOUNCE_MS = 80; // regroupement des changements externes
  const MARGE_SEPARATEUR = 0;   // ancrage du haut de page lors d'une bascule externe

  // ── État ─────────────────────────────────────────────────────────────────
  let zonePython = null;
  let conteneurAvant = null;    // #scPagesAvant
  let conteneurApres = null;    // #scPagesApres
  let facsimiles = [];          // [{index, el, cm}] dans l'ordre du DOM
  let mdEngine = null;          // instance markdown-it locale au module

  let settleTimer = null;
  let rebuildTimer = null;
  let enActivation = false;     // bascule interne en cours
  let ignoreScrollJusqua = 0;   // timestamp : ignorer nos propres scrollTop
  let ancrageTimeouts = [];     // corrections de scroll en attente (annulables)
  let dernierIndiceConstruit = -1;
  let dernierTotalConstruit = -1;
  let verrouPrecedent = null;   // dernier état connu du verrou de navigation

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

  // ── Construction d'un fac-similé de page ─────────────────────────────────
  // Reprend les classes CSS du vrai système (md-block, exercise-preview,
  // two-cols, output...) pour une hauteur et un rendu identiques : la bascule
  // fac-similé -> page réelle doit être invisible.

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

  function construireFacsimile(index) {
    const gestionnaire = pm();
    const edit = editeur();
    const page = (gestionnaire && typeof gestionnaire.getPageRef === "function")
      ? gestionnaire.getPageRef(index) : null;
    if (!page) return null;

    const facEl = document.createElement("div");
    facEl.className = "sc-page";
    facEl.dataset.scIndex = String(index);

    // 1. Blocs markdown.
    const mds = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page.comment || "")];
    const zoneMds = document.createElement("div");
    zoneMds.className = "sc-mds";
    mds.forEach((texte) => zoneMds.appendChild(construireBlocMarkdown(texte, page)));
    facEl.appendChild(zoneMds);

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

    let cm = null;
    if (window.CodeMirror && edit) {
      cm = new window.CodeMirror(editorContainer, {
        value: String(page.code || ""),
        mode: edit.getOption("mode"),
        theme: edit.getOption("theme"),
        lineNumbers: true,
        indentUnit: edit.getOption("indentUnit") || 4,
        readOnly: "nocursor",
        viewportMargin: Infinity
      });
    } else {
      // Secours improbable : CodeMirror absent, simple <pre>.
      const pre = document.createElement("pre");
      pre.className = "sc-code-brut";
      pre.textContent = String(page.code || "");
      editorContainer.appendChild(pre);
    }

    if (horizontal) {
      // Mode horizontal : sortie sous l'éditeur, pas de colonne droite.
      const wrapSortie = document.createElement("div");
      const sortie = document.createElement("div");
      sortie.className = "output sc-output";
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

    facEl.appendChild(split);

    // Clic n'importe où dans le fac-similé : activer cette page.
    facEl.addEventListener("mousedown", (e) => {
      if (!navAutorisee()) return;
      if (e.target && e.target.closest && e.target.closest("a, .aide-btn")) return;
      e.preventDefault();

      // Si on a cliqué dans le code : mémoriser la position pour y poser le curseur.
      let posCurseur = null;
      if (cm) {
        const wrapper = cm.getWrapperElement();
        if (wrapper && wrapper.contains(e.target)) {
          posCurseur = cm.coordsChar({ left: e.clientX, top: e.clientY }, "window");
        }
      }
      activerPage(index, null, { focus: true, curseur: posCurseur });
    });

    return { index, el: facEl, cm };
  }

  // ── (Re)construction des fac-similés autour de la zone vive ──────────────
  function reconstruire() {
    const gestionnaire = pm();
    if (!gestionnaire || !conteneurAvant || !conteneurApres) return;

    const total = gestionnaire.getPagesCount();
    const actif = gestionnaire.getActivePageIndex();

    conteneurAvant.textContent = "";
    conteneurApres.textContent = "";
    facsimiles = [];

    const visible = navAutorisee() && total > 1;
    conteneurAvant.style.display = visible ? "" : "none";
    conteneurApres.style.display = visible ? "" : "none";

    if (visible) {
      for (let i = 0; i < total; i++) {
        if (i === actif) continue;
        const fac = construireFacsimile(i);
        if (!fac) continue;
        (i < actif ? conteneurAvant : conteneurApres).appendChild(fac.el);
        facsimiles.push(fac);
        if (fac.cm) fac.cm.refresh();
      }
    }

    dernierIndiceConstruit = actif;
    dernierTotalConstruit = total;
    verrouPrecedent = navAutorisee();

    appliquerStyleEditeurReel();
    log("reconstruit :", facsimiles.length, "fac-similés, page active", actif + 1, "/", total);
  }

  // ── Zoom / thème : répercuter l'éditeur réel sur les fac-similés ─────────
  function appliquerStyleEditeurReel() {
    const edit = editeur();
    if (!edit) return;

    // Un changement de taille fait grandir/rétrécir toutes les pages : le
    // navigateur émet des scrolls de reflow qui ne sont pas un déplacement
    // voulu par l'élève. On les ignore pour ne pas rebasculer de page.
    ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + 450);
    const wrapper = edit.getWrapperElement();
    const fontSize = wrapper ? wrapper.style.fontSize : "";
    const theme = edit.getOption("theme");

    facsimiles.forEach((fac) => {
      if (fac.cm) {
        const w = fac.cm.getWrapperElement();
        if (w && w.style.fontSize !== fontSize) w.style.fontSize = fontSize;
        if (fac.cm.getOption("theme") !== theme) fac.cm.setOption("theme", theme);
        fac.cm.refresh();
      }
      fac.el.querySelectorAll(".sc-md, .sc-output, .sc-code-brut").forEach((el) => {
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

  // ── Géométrie : ligne médiane, début de la zone vive, ancrage ────────────
  function debutZoneVive() {
    // Haut de la zone vive dans le repère de défilement de #zonePython.
    return conteneurAvant.offsetTop + conteneurAvant.offsetHeight;
  }

  function pageAuMilieu() {
    const gestionnaire = pm();
    if (!gestionnaire) return 0;
    const actif = gestionnaire.getActivePageIndex();
    if (!facsimiles.length) return actif;

    const zpRect = zonePython.getBoundingClientRect();
    const milieu = zpRect.top + zonePython.clientHeight / 2;

    // Liste ordonnée des sections (fac-similés + zone vive) par haut d'écran.
    const sections = [];
    facsimiles.forEach((fac) => {
      sections.push({ index: fac.index, top: fac.el.getBoundingClientRect().top });
    });
    sections.push({ index: actif, top: conteneurAvant.getBoundingClientRect().bottom });
    sections.sort((a, b) => a.top - b.top);

    let resultat = sections[0].index;
    for (const s of sections) {
      if (s.top <= milieu) resultat = s.index;
      else break;
    }
    return resultat;
  }

  function poserScroll(valeur) {
    ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + 80);
    zonePython.scrollTop = valeur;
  }

  function annulerAncrages() {
    ancrageTimeouts.forEach(clearTimeout);
    ancrageTimeouts = [];
  }

  // Maintient le haut de la page activée à topScreen px du haut de la zone,
  // avec quelques rappels le temps que CodeMirror/les images se posent.
  // Pendant toute la séquence, les événements scroll sont ignorés : la
  // reconstruction change les hauteurs et le navigateur émet des scrolls
  // parasites (reclamp) qui, sinon, déclencheraient une fausse re-bascule
  // par la ligne médiane quand la page activée est courte.
  function ancrer(topScreen) {
    ignoreScrollJusqua = maintenantMs() + 450;
    const fixer = () => poserScroll(debutZoneVive() - topScreen);
    fixer();
    requestAnimationFrame(fixer);
    annulerAncrages();
    [60, 150, 320].forEach((delai) => {
      ancrageTimeouts.push(setTimeout(fixer, delai));
    });
  }

  // ── Indicateur "n/N" en bas pendant le défilement ────────────────────────
  function majIndicateurDefilement(indiceMedian) {
    const gestionnaire = pm();
    const indicateur = document.getElementById("pagesMultiplesIndicator");
    if (!gestionnaire || !indicateur) return;
    const texte = `${indiceMedian + 1}/${gestionnaire.getPagesCount()}`;
    if (indicateur.textContent !== texte) indicateur.textContent = texte;
  }

  // ── Bascule réelle vers une page ─────────────────────────────────────────
  function activerPage(nouvelIndice, topScreenImpose, options = {}) {
    const gestionnaire = pm();
    const edit = editeur();
    if (!gestionnaire || !edit || enActivation) return;
    if (nouvelIndice === gestionnaire.getActivePageIndex()) return;
    if (!navAutorisee()) return;

    enActivation = true;

    // Position écran actuelle du haut de la page visée (avant toute mutation).
    let topScreen = topScreenImpose;
    if (topScreen == null) {
      const fac = facsimiles.find((f) => f.index === nouvelIndice);
      const zpTop = zonePython.getBoundingClientRect().top;
      topScreen = fac ? (fac.el.getBoundingClientRect().top - zpTop) : 0;
    }

    log("activation page", nouvelIndice + 1, " topScreen=", Math.round(topScreen));

    // loadPageIntoEditor sauvegarde la page quittée (code, markdowns, sortie)
    // puis charge la nouvelle dans la zone vive. En mode ruban il ne touche
    // ni au scroll ni au focus (voir pagesmultiples.js).
    gestionnaire.loadPageIntoEditor(nouvelIndice);
    reconstruire();
    ancrer(topScreen);

    if (options.focus) {
      setTimeout(() => {
        edit.focus();
        if (options.curseur) edit.setCursor(options.curseur, null, { scroll: false });
        ancrer(topScreen);
      }, 30);
    }

    setTimeout(() => { enActivation = false; }, 400);
  }

  // ── Défilement : indicateur en direct + bascule à l'arrêt ────────────────
  function surScroll() {
    if (maintenantMs() < ignoreScrollJusqua) return;

    // Défilement manuel : on cesse de forcer l'ancrage précédent.
    annulerAncrages();

    if (!navAutorisee() || !facsimiles.length) return;

    const median = pageAuMilieu();
    majIndicateurDefilement(median);

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const gestionnaire = pm();
      if (!gestionnaire || enActivation) return;
      if (maintenantMs() < ignoreScrollJusqua) return; // zoom/ancrage en cours
      const cible = pageAuMilieu();
      if (cible !== gestionnaire.getActivePageIndex()) activerPage(cible, null, {});
    }, SETTLE_MS);
  }

  // ── Changements externes (boutons, barre latérale, import, groupe...) ────
  function surChangementExterne() {
    const gestionnaire = pm();
    if (!gestionnaire) return;

    const total = gestionnaire.getPagesCount();
    const actif = gestionnaire.getActivePageIndex();
    const verrou = navAutorisee();

    if (total === dernierTotalConstruit &&
        actif === dernierIndiceConstruit &&
        verrou === verrouPrecedent) {
      return; // rien de structurel : simple rafraîchissement d'indicateur
    }

    reconstruire();

    if (!navAutorisee()) {
      // Mode verrouillé : une seule page visible, on repart du haut.
      poserScroll(0);
      return;
    }

    // Montrer le haut de la nouvelle page active.
    ancrer(MARGE_SEPARATEUR);
  }

  function observerIndicateur() {
    const indicateur = document.getElementById("pagesMultiplesIndicator");
    if (!indicateur) return;
    const obs = new MutationObserver(() => {
      if (enActivation) return;
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
  // style répercute ensuite la nouvelle taille sur les fac-similés.
  function surMoletteFacsimile(e) {
    if (!e.ctrlKey) return;
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

    // Repère pour offsetTop des conteneurs.
    if (!zonePython.style.position) zonePython.style.position = "relative";

    conteneurAvant = document.createElement("div");
    conteneurAvant.id = "scPagesAvant";
    conteneurApres = document.createElement("div");
    conteneurApres.id = "scPagesApres";

    zonePython.insertBefore(conteneurAvant, zonePython.firstChild);
    zonePython.appendChild(conteneurApres);

    [conteneurAvant, conteneurApres].forEach((c) => {
      c.addEventListener("wheel", surMoletteFacsimile, { passive: false });
    });

    zonePython.addEventListener("scroll", surScroll, { passive: true });

    observerIndicateur();
    observerStyleEditeurReel();
    reconstruire();

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
