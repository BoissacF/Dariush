/*
  scrollContinu.js
  --------------------------------------------------------------------------
  Notebook continu : tout le document est chargé en une fois.

  Le ruban #scRuban (dans #zonePython) contient UNE section par page, dans
  l'ordre, posées une fois pour toutes : au défilement on voit un texte
  continu. Chaque section inactive affiche le markdown rendu, le code
  colorié (CodeMirror en lecture seule) et la dernière sortie : du texte,
  pas du code actif.

  La zone de travail réelle (markdownsContainer + mainSplit) reste UNIQUE :
  elle est transplantée DANS la section de la page active. À la bascule,
  seules deux sections changent de contenu, SUR PLACE, à hauteur identique :
  - le markdown de la page quittée est un CLONE exact du rendu vif (images
    déjà décodées, Mermaid déjà dessiné) ;
  - son code/sortie est réutilisé tel quel s'il n'a pas changé (cache).

  Règles de fluidité :
  - Aucune correction de scroll différée : on ne compense QUE les
    variations de mise en page (positions relatives au document), jamais
    le défilement fait par l'élève entre-temps.
  - Le défilement n'est jamais bloqué : l'écouteur de molette non passif
    (nécessaire au Ctrl+molette) n'est posé que pendant l'appui sur Ctrl.
  - Les observateurs (zoom, thème, disposition) ne réagissent qu'à un
    vrai changement de valeur, pas aux focus/blur ni aux frappes.

  - Page active = celle qui contient le milieu de l'écran. Le numéro en bas
    suit pendant le défilement ; la bascule réelle se fait à l'arrêt du
    défilement, ou immédiatement au premier clic / touche (le bouton
    Exécuter exécute donc toujours la page affichée en bas).
  - Clic dans une section inactive : active sa page (curseur posé au clic
    si c'est dans le code).
  - Zoom (Ctrl+molette, panneau zoom) : répercuté sur toutes les sections.
  - Travail en groupe ou aide (un seul pilote les pages) : le notebook
    continu est entièrement démonté — zone de travail remise à sa place
    d'origine, une seule page à l'écran, changement de page à l'ancienne
    (scrollFlipPage en bout de défilement, boutons). Il est reconstruit à
    la sortie du mode. window.__rubanEngage indique aux autres modules si
    le notebook continu est en service.
  - Bouton lecture (petit triangle) en haut à gauche de chaque cellule de
    code : vert sur la page active (exécute, comme le bouton Exécuter),
    rouge sur les autres (active la page puis l'exécute), gris quand
    Exécuter est indisponible (exécution en cours, interpréteur en
    chargement, pas à pas). Pendant une exécution, la page active ne change
    pas au défilement : la bascule se fait quand l'exécution est terminée.

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
  const SETTLE_MS = 200;            // immobilité du scroll avant bascule réelle
  const SEUIL_HYSTERESIS_PX = 48;   // déplacement mini avant nouvelle évaluation
  const IGNORE_REFLOW_MS = 450;     // après un zoom / changement de disposition

  // ── État ─────────────────────────────────────────────────────────────────
  let zonePython = null;
  let rubanEl = null;           // #scRuban
  // sections[i] = { el, pageRef, mds, split, cm, splitSig }
  //   mds/split : nœuds du fac-similé (gardés en cache quand la page est vive)
  //   splitSig  : signature du contenu de split (code, sortie, zoom, thème...)
  let sections = [];
  let indiceLive = 0;
  let mdEngine = null;
  let mermaidPret = false;

  let settleTimer = null;
  let enActivation = false;
  let ignoreScrollJusqua = 0;   // ignorer nos propres scrollTop / reflows
  let scrollReference = 0;      // position d'ancrage pour l'hystérésis
  let rubanEngage = false;      // notebook continu en service (hors groupe/aide)
  let ancreMdc = null;          // repères des places d'origine de la zone vive
  let ancreSplit = null;
  let styleApplique = { fontSize: null, theme: null };
  let dispositionAppliquee = "";
  let ecouteMoletteCtrl = false;

  let boutonExecuter = null;    // #runButton du menu (source de vérité)
  let boutonLectureVif = null;  // triangle de la cellule active
  let dejaPret = false;         // #runButton déjà vu actif au moins une fois
  let basculeEnAttente = false; // bascule différée par une exécution en cours

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

  // Travail en groupe ou aide (prof comme élève) : un seul pilote les pages.
  // Même règle que pageScrollbar.js.
  function modeCollaboratif() {
    if (window.__groupNavLocked === true) return true;
    if (typeof window.groupeJoined === "function" && window.groupeJoined()) return true;
    if (window.__aideConnecte === true) return true;
    return false;
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

  // Mermaid : même rendu que markdown.js (copie locale : fonction privée
  // là-bas), pour que les pages jamais encore ouvertes aient déjà leurs
  // diagrammes, à la même hauteur que dans la zone vive.
  function mermaidDisponible() {
    if (mermaidPret) return true;
    if (typeof window.mermaid === "undefined") return false;
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default"
      });
      mermaidPret = true;
    } catch (e) {
      log("Mermaid : initialisation impossible", e);
    }
    return mermaidPret;
  }

  function rendreMermaid(root) {
    if (!root || !mermaidDisponible()) return;
    root.querySelectorAll("code.language-mermaid").forEach((codeEl) => {
      const pre = codeEl.closest("pre") || codeEl;
      const code = String(codeEl.textContent || "").trim();
      if (!code) return;

      const holder = document.createElement("div");
      holder.className = "mermaid-rendu";
      pre.replaceWith(holder);

      const id = "scmmd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

      const afficherCodeBrut = () => {
        const orphan1 = document.getElementById(id);
        if (orphan1) orphan1.remove();
        const orphan2 = document.getElementById("d" + id);
        if (orphan2) orphan2.remove();
        holder.className = "mermaid-erreur";
        const block = document.createElement("pre");
        block.textContent = code;
        holder.innerHTML = "";
        holder.appendChild(block);
      };

      let p;
      try {
        p = window.mermaid.render(id, code);
      } catch (err) {
        afficherCodeBrut();
        return;
      }
      Promise.resolve(p)
        .then((res) => {
          const svg = res && res.svg ? res.svg : "";
          if (svg) holder.innerHTML = svg;
          else afficherCodeBrut();
        })
        .catch(() => afficherCodeBrut());
    });
  }

  // ── Construction des fac-similés ─────────────────────────────────────────
  // Reprend les classes CSS du vrai système (md-block, exercise-preview,
  // two-cols, output...) pour une hauteur et un rendu identiques.

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
      rendreMermaid(preview);
    }

    wrap.appendChild(preview);
    block.appendChild(wrap);
    return block;
  }

  function construireMds(page) {
    const mds = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page.comment || "")];
    const zoneMds = document.createElement("div");
    zoneMds.className = "sc-mds";
    mds.forEach((texte) => zoneMds.appendChild(construireBlocMarkdown(texte, page)));
    return zoneMds;
  }

  // Clone EXACT du markdown vif (avant qu'on le quitte) : images déjà
  // décodées, Mermaid déjà dessiné => même hauteur, sans attente.
  function clonerMarkdownsVifs(page) {
    const mdc = document.getElementById("markdownsContainer");
    if (!mdc) return null;

    const clone = mdc.cloneNode(true);
    clone.removeAttribute("id");
    clone.className = "sc-mds";

    // Bloc en cours d'édition : on montre l'aperçu rendu (comme à la sortie
    // de page dans un notebook).
    clone.querySelectorAll(".md-block").forEach((block) => {
      const ta = block.querySelector(".md-block-textarea");
      if (ta && !ta.classList.contains("hidden")) {
        block.replaceWith(construireBlocMarkdown(ta.value, page));
      }
    });

    clone.querySelectorAll(".md-block-textarea").forEach((ta) => ta.remove());
    clone.querySelectorAll(".md-block-preview").forEach((pv) => {
      pv.classList.add("sc-md");
      pv.removeAttribute("tabindex");
      pv.removeAttribute("title");
    });
    clone.querySelectorAll(".md-block-toolbar button").forEach((b) => { b.tabIndex = -1; });
    return clone;
  }

  function layoutHorizontalActif() {
    const mainSplit = document.getElementById("mainSplit");
    return !!(mainSplit && mainSplit.classList.contains("horizontal-layout"));
  }

  // Disposition de la zone vive, sans les classes passagères (glisser).
  function signatureDisposition() {
    const ms = document.getElementById("mainSplit");
    if (!ms) return "";
    const classes = ms.className.split(/\s+/)
      .filter((c) => c && c !== "is-dragging")
      .sort()
      .join(" ");
    return classes + "|" + (ms.style.gridTemplateColumns || "");
  }

  function styleCourant() {
    const edit = editeur();
    if (!edit) return { fontSize: "", theme: "" };
    const wrapper = edit.getWrapperElement();
    return {
      fontSize: wrapper ? wrapper.style.fontSize : "",
      theme: String(edit.getOption("theme") || "")
    };
  }

  function signatureSplit(index) {
    const gestionnaire = pm();
    const page = gestionnaire ? gestionnaire.getPageRef(index) : null;
    const st = styleCourant();
    return [
      page ? String(page.code || "") : "",
      (gestionnaire && typeof gestionnaire.getPageOutputText === "function")
        ? gestionnaire.getPageOutputText(index) : "",
      st.fontSize,
      st.theme,
      signatureDisposition()
    ].join("\u0001");
  }

  // Même hauteur "définie" que l'éditeur vif : la formule est reprise
  // d'ajusterHauteurEditeurHorizontal (interpreteur.js / sqlInterpreteur.js) —
  // max(6 lignes, contenu + 3 lignes). Si elle change là-bas, la changer ici.
  function ajusterHauteurFacsimile(cm) {
    if (!cm) return;
    const scroller = cm.getScrollerElement();
    const wrapper = cm.getWrapperElement();
    if (!scroller || !wrapper) return;

    // Mesures à jour d'abord (CodeMirror créé hors document, ou zoom changé) :
    // sans cela heightAtLine renvoie 0 et la hauteur tombe à 6 lignes.
    cm.refresh();

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

  function appliquerTaillesTexte(racine, fontSize) {
    racine.querySelectorAll(".sc-md, .sc-output, .sc-code-brut").forEach((el) => {
      if (el.style.fontSize !== fontSize) el.style.fontSize = fontSize;
    });
  }

  // Code + sortie d'un fac-similé, même structure que #mainSplit.
  // Renvoie { split, cm } ; split est encore détaché du document.
  function construireSplit(index, page) {
    const gestionnaire = pm();
    const edit = editeur();
    const horizontal = layoutHorizontalActif();
    const mainSplit = document.getElementById("mainSplit");

    const split = document.createElement("div");
    split.className = mainSplit
      ? mainSplit.className.replace(/\bis-dragging\b/g, "").trim()
      : "two-cols";
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
      // Mêmes styles EN LIGNE que l'éditeur vif (updateEditorLayoutMode) :
      // le CSS de CodeMirror (height:300px) est chargé APRÈS style.css et
      // gagnerait sinon sur les fac-similés.
      const wrapperFac = cm.getWrapperElement();
      const scrollerFac = cm.getScrollerElement();
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
      if (wrapperFac) wrapperFac.appendChild(creerBoutonLecture(false));
    } else {
      const pre = document.createElement("pre");
      pre.className = "sc-code-brut";
      pre.textContent = String(page.code || "");
      editorContainer.appendChild(pre);
    }

    if (horizontal) {
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

    return { split, cm };
  }

  // Remplit une section en fac-similé. mdsPrepare : clone du markdown vif
  // (bascule depuis cette page) ou null (rendu depuis le modèle).
  // Le code/sortie est réutilisé tel quel si sa signature n'a pas changé.
  function remplirFacsimile(section, index, mdsPrepare) {
    const gestionnaire = pm();
    const page = gestionnaire ? gestionnaire.getPageRef(index) : null;

    section.el.textContent = "";
    section.el.classList.add("sc-fac");
    section.el.classList.remove("sc-live");
    section.pageRef = page;

    if (!page) {
      section.mds = null;
      section.split = null;
      section.cm = null;
      section.splitSig = "";
      return;
    }

    section.mds = mdsPrepare || construireMds(page);
    section.el.appendChild(section.mds);

    const sig = signatureSplit(index);
    if (section.split && section.splitSig === sig) {
      section.el.appendChild(section.split);
      if (section.cm) section.cm.refresh();
    } else {
      const r = construireSplit(index, page);
      section.split = r.split;
      section.cm = r.cm;
      section.splitSig = sig;
      section.el.appendChild(section.split);
      if (section.cm) ajusterHauteurFacsimile(section.cm);
    }

    appliquerTaillesTexte(section.el, styleCourant().fontSize);
    section.el.querySelectorAll(".sc-run-btn").forEach(majBoutonLectureFac);
  }

  // ── Transplantation de la zone vive, SUR PLACE ───────────────────────────
  function widgetsVifs() {
    return {
      mdc: document.getElementById("markdownsContainer"),
      split: document.getElementById("mainSplit")
    };
  }

  // Déplace la zone vive dans la section j ; le fac-similé de j est détaché
  // mais gardé en cache ; l'ancienne section vive redevient fac-similé.
  function deplacerLiveVers(j, mdsCloneAncienne) {
    const { mdc, split } = widgetsVifs();
    const gestionnaire = pm();
    if (!mdc || !split || !sections[j] || !gestionnaire) return;

    const ancienIndice = indiceLive;
    const secJ = sections[j];

    secJ.el.textContent = "";
    secJ.el.classList.remove("sc-fac");
    secJ.el.classList.add("sc-live");
    secJ.el.appendChild(mdc);
    secJ.el.appendChild(split);
    secJ.pageRef = gestionnaire.getPageRef(j);

    indiceLive = j;

    if (ancienIndice !== j && sections[ancienIndice]) {
      remplirFacsimile(sections[ancienIndice], ancienIndice, mdsCloneAncienne);
    }
  }

  // ── Construction complète du ruban (init, ajout/suppression, import) ─────
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
      sections.push({ el, pageRef: null, mds: null, split: null, cm: null, splitSig: "" });
    }

    indiceLive = actif;
    const secActive = sections[actif];
    if (secActive) {
      secActive.el.classList.add("sc-live");
      if (mdc) secActive.el.appendChild(mdc);
      if (split) secActive.el.appendChild(split);
      secActive.pageRef = gestionnaire.getPageRef(actif);
    }

    for (let i = 0; i < total; i++) {
      if (i !== actif) remplirFacsimile(sections[i], i, null);
    }

    const edit = editeur();
    if (edit) edit.refresh();

    styleApplique = styleCourant();
    dispositionAppliquee = signatureDisposition();
    log("ruban construit :", total, "sections, page active", actif + 1);
  }

  // ── Mise en service / hors service (travail en groupe, aide) ─────────────
  // Hors service : la zone vive retrouve EXACTEMENT sa place d'origine
  // (repères posés au démarrage), le ruban est vidé et masqué, et
  // window.__rubanEngage = false rend la main à l'ancien fonctionnement
  // (scrollFlipPage, loadPageIntoEditor qui remonte en haut de page).
  function desengagerRuban() {
    if (!rubanEngage) return;
    rubanEngage = false;
    window.__rubanEngage = false;

    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    basculeEnAttente = false;
    majEcouteMoletteCtrl(false);

    const { mdc, split } = widgetsVifs();
    if (mdc && ancreMdc && ancreMdc.parentNode) {
      ancreMdc.parentNode.insertBefore(mdc, ancreMdc.nextSibling);
    }
    if (split && ancreSplit && ancreSplit.parentNode) {
      ancreSplit.parentNode.insertBefore(split, ancreSplit.nextSibling);
    }

    rubanEl.textContent = "";
    sections = [];
    rubanEl.style.display = "none";
    ancrageSuspendu = 0;
    zonePython.style.overflowAnchor = "";

    const edit = editeur();
    if (edit) edit.refresh();
    // L'indicateur a pu afficher la page du milieu : retour à la page active.
    const gestionnaire = pm();
    if (gestionnaire && typeof gestionnaire.updatePaginationUi === "function") {
      gestionnaire.updatePaginationUi();
    }
    zonePython.scrollTop = 0;
    log("hors service (travail en groupe / aide)");
  }

  function engagerRuban() {
    if (rubanEngage) return;
    rubanEngage = true;
    window.__rubanEngage = true;
    rubanEl.style.display = "";
    construireRuban();
    allerAuDebutDeSection(indiceLive);
    log("en service");
  }

  function verifierModeCollaboratif() {
    if (!rubanEl) return;
    const collaboratif = modeCollaboratif();
    if (collaboratif && rubanEngage) desengagerRuban();
    else if (!collaboratif && !rubanEngage) engagerRuban();
  }

  // ── Zoom / thème : uniquement sur VRAI changement ────────────────────────
  // Le style de l'éditeur vif est réécrit à chaque frappe (hauteur) et sa
  // classe à chaque focus/blur : sans ce filtre, toutes les pages étaient
  // redessinées à chaque frappe et à chaque clic sur Exécuter.
  function surStyleEditeur() {
    const st = styleCourant();
    if (st.fontSize === styleApplique.fontSize && st.theme === styleApplique.theme) return;
    styleApplique = st;

    // Le zoom fait grandir/rétrécir tout le document : les scrolls de reflow
    // ne sont pas un déplacement voulu par l'élève.
    ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + IGNORE_REFLOW_MS);
    setTimeout(armerHysteresis, IGNORE_REFLOW_MS + 10);

    sections.forEach((s, i) => {
      if (i === indiceLive || !s.split) return;
      if (s.cm) {
        const w = s.cm.getWrapperElement();
        if (w && w.style.fontSize !== st.fontSize) w.style.fontSize = st.fontSize;
        if (s.cm.getOption("theme") !== st.theme) s.cm.setOption("theme", st.theme);
        ajusterHauteurFacsimile(s.cm);
      }
      appliquerTaillesTexte(s.el, st.fontSize);
      s.splitSig = signatureSplit(i);
    });
  }

  function observerStyleEditeurReel() {
    const edit = editeur();
    if (!edit) return;
    const wrapper = edit.getWrapperElement();
    if (!wrapper) return;
    const obs = new MutationObserver(surStyleEditeur);
    obs.observe(wrapper, { attributes: true, attributeFilter: ["style", "class"] });
  }

  // Disposition changée (horizontal/vertical, colonnes redimensionnées) :
  // les fac-similés reprennent la même structure (hauteurs identiques).
  let dispositionTimer = null;
  function observerDisposition() {
    const mainSplit = document.getElementById("mainSplit");
    if (!mainSplit) return;
    const obs = new MutationObserver(() => {
      if (signatureDisposition() === dispositionAppliquee) return;
      if (dispositionTimer) clearTimeout(dispositionTimer);
      dispositionTimer = setTimeout(() => {
        dispositionTimer = null;
        const sig = signatureDisposition();
        if (sig === dispositionAppliquee) return;
        dispositionAppliquee = sig;
        ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + IGNORE_REFLOW_MS);
        sections.forEach((s, i) => {
          if (i !== indiceLive) remplirFacsimile(s, i, null);
        });
        setTimeout(armerHysteresis, IGNORE_REFLOW_MS + 10);
      }, 200);
    });
    obs.observe(mainSplit, { attributes: true, attributeFilter: ["style", "class"] });
  }

  // ── Géométrie (repère : contenu de #zonePython) ──────────────────────────
  function pageAuMilieu() {
    if (!sections.length) return indiceLive;
    const milieu = zonePython.scrollTop + zonePython.clientHeight / 2;
    let resultat = indiceLive;
    let trouve = false;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].el.style.display === "none") continue;
      if (!trouve || sections[i].el.offsetTop <= milieu) {
        resultat = i;
        trouve = true;
      }
      if (sections[i].el.offsetTop > milieu) break;
    }
    return resultat;
  }

  function poserScroll(valeur) {
    ignoreScrollJusqua = Math.max(ignoreScrollJusqua, maintenantMs() + 80);
    zonePython.scrollTop = valeur;
  }

  function armerHysteresis() {
    if (zonePython) scrollReference = zonePython.scrollTop;
  }

  // Ancrage du défilement de Chrome (overflow-anchor) : quand du contenu
  // change de place au-dessus de la vue, Chrome décale le défilement pour
  // suivre un élément de référence qu'il a choisi. Pendant un échange de
  // page, la zone vive reçoit le contenu de la nouvelle page AVANT d'être
  // déplacée : si Chrome a choisi une ligne de code ou la sortie vive comme
  // référence, il la suit (ex. +465 px quand la nouvelle page commence par
  // une grande image). On le suspend le temps de l'échange — ce module
  // compense déjà lui-même au pixel près — puis on le rétablit (il reste
  // utile pour les images ou diagrammes qui finissent de se charger).
  let ancrageSuspendu = 0;
  function suspendreAncrageNavigateur() {
    if (!zonePython) return;
    ancrageSuspendu++;
    zonePython.style.overflowAnchor = "none";
  }

  function retablirAncrageNavigateur() {
    if (!zonePython) return;
    // Deux images plus tard : Chrome choisit alors une nouvelle référence
    // sans appliquer de correction pour l'échange déjà fait.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ancrageSuspendu = Math.max(0, ancrageSuspendu - 1);
      if (ancrageSuspendu === 0) zonePython.style.overflowAnchor = "";
    }));
  }

  // ── Indicateur "n/N" en bas pendant le défilement ────────────────────────
  function majIndicateurDefilement(indice) {
    const gestionnaire = pm();
    const indicateur = document.getElementById("pagesMultiplesIndicator");
    if (!gestionnaire || !indicateur) return;
    const texte = `${indice + 1}/${gestionnaire.getPagesCount()}`;
    if (indicateur.textContent !== texte) indicateur.textContent = texte;
  }

  // ── Bascule réelle vers une page (scroll posé, clic, touche) ─────────────
  // La compensation ne corrige QUE les variations de mise en page : on
  // compare la position de la section dans le DOCUMENT avant/après, et on
  // ajoute l'écart au scroll courant. Le défilement fait par l'élève
  // pendant ce temps est donc toujours conservé.
  function activerPage(j, options = {}) {
    const gestionnaire = pm();
    const edit = editeur();
    if (!gestionnaire || !edit || enActivation) return;
    if (j === indiceLive || j < 0 || j >= sections.length) return;
    if (!rubanEngage) return;
    if (executionEnCours()) return;

    enActivation = true;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }

    suspendreAncrageNavigateur();
    const secJ = sections[j].el;
    const avant = secJ.offsetTop;
    const scrollAvant = zonePython.scrollTop;
    const ancienne = sections[indiceLive];
    const clone = clonerMarkdownsVifs(ancienne ? ancienne.pageRef : null);

    log("activation page", j + 1);

    // Sauvegarde la page quittée et charge la nouvelle dans la zone vive.
    // En mode ruban, loadPageIntoEditor ne touche ni au scroll ni au focus.
    gestionnaire.loadPageIntoEditor(j);
    deplacerLiveVers(j, clone);
    edit.refresh();

    // Position visée : celle d'avant l'échange, corrigée du seul écart de
    // mise en page de la section. Si quoi que ce soit a fait défiler pendant
    // l'échange (ancrage navigateur malgré la suspension, focus...), c'est
    // annulé ici ; sinon aucune écriture (pas d'animation interrompue).
    const delta = secJ.offsetTop - avant;
    const vise = scrollAvant + delta;
    if (Math.abs(zonePython.scrollTop - vise) >= 1) poserScroll(vise);
    let reference = secJ.offsetTop;

    requestAnimationFrame(() => {
      // Mise en page tardive (rafraîchissement CodeMirror) : même principe.
      const d = secJ.offsetTop - reference;
      if (Math.abs(d) >= 1) poserScroll(zonePython.scrollTop + d);

      if (options.curseur) {
        const st = zonePython.scrollTop;
        edit.setCursor(options.curseur, null, { scroll: false });
        edit.focus();
        if (zonePython.scrollTop !== st) poserScroll(st);
      }

      armerHysteresis();
      majIndicateurDefilement(indiceLive);
      enActivation = false;
    });
    retablirAncrageNavigateur();
  }

  // ── Défilement : indicateur en direct + bascule à l'arrêt ────────────────
  function evaluerBascule() {
    settleTimer = null;
    if (enActivation || !rubanEngage) return;
    const cible = pageAuMilieu();
    if (cible !== indiceLive) {
      // Pendant une exécution, la page qui tourne reste active (sa sortie
      // ne doit pas atterrir dans une autre page) : bascule à la fin.
      if (executionEnCours()) { basculeEnAttente = true; return; }
      activerPage(cible, {});
    } else {
      majIndicateurDefilement(cible);
    }
  }

  function surScroll() {
    if (maintenantMs() < ignoreScrollJusqua) return;
    if (!rubanEngage || sections.length <= 1) return;

    // Hystérésis : tant qu'on n'a pas vraiment bougé depuis le dernier
    // ancrage, on ne réévalue rien (évite les allers-retours de pages).
    if (Math.abs(zonePython.scrollTop - scrollReference) < SEUIL_HYSTERESIS_PX) return;

    majIndicateurDefilement(pageAuMilieu());

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(evaluerBascule, SETTLE_MS);
  }

  // Premier clic / première touche pendant qu'une bascule attend : on la
  // fait tout de suite, pour qu'Exécuter (bouton ou raccourci) agisse sur
  // la page affichée en bas. Un clic DANS une section inactive est laissé
  // à surMousedown, qui active la page cliquée.
  function forcerBasculeEnAttente(e) {
    if (!settleTimer) return;
    const cible = e && e.target && e.target.closest ? e.target : null;
    // Bouton lecture : c'est CETTE cellule que l'élève vise. Sur la cellule
    // active, on annule la bascule en attente ; sur une autre, son propre
    // clic active la bonne page.
    const lecture = cible ? cible.closest(".sc-run-btn") : null;
    if (lecture) {
      if (lecture === boutonLectureVif) { clearTimeout(settleTimer); settleTimer = null; }
      return;
    }
    const dansFac = cible ? cible.closest(".sc-section.sc-fac") : null;
    if (dansFac) return;
    clearTimeout(settleTimer);
    evaluerBascule();
  }

  // ── Clic dans une section inactive : activation ──────────────────────────
  function surMousedown(e) {
    const secEl = e.target && e.target.closest ? e.target.closest(".sc-section") : null;
    if (!secEl) return;
    const j = sections.findIndex((s) => s.el === secEl);
    if (j < 0 || j === indiceLive) return;
    if (!rubanEngage) return;
    if (e.target.closest("a, .aide-btn, .sc-run-btn")) return;
    if (executionEnCours()) return;
    e.preventDefault();

    // Clic dans le code : position du curseur. Ailleurs (markdown, sortie) :
    // on active la page sans donner le focus à l'éditeur.
    let posCurseur = null;
    const cm = sections[j].cm;
    if (cm) {
      const wrapper = cm.getWrapperElement();
      if (wrapper && wrapper.contains(e.target)) {
        posCurseur = cm.coordsChar({ left: e.clientX, top: e.clientY }, "window");
      }
    }
    activerPage(j, { curseur: posCurseur });
  }

  // ── Changements externes (boutons, barre latérale, import, groupe...) ────
  // Appelé SANS délai dans l'observateur de l'indicateur : l'échange se fait
  // avant l'affichage de l'image suivante (pas de contenu fugitif).
  function surChangementExterne() {
    const gestionnaire = pm();
    if (!gestionnaire || !rubanEl) return;
    // Entrée / sortie de travail en groupe ou d'aide détectée au plus tôt.
    verifierModeCollaboratif();
    if (!rubanEngage) return;
    if (enActivation) return;

    const total = gestionnaire.getPagesCount();
    const actif = gestionnaire.getActivePageIndex();

    // Pages ajoutées, supprimées, ou remplacées (import, IA...) : tout refaire.
    const memesPages = total === sections.length &&
      sections.every((s, i) => s.pageRef === gestionnaire.getPageRef(i));
    if (!memesPages) {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      construireRuban();
      allerAuDebutDeSection(indiceLive);
      return;
    }

    // Page active changée hors ruban (boutons, barre latérale, groupe...).
    // Le markdown vif montre déjà la nouvelle page : l'ancienne est rendue
    // depuis le modèle (pas de clone).
    if (actif !== indiceLive) {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      deplacerLiveVers(actif, null);
      const edit = editeur();
      if (edit) edit.refresh();
      allerAuDebutDeSection(actif);
    }
  }

  function allerAuDebutDeSection(j) {
    const sec = sections[j];
    if (!sec) return;
    poserScroll(sec.el.offsetTop);
    armerHysteresis();
    const reference = sec.el.offsetTop;
    requestAnimationFrame(() => {
      const d = sec.el.offsetTop - reference;
      if (Math.abs(d) >= 1) poserScroll(zonePython.scrollTop + d);
      armerHysteresis();
    });
  }

  function observerIndicateur() {
    const indicateur = document.getElementById("pagesMultiplesIndicator");
    if (!indicateur) return;
    const obs = new MutationObserver(surChangementExterne);
    obs.observe(indicateur, { childList: true, subtree: true, characterData: true });
  }

  // ── Zoom Ctrl+molette au-dessus des fac-similés ──────────────────────────
  // Rejoué sur l'éditeur réel (qui porte la logique de zoom) ; l'observateur
  // de style répercute ensuite la nouvelle taille partout.
  function surMoletteFacsimile(e) {
    if (!e.ctrlKey) return;
    // Dans la section vive, l'éditeur et les sorties ont déjà leurs propres
    // écouteurs : ne pas rejouer (sinon double zoom).
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

  // Un écouteur de molette NON passif oblige le navigateur à attendre le
  // JavaScript avant chaque cran de défilement : on ne le pose que pendant
  // l'appui sur Ctrl, le défilement normal reste totalement libre.
  function majEcouteMoletteCtrl(ctrlEnfonce) {
    if (!rubanEl) return;
    if (ctrlEnfonce && !ecouteMoletteCtrl) {
      rubanEl.addEventListener("wheel", surMoletteFacsimile, { passive: false });
      ecouteMoletteCtrl = true;
    } else if (!ctrlEnfonce && ecouteMoletteCtrl) {
      rubanEl.removeEventListener("wheel", surMoletteFacsimile, { passive: false });
      ecouteMoletteCtrl = false;
    }
  }

  // ── Bouton lecture (triangle) de chaque cellule de code ──────────────────
  // Source de vérité : #runButton du menu, désactivé dès qu'on ne peut pas
  // exécuter (interpréteur en chargement, exécution en cours, "Tous", pas à
  // pas). Le triangle ne fait que le cliquer : même comportement, mêmes
  // garde-fous. Positionné en absolu dans le cadre CodeMirror : il ne change
  // aucune hauteur (indispensable à l'échange de page sans saut).

  // Exécution réellement en cours (et non simple chargement initial).
  function executionEnCours() {
    return !!(boutonExecuter && boutonExecuter.disabled && dejaPret);
  }

  function executerPageActive() {
    if (boutonExecuter && !boutonExecuter.disabled) boutonExecuter.click();
  }

  function creerBoutonLecture(vif) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sc-run-btn";
    btn.tabIndex = -1;
    btn.setAttribute("aria-label", "Exécuter");
    btn.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">' +
      '<path d="M2.2 1.2 L9 5 L2.2 8.8 Z"></path></svg>';
    // mousedown : ni CodeMirror, ni l'activation par clic, ni perte de focus.
    btn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      surClicLecture(btn);
    });
    if (vif) majEtatsBoutonsLecture();
    else majBoutonLectureFac(btn);
    return btn;
  }

  function majBoutonLectureFac(btn) {
    const bloque = executionEnCours();
    btn.classList.add("etat-inactif");
    btn.classList.toggle("etat-bloque", bloque);
    btn.title = bloque
      ? "Exécution en cours sur la page active…"
      : "Page inactive : cliquer pour l'activer et l'exécuter";
  }

  function majEtatsBoutonsLecture() {
    const occupe = !boutonExecuter || boutonExecuter.disabled;
    if (boutonExecuter && !boutonExecuter.disabled) dejaPret = true;

    if (boutonLectureVif) {
      boutonLectureVif.classList.toggle("etat-actif", !occupe);
      boutonLectureVif.classList.toggle("etat-occupe", occupe);
      boutonLectureVif.title = !occupe
        ? "Exécuter ce code (page active) — Maj + Entrée"
        : window.isDebugMode
          ? "Débogage pas à pas en cours…"
          : dejaPret ? "Exécution en cours…" : "Interpréteur en cours de chargement…";
    }
    if (rubanEl) rubanEl.querySelectorAll(".sc-fac .sc-run-btn").forEach(majBoutonLectureFac);

    // Fin d'exécution : bascule différée vers la page affichée.
    if (!occupe && basculeEnAttente) {
      basculeEnAttente = false;
      evaluerBascule();
    }
  }

  function surClicLecture(btn) {
    if (btn === boutonLectureVif || btn.closest(".sc-live")) {
      executerPageActive();
      return;
    }
    const secEl = btn.closest(".sc-section");
    const j = sections.findIndex((s) => s.el === secEl);
    if (j < 0 || executionEnCours() || !rubanEngage) return;
    activerPage(j, {});
    // Exécution une fois l'échange affiché (le triangle passe au vert puis au gris).
    if (indiceLive === j) requestAnimationFrame(() => executerPageActive());
  }

  function installerBoutonsLecture() {
    const edit = editeur();
    boutonExecuter = document.getElementById("runButton");
    if (!edit || !boutonExecuter) return;
    const wrapper = edit.getWrapperElement();
    if (!wrapper) return;

    boutonLectureVif = creerBoutonLecture(true);
    wrapper.appendChild(boutonLectureVif);
    majEtatsBoutonsLecture();

    const obs = new MutationObserver(majEtatsBoutonsLecture);
    obs.observe(boutonExecuter, { attributes: true, attributeFilter: ["disabled"] });
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

    // Repères des places d'origine de la zone vive, pour la remettre
    // exactement en place hors service (travail en groupe, aide).
    const { mdc } = widgetsVifs();
    if (mdc && mdc.parentNode) {
      ancreMdc = document.createComment(" place d'origine : markdowns ");
      mdc.parentNode.insertBefore(ancreMdc, mdc);
    }
    ancreSplit = document.createComment(" place d'origine : code et sortie ");
    split.parentNode.insertBefore(ancreSplit, split);

    // Le ruban prend la place de mainSplit dans le flux ; les zones de chat
    // et l'ancien système mono-bloc restent au-dessus, hors du ruban.
    // Masqué tant qu'il n'est pas en service.
    rubanEl = document.createElement("div");
    rubanEl.id = "scRuban";
    rubanEl.style.display = "none";
    zonePython.insertBefore(rubanEl, ancreSplit);

    rubanEl.addEventListener("mousedown", surMousedown);
    zonePython.addEventListener("scroll", surScroll, { passive: true });

    document.addEventListener("pointerdown", forcerBasculeEnAttente, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Control") majEcouteMoletteCtrl(true);
      forcerBasculeEnAttente(e);
    }, true);
    document.addEventListener("keyup", (e) => {
      if (e.key === "Control") majEcouteMoletteCtrl(false);
    }, true);
    window.addEventListener("blur", () => majEcouteMoletteCtrl(false));

    observerIndicateur();
    observerStyleEditeurReel();
    observerDisposition();
    installerBoutonsLecture();

    // En service sauf en travail de groupe / aide ; on surveille ensuite
    // l'entrée et la sortie de ces modes.
    window.__rubanEngage = false;
    verifierModeCollaboratif();
    setInterval(verifierModeCollaboratif, 400);
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
