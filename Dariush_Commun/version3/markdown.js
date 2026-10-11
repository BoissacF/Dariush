/* =========================================================
   markdown.js
   - alternance textarea / aperçu conservée
   - rendu via markdown-it
   - HTML simple accepté
   - support conservé des images attachment:...
   - chargement conditionnel de KaTeX si formules LaTeX détectées
   ========================================================= */




(function () {
  let md = null;
  let katexPluginApplied = false;
  let notebookGlobalCssRaw = "";
let notebookGlobalStyleEl = null;

const NOTEBOOK_GLOBAL_ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "div", "span",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "td", "th",
  "blockquote", "code", "pre",
  "img", "a", "hr",
  "strong", "em", "b", "i", "u",
  "details", "summary"
]);

  function getEditorEl() {
    return document.getElementById("exerciseText");
  }

  function getPreviewEl() {
    return document.getElementById("exercisePreview");
  }

  function normalizeText(text) {
    return String(text ?? "").replace(/\r\n/g, "\n").trim();
  }

  function getMarkdownEngine() {
    if (md) return md;

    if (typeof window.markdownit !== "function") {
      console.warn("markdown-it non chargé : aperçu markdown désactivé.");
      return null;
    }

    md = window.markdownit({
      html: true,
      linkify: true,
      breaks: false,
      typographer: false
    });

    applyKatexPluginIfAvailable();

    return md;
  }

  
 
  
  
  
  
  
  function applyKatexPluginIfAvailable() {
  if (!md) return;
  if (katexPluginApplied) return;

  if (typeof window.texmath === "function" && window.katex) {
    md.use(window.texmath, {
      engine: window.katex,
      delimiters: "dollars",
      katexOptions: {
        throwOnError: false
      }
    });
    katexPluginApplied = true;
  }
}

  



  


  function getAttachmentDataUrl(imageName) {
    if (
      window.GestionImages &&
      typeof window.GestionImages.getActivePageImageDataUrl === "function"
    ) {
      return window.GestionImages.getActivePageImageDataUrl(imageName);
    }

    return "";
  }

  function replaceAttachmentImages(root) {
    if (!root) return;

    const images = root.querySelectorAll('img[src^="attachment:"]');

    images.forEach((img) => {
      const rawSrc = String(img.getAttribute("src") || "");
      const imageName = rawSrc.slice("attachment:".length).trim();
      const dataUrl = getAttachmentDataUrl(imageName);

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

  function lightlySanitizePreview(root) {
    if (!root) return;

    root.querySelectorAll("script, iframe, object, embed, meta, base").forEach((el) => {
      el.remove();
    });

    root.querySelectorAll("*").forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "");

        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
          return;
        }

        if ((name === "src" || name === "href") && /^javascript:/i.test(value.trim())) {
          el.removeAttribute(attr.name);
        }
      });
    });
  }
  
  
  function ensureNotebookGlobalStyleTag() {
  if (notebookGlobalStyleEl) return notebookGlobalStyleEl;

  let styleEl = document.getElementById("notebookGlobalMarkdownStyle");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "notebookGlobalMarkdownStyle";
    document.head.appendChild(styleEl);
  }

  notebookGlobalStyleEl = styleEl;
  return notebookGlobalStyleEl;
}

function sanitizeNotebookGlobalCss(rawCss) {
  const css = String(rawCss || "").replace(/<\/style/gi, "");
  const keptRules = [];

  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  let match;

  while ((match = ruleRegex.exec(css)) !== null) {
    const selectorGroup = String(match[1] || "").trim();
    const body = String(match[2] || "").trim();

    if (!selectorGroup || !body) continue;

    const scopedSelectors = [];

    selectorGroup
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .forEach((selector) => {
        // On accepte trois formes simples, et rien d'autre :
        //   - une balise seule          : h1, div, span...
        //   - une (des) classe(s)       : .texte-rouge, .a.b
        //   - balise + classe(s)        : div.boite-info, span.badge-succes
        // Pas de combinateurs, ni d'attributs, ni de pseudo-classes.
        const m = selector.match(
          /^([A-Za-z][A-Za-z0-9-]*)?((?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/
        );
        if (!m) return;

        const tagPart = m[1] || "";
        const classPart = m[2] || "";

        // Sélecteur vide ou non exploitable.
        if (!tagPart && !classPart) return;

        // Si une balise est présente, elle doit rester dans la liste blanche.
        if (tagPart && !NOTEBOOK_GLOBAL_ALLOWED_TAGS.has(tagPart.toLowerCase())) {
          return;
        }

        // Balise mise en minuscule (HTML insensible à la casse), classes
        // conservées telles quelles (les classes CSS sont sensibles à la casse).
        const normalized = (tagPart ? tagPart.toLowerCase() : "") + classPart;

        scopedSelectors.push(`.exercise-preview ${normalized}`);
      });

    if (!scopedSelectors.length) continue;

    keptRules.push(`${scopedSelectors.join(", ")} { ${body} }`);
  }

  return keptRules.join("\n");
}

function applyNotebookGlobalCss() {
  const styleEl = ensureNotebookGlobalStyleTag();
  styleEl.textContent = sanitizeNotebookGlobalCss(notebookGlobalCssRaw);
}

function setNotebookGlobalCss(cssText) {
  notebookGlobalCssRaw = String(cssText || "");
  applyNotebookGlobalCss();
}

function getNotebookGlobalCss() {
  return notebookGlobalCssRaw;
}
  
  
  

  function scopeLocalStyleTagsToPreview(root) {
  if (!root) return;

  const previewId = root.id || "exercisePreview";
  const styleTags = root.querySelectorAll("style");

  styleTags.forEach((styleEl) => {
    const rawCss = String(styleEl.textContent || "").trim();
    if (!rawCss) return;

    const scopedCss = prefixCssSelectors(rawCss, `#${previewId}`);
    styleEl.textContent = scopedCss;
  });
}

function prefixCssSelectors(cssText, scopeSelector) {
  const css = String(cssText || "");
  if (!css.trim()) return css;

  // protège les blocs @media en traitant récursivement leur contenu
  return css.replace(/(^|})\s*([^{}@][^{}]*)\s*\{/g, (match, sep, selectorGroup) => {
    const selectors = selectorGroup
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(selector => {
        // Ne pas préfixer @keyframes/from/to/percentages
        if (
          selector.startsWith(scopeSelector) ||
          selector === "from" ||
          selector === "to" ||
          /^\d+%$/.test(selector)
        ) {
          return selector;
        }

        // html, body, :root deviennent la preview elle-même
        if (
          selector === "html" ||
          selector === "body" ||
          selector === ":root"
        ) {
          return scopeSelector;
        }

        return `${scopeSelector} ${selector}`;
      });

    return `${sep} ${selectors.join(", ")} {`;
  }).replace(/@media\s+([^{]+)\{([\s\S]*?)\}\s*$/gm, (match, mediaQuery, innerCss) => {
    return `@media ${mediaQuery}{${prefixCssSelectors(innerCss, scopeSelector)}}`;
  });
}
  
  
  
  function renderNotebookLikeMarkdown(text) {
    const engine = getMarkdownEngine();
    if (!engine) {
      return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
    }

    return engine.render(String(text ?? ""));
  }

  async function updatePreviewFromTextarea() {
    const editorEl = getEditorEl();
    const previewEl = getPreviewEl();
    if (!editorEl || !previewEl) return;

    const rawText = editorEl.value ?? "";
    const normalized = normalizeText(rawText);

    if (!normalized) {
      previewEl.textContent = editorEl.placeholder || "Entrez du texte ou collez une image";
      previewEl.classList.add("is-empty");
      return;
    }

    //await ensureKatexLoadedIfNeeded(rawText);

   previewEl.innerHTML = renderNotebookLikeMarkdown(rawText);
   replaceAttachmentImages(previewEl);
    lightlySanitizePreview(previewEl);
scopeLocalStyleTagsToPreview(previewEl);
previewEl.classList.remove("is-empty");
  }

  async function showPreview() {
    const editorEl = getEditorEl();
    const previewEl = getPreviewEl();
    if (!editorEl || !previewEl) return;

    await updatePreviewFromTextarea();

    editorEl.classList.add("hidden");
    previewEl.classList.remove("hidden");
  }

  function showEditor() {
    const editorEl = getEditorEl();
    const previewEl = getPreviewEl();
    if (!editorEl || !previewEl) return;

    previewEl.classList.add("hidden");
    editorEl.classList.remove("hidden");

    if (typeof autoResizeTextarea === "function") {
      autoResizeTextarea(editorEl);
    }

    editorEl.focus();

    const len = editorEl.value.length;
    editorEl.setSelectionRange(len, len);
  }

  function initMarkdownEditor() {
    const editorEl = getEditorEl();
    const previewEl = getPreviewEl();
    
    const cssButton = document.getElementById("cssButton");
const cssPanel = document.getElementById("cssPanel");
const cssTextarea = document.getElementById("cssTextarea");
const cssCloseButton = document.getElementById("cssCloseButton");

    if (!editorEl || !previewEl) return;

    editorEl.addEventListener("input", () => {
      updatePreviewFromTextarea();
    });

    editorEl.addEventListener("blur", () => {
      showPreview();
    });

    previewEl.addEventListener("click", () => {
      showEditor();
    });

    previewEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showEditor();
      }
    });

    if (cssTextarea) {
    const savedCss = getNotebookGlobalCss();

    if (savedCss && savedCss.trim()) {
      cssTextarea.value = savedCss;
    }
    
    

  cssTextarea.addEventListener("input", () => {
  setNotebookGlobalCss(cssTextarea.value);
  updatePreviewFromTextarea();

  if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
    window.PythonAutosave.saveNow();
  }
});
}

if (cssButton && cssPanel) {
  cssButton.addEventListener("click", () => {
    cssPanel.classList.toggle("hidden");
    if (!cssPanel.classList.contains("hidden") && cssTextarea) {
      cssTextarea.focus();
    }
  });
}

if (cssCloseButton && cssPanel) {
  cssCloseButton.addEventListener("click", () => {
    cssPanel.classList.add("hidden");
  });
}

applyNotebookGlobalCss();
    
    
    updatePreviewFromTextarea();
    showPreview();
  }

  function refreshMarkdownPreview() {
    updatePreviewFromTextarea();
  }
function syncCssTextarea() {
  const cssTextarea = document.getElementById("cssTextarea");
  if (!cssTextarea) return;

  const css = getNotebookGlobalCss();
  if (css && css.trim()) {
    cssTextarea.value = css;
  }
}
 /* =========================================================
     MARKDOWNS MULTIPLES
     Génération des blocs dans #markdownsContainer.
     ========================================================= */

  function getMarkdownsContainer() {
    return document.getElementById("markdownsContainer");
  }

  // Construit le DOM d'un bloc markdown (barre + zone texte + aperçu).
  // index : position du bloc dans la page. text : son contenu markdown.
  function buildMarkdownBlockEl(index, text) {
    const block = document.createElement("div");
    block.className = "md-block";
    block.dataset.mdIndex = String(index);

   // Petite barre fine personnelle. Ordre des boutons (gauche → droite) :
    //   +  (ajouter)  ✂ (couper)  ↑ (monter)  ↓ (descendre)  — (réduire)
    const toolbar = document.createElement("div");
    toolbar.className = "comment-toolbar md-block-toolbar";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "comment-toggle-btn md-btn-add";
    addBtn.title = "Ajouter un markdown en dessous";
    addBtn.textContent = "+";
    toolbar.appendChild(addBtn);

    const cutBtn = document.createElement("button");
    cutBtn.type = "button";
    cutBtn.className = "comment-toggle-btn md-btn-cut";
    cutBtn.title = "Supprimer ce markdown";
    cutBtn.textContent = "✂";
    toolbar.appendChild(cutBtn);

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "comment-toggle-btn md-btn-up";
    upBtn.title = "Déplacer vers le haut";
    upBtn.textContent = "↑";
    toolbar.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "comment-toggle-btn md-btn-down";
    downBtn.title = "Déplacer vers le bas";
    downBtn.textContent = "↓";
    toolbar.appendChild(downBtn);

    const reduceBtn = document.createElement("button");
    reduceBtn.type = "button";
    reduceBtn.className = "comment-toggle-btn md-btn-reduce";
    reduceBtn.title = "Masquer le texte";
    reduceBtn.textContent = "—";
    toolbar.appendChild(reduceBtn);

    block.appendChild(toolbar);

    // Zone texte + aperçu (mêmes classes que l'ancien système pour le style).
    const wrap = document.createElement("div");
    wrap.className = "exercise-text-wrap md-block-wrap";

    const textarea = document.createElement("textarea");
    textarea.className = "exercise-text md-block-textarea";
    textarea.rows = 1;
    textarea.spellcheck = false;
    textarea.placeholder = "Entrez du texte ou collez une image";
    textarea.value = String(text ?? "");

    const preview = document.createElement("div");
    preview.className = "exercise-preview md-block-preview";
    preview.tabIndex = 0;
    preview.title = "Cliquer pour modifier";

    wrap.appendChild(textarea);
    wrap.appendChild(preview);
    block.appendChild(wrap);

    return block;
  }

  // --- Agent Aide : transforme les marqueurs en bouton / label, après sanitize ---
  let aideDelegationDone = false;

  function ensureAideDelegation() {
    if (aideDelegationDone) return;
    aideDelegationDone = true;
    // Listener unique délégué : survit aux régénérations innerHTML des blocs.
    document.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".aide-btn") : null;
      if (!btn) return;
      e.preventDefault();
      const code = btn.dataset.aideCode || "";
      if (window.AgentAide && typeof window.AgentAide.demarrer === "function") {
        window.AgentAide.demarrer(code, btn);
      } else {
        console.log("[aide] clic bouton, code =", code); // placeholder testable
      }
    });
  }

  // Remplace les marqueurs textuels par des éléments, sans casser le HTML rendu.
  // On parcourt uniquement les nœuds texte (jamais les attributs).
  function transformAideMarkers(root) {
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
        if (m.index > last) {
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        }
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
        } else { // FINREP
          const span = document.createElement("span");
          span.className = "finrep-label";
          span.dataset.finrepCode = code;
          span.textContent = "◼";
          frag.appendChild(span);
        }  





        last = m.index + m[0].length;
      }
      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

// --- Mermaid : rend les blocs ```mermaid en SVG (passe de post-traitement) ---
// Même principe que replaceAttachmentImages / transformAideMarkers : on agit sur
// le HTML déjà rendu. Le rendu Mermaid est asynchrone, donc on remplace le bloc
// par le SVG dès qu'il est prêt, sans rendre renderBlockPreview asynchrone.
let mermaidInitDone = false;

function ensureMermaidInit() {
  if (mermaidInitDone) return true;
  if (typeof window.mermaid === "undefined") return false; // lib pas encore chargée
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default"
    });
    mermaidInitDone = true;
  } catch (e) {
    console.warn("Mermaid : initialisation impossible.", e);
  }
  return mermaidInitDone;
}

function renderMermaidBlocks(root) {
  if (!root) return;
  if (!ensureMermaidInit()) return; // pas de lib : on laisse le code brut visible

  const codeEls = root.querySelectorAll("code.language-mermaid");

  codeEls.forEach((codeEl) => {
    const pre = codeEl.closest("pre") || codeEl;
    const code = String(codeEl.textContent || "").trim();
    if (!code) return;

    const holder = document.createElement("div");
    holder.className = "mermaid-rendu";
    pre.replaceWith(holder);

    const id = "mmd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    const afficherCodeBrut = () => {
      // Diagramme invalide (souvent en cours d'écriture) : on montre le code
      // proprement, sans boîte d'erreur rouge. On nettoie les noeuds temporaires
      // que Mermaid a pu laisser dans le body.
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
      p = window.mermaid.render(id, code); // renvoie une Promise { svg }
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

  // Rend un bloc en aperçu (réutilise le moteur de rendu existant).
 function renderBlockPreview(blockEl) {
    if (!blockEl) return;
    const textarea = blockEl.querySelector(".md-block-textarea");
    const preview = blockEl.querySelector(".md-block-preview");
    if (!textarea || !preview) return;

    ensureAideDelegation();

    const rawText = textarea.value ?? "";
    const normalized = normalizeText(rawText);

    if (!normalized) {
      preview.textContent = textarea.placeholder || "Entrez du texte ou collez une image";
      preview.classList.add("is-empty");
    } else {
      preview.innerHTML = renderNotebookLikeMarkdown(rawText);
      replaceAttachmentImages(preview);
      lightlySanitizePreview(preview);
      scopeLocalStyleTagsToPreview(preview);
      transformAideMarkers(preview);
      renderMermaidBlocks(preview);
      preview.classList.remove("is-empty");
    }

    // Au départ : on montre l'aperçu, on cache le textarea.
    textarea.classList.add("hidden");
    preview.classList.remove("hidden");
  }


// Bascule un bloc précis en mode édition (montre le textarea, cache l'aperçu).
  function showBlockEditor(blockEl) {
    if (!blockEl) return;
    const textarea = blockEl.querySelector(".md-block-textarea");
    const preview = blockEl.querySelector(".md-block-preview");
    if (!textarea || !preview) return;

    // Mémorise la position de défilement AVANT la bascule aperçu -> textarea,
    // pour que le bloc reste à la même place à l'écran.
    const winX = window.scrollX;
    const winY = window.scrollY;
    const parents = [];
    let p = blockEl.parentElement;
    while (p) {
      if (p.scrollHeight > p.clientHeight) {
        parents.push([p, p.scrollTop]);
      }
      p = p.parentElement;
    }

    preview.classList.add("hidden");
    textarea.classList.remove("hidden");

    if (typeof autoResizeTextarea === "function") {
      autoResizeTextarea(textarea);
    }

    // preventScroll : le focus ne fait plus sauter la page.
    textarea.focus({ preventScroll: true });
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);

    // Restaure la position (setSelectionRange en fin de texte peut aussi faire défiler).
    parents.forEach(([node, top]) => { node.scrollTop = top; });
    window.scrollTo(winX, winY);
  }

  // Met à jour l'aperçu d'un bloc en direct, SANS changer l'affichage
  // (utilisé pendant la frappe : on reste en édition mais l'aperçu se prépare).
  function updateBlockPreviewLive(blockEl) {
    if (!blockEl) return;
    const textarea = blockEl.querySelector(".md-block-textarea");
    const preview = blockEl.querySelector(".md-block-preview");
    if (!textarea || !preview) return;

    const rawText = textarea.value ?? "";
    const normalized = normalizeText(rawText);

    if (!normalized) {
      preview.textContent = textarea.placeholder || "Entrez du texte ou collez une image";
      preview.classList.add("is-empty");
      return;
    }

    preview.innerHTML = renderNotebookLikeMarkdown(rawText);
    replaceAttachmentImages(preview);
    lightlySanitizePreview(preview);
    scopeLocalStyleTagsToPreview(preview);
    preview.classList.remove("is-empty");
  }

  // Branche les événements d'édition sur UN bloc (indépendant des autres).
 // Branche les événements d'édition sur UN bloc (indépendant des autres).
  function bindBlockEvents(blockEl) {
    if (!blockEl) return;
    const textarea = blockEl.querySelector(".md-block-textarea");
    const preview = blockEl.querySelector(".md-block-preview");
    const wrap = blockEl.querySelector(".md-block-wrap");
    if (!textarea || !preview) return;

    textarea.addEventListener("input", () => {
      updateBlockPreviewLive(blockEl);
      if (typeof autoResizeTextarea === "function") {
        autoResizeTextarea(textarea);
      }
    });

    textarea.addEventListener("blur", () => {
      renderBlockPreview(blockEl);
    });

    preview.addEventListener("click", () => {
      showBlockEditor(blockEl);
    });

    preview.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showBlockEditor(blockEl);
      }
    });

 // Bouton "—" : masque/réaffiche le texte de CE bloc (la barre reste visible).
    const reduceBtn = blockEl.querySelector(".md-btn-reduce");
    if (reduceBtn && wrap) {
      reduceBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = wrap.style.display === "none";
        if (isHidden) {
          wrap.style.display = "";
          reduceBtn.textContent = "—";
          reduceBtn.title = "Masquer le texte";
        } else {
          wrap.style.display = "none";
          reduceBtn.textContent = "□";
          reduceBtn.title = "Réafficher le texte";
        }
      });
    }

    // Bouton "+" : insère un nouveau markdown vide juste en dessous de CE bloc.
    const addBtn = blockEl.querySelector(".md-btn-add");
    if (addBtn) {
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const index = parseInt(blockEl.dataset.mdIndex, 10);
        if (
          window.PagesMultiples &&
          typeof window.PagesMultiples.insertMarkdownAfter === "function"
        ) {
          window.PagesMultiples.insertMarkdownAfter(index);
        }
      });
    }

    // Bouton "✂" : supprime CE bloc (sauf s'il est le dernier — géré côté modèle
    // et par le grisage du bouton).
    const cutBtn = blockEl.querySelector(".md-btn-cut");
    if (cutBtn) {
      cutBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (cutBtn.disabled) return;
        const index = parseInt(blockEl.dataset.mdIndex, 10);
        if (
          window.PagesMultiples &&
          typeof window.PagesMultiples.removeMarkdownAt === "function"
        ) {
          window.PagesMultiples.removeMarkdownAt(index);
        }
      });
    }
    // Bouton "↑" : déplace CE bloc vers le haut (désactivé si déjà premier).
    const upBtn = blockEl.querySelector(".md-btn-up");
    if (upBtn) {
      upBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (upBtn.disabled) return;
        const index = parseInt(blockEl.dataset.mdIndex, 10);
        if (
          window.PagesMultiples &&
          typeof window.PagesMultiples.moveMarkdownUp === "function"
        ) {
          window.PagesMultiples.moveMarkdownUp(index);
        }
      });
    }
    // Bouton "↓" : déplace CE bloc vers le bas (désactivé si déjà dernier).
    const downBtn = blockEl.querySelector(".md-btn-down");
    if (downBtn) {
      downBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (downBtn.disabled) return;
        const index = parseInt(blockEl.dataset.mdIndex, 10);
        if (
          window.PagesMultiples &&
          typeof window.PagesMultiples.moveMarkdownDown === "function"
        ) {
          window.PagesMultiples.moveMarkdownDown(index);
        }
      });
    }

    // Collage d'image DANS CE bloc : insère la balise attachment: à la position
    // du curseur du textarea de ce bloc (l'image va donc dans le bon bloc).
    textarea.addEventListener("paste", async (event) => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items || !items.length) return;

      let imageFile = null;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          imageFile = item.getAsFile();
          break;
        }
      }
      if (!imageFile) return; // pas une image : collage texte normal

      event.preventDefault();

      try {
        if (
          !window.GestionImages ||
          typeof window.GestionImages.pasteImageIntoActivePage !== "function"
        ) {
          return;
        }

        const finalName = await window.GestionImages.pasteImageIntoActivePage(imageFile);
        if (!finalName) return;

        const baliseMd = `\n![${finalName}](attachment:${finalName})\n`;

        // Insertion à la position du curseur DANS ce textarea de bloc.
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        const before = textarea.value.slice(0, start);
        const after = textarea.value.slice(end);
        textarea.value = before + baliseMd + after;

        const newCursor = start + baliseMd.length;
        textarea.selectionStart = newCursor;
        textarea.selectionEnd = newCursor;

        if (typeof autoResizeTextarea === "function") {
          autoResizeTextarea(textarea);
        }

        // Mettre à jour l'aperçu de ce bloc et sauvegarder le modèle
        // (saveActivePageFromEditor lit tous les blocs séparément).
        updateBlockPreviewLive(blockEl);
        if (
          window.PagesMultiples &&
          typeof window.PagesMultiples.saveActivePageFromEditor === "function"
        ) {
          window.PagesMultiples.saveActivePageFromEditor();
        }
      } catch (err) {
        console.error("Erreur lors du collage d'image dans le bloc :", err);
        alert("Impossible d'insérer cette image.");
      }
    });
  }
// Met à jour l'état (activé/grisé) des boutons de structure de tous les blocs,
  // selon le nombre de blocs et la position de chacun.
  function updateBlockButtonsState() {
    const container = getMarkdownsContainer();
    if (!container) return;
    const blocks = container.querySelectorAll(".md-block");
    const total = blocks.length;

    blocks.forEach((blockEl, i) => {
      // ✂ : désactivé s'il n'y a qu'un seul bloc (invariant : au moins 1).
      const cutBtn = blockEl.querySelector(".md-btn-cut");
      if (cutBtn) {
        cutBtn.disabled = (total <= 1);
        cutBtn.classList.toggle("is-disabled", total <= 1);
      }
      // ↑ : désactivé si le bloc est le premier (i === 0).
      const upBtn = blockEl.querySelector(".md-btn-up");
      if (upBtn) {
        upBtn.disabled = (i === 0);
        upBtn.classList.toggle("is-disabled", i === 0);
      }

      // ↓ : désactivé si le bloc est le dernier (i === total - 1).
      const downBtn = blockEl.querySelector(".md-btn-down");
      if (downBtn) {
        downBtn.disabled = (i === total - 1);
        downBtn.classList.toggle("is-disabled", i === total - 1);
      }
    });
  }


  // Génère tous les blocs de la page dans le conteneur (affichage seul).
 function renderMarkdownBlocks(markdownsArray) {
    const container = getMarkdownsContainer();
    if (!container) return;

    const blocks = (Array.isArray(markdownsArray) && markdownsArray.length)
      ? markdownsArray
      : [""];

    // La régénération efface le contenu du conteneur (et donc un éventuel
    // overlay de blocage élève). On le note pour le réappliquer ensuite.
    container.innerHTML = "";

    blocks.forEach((text, index) => {
      const blockEl = buildMarkdownBlockEl(index, text);
      container.appendChild(blockEl);
      bindBlockEvents(blockEl);
      renderBlockPreview(blockEl);
    });

    updateBlockButtonsState();

    // Mode groupe : si l'élève doit rester bloqué, réappliquer l'overlay
    // (détruit par le innerHTML ci-dessus). Sans effet hors blocage.
    if (typeof window.reapplyStudentMarkdownLock === "function") {
      window.reapplyStudentMarkdownLock();
    }
     // Réappliquer le zoom courant aux blocs régénérés (sans toucher au reste).
    // Présente en Python et SQL ; absente en Linux (pas de zoom) → typeof protège.
    if (typeof window.reapplyMarkdownFontSize === "function") {
      window.reapplyMarkdownFontSize();
    }
  }
// Lit le contenu de TOUS les blocs du conteneur, dans l'ordre du DOM.
  // Renvoie un tableau de chaînes (toujours au moins un élément si des blocs
  // existent). Renvoie null si aucun bloc n'existe (le conteneur est vide),
  // ce qui permet à l'appelant de retomber sur l'ancien système.
  function getBlocksMarkdowns() {
    const container = getMarkdownsContainer();
    if (!container) return null;

    const textareas = container.querySelectorAll(".md-block-textarea");
    if (!textareas.length) return null;

    const result = [];
    textareas.forEach((ta) => {
      result.push(String(ta.value ?? ""));
    });
    return result;
  }


// Met le bloc d'index donné en mode édition (utilisé après insertion/déplacement).
  function focusBlockEditor(index) {
    const container = getMarkdownsContainer();
    if (!container) return;
    const blocks = container.querySelectorAll(".md-block");
    if (index < 0 || index >= blocks.length) return;
    showBlockEditor(blocks[index]);
  }

  window.MarkdownEditor = {
  init: initMarkdownEditor,
  showEditor,
  showPreview,
  refreshPreview: refreshMarkdownPreview,
  setNotebookGlobalCss,
  getNotebookGlobalCss,
  applyNotebookGlobalCss,
    syncCssTextarea,
     renderMarkdownBlocks,
      getBlocksMarkdowns,
      focusBlockEditor
};
})();

window.ajouterPageExempleMarkdown = function () {
  const exempleCommentaire = `# Guide Markdown (version notebook)

Bienvenue ! Cette zone est rendue avec un moteur Markdown proche de Jupyter/Basthon.

## Titres

# Titre principal
## Sous-titre
### Sous-sous-titre

## Gras, italique, lien

Texte en **gras**, en *italique* et un [lien](https://example.com).

## Liste

- pomme
- banane
- orange

## Bloc de code

\`\`\`python
def carre(x):
    return x * x

print(carre(5))
\`\`\`

## HTML simple

<div style="padding:6px 10px; border:1px solid #ccc; border-radius:8px;">
  Un bloc HTML simple
</div>

## Maths inline

La formule $E = mc^2$ doit s'afficher si KaTeX est disponible.

## Maths centrées

$$
\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$`;

  try {
    if (!window.PagesMultiples) {
      throw new Error("Module PagesMultiples non disponible.");
    }

    if (typeof window.PagesMultiples.saveActivePageFromEditor === "function") {
      window.PagesMultiples.saveActivePageFromEditor();
    }

    if (typeof window.PagesMultiples.addPage === "function") {
      window.PagesMultiples.addPage();
    } else {
      throw new Error("Fonction addPage introuvable.");
    }

    if (window.pythonEditor && typeof window.pythonEditor.setValue === "function") {
      window.pythonEditor.setValue("");
    }

    // Injecter le texte exemple selon le mode actif
    if (
      window.MARKDOWNS_MULTIPLES_ACTIFS &&
      window.MarkdownEditor &&
      typeof window.MarkdownEditor.renderMarkdownBlocks === "function"
    ) {
      // Mode multi-blocs : on injecte un seul bloc avec tout le texte
      window.MarkdownEditor.renderMarkdownBlocks([exempleCommentaire]);
    } else if (typeof window.setExerciseText === "function") {
      // Mode simple (fallback)
      window.setExerciseText(exempleCommentaire);
    }

    if (typeof window.PagesMultiples.saveActivePageFromEditor === "function") {
      window.PagesMultiples.saveActivePageFromEditor();
    }

    const generatedLinkEl = document.getElementById("generatedLink");
    if (generatedLinkEl) {
      generatedLinkEl.value = "";
      generatedLinkEl.style.display = "none";
    }

    if (typeof hideMenuPanels === "function") {
      hideMenuPanels();
    }
  } catch (err) {
    console.error("Impossible d'ajouter la page d'exemple Markdown :", err);
    alert("Impossible d'ajouter la page d'exemple Markdown.");
  }
};