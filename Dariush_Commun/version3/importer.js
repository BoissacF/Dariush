
/*gere toute importation, image, module, notebook*/
/* importation / exportation d'un notebook */

/* =========================================================
   NOTEBOOK JUPYTER (.ipynb)
   - export : commentaires -> markdown, codes -> code
   - import : markdown/raw -> texte brut, code -> code
   ========================================================= */

const JUPYTER_FILE_EXTENSION = ".ipynb";
const JUPYTER_FILE_MIME = "application/x-ipynb+json;charset=utf-8";

function notebookSourceToString(source) {
  if (Array.isArray(source)) {
    return source.join("");
  }
  return String(source ?? "");
}

function normalizeNotebookText(text) {
  return String(text ?? "").replace(/\r\n/g, "\n");
}

function getPagesForNotebookExport() {
  if (window.PagesMultiples && typeof window.PagesMultiples.getAllPages === "function") {
    return window.PagesMultiples.getAllPages();
  }

  return [{
    code:
      (window.pythonEditor && typeof window.pythonEditor.getValue === "function")
        ? window.pythonEditor.getValue()
        : "",
    topLine: 1,
    comment:
      (typeof window.getExerciseText === "function")
        ? window.getExerciseText()
        : ""
  }];
}



function buildNotebookObjectFromPages(pages) {
  const safePages = Array.isArray(pages) ? pages : [];
  const cells = [];

 // Construit l'objet attachments Jupyter pour UN texte de bloc donné :
  // on n'y met que les images de la page réellement citées via attachment:NOM
  // dans ce bloc. C'est la règle fidèle à Jupyter (l'image vit dans la cellule
  // où se trouve sa balise).
  function buildAttachmentsForBlock(blockText, pageImages) {
    if (!pageImages || typeof pageImages !== "object") return undefined;
    const att = {};
    for (const [name, dataUrl] of Object.entries(pageImages)) {
      // La balise attachment:NOM est-elle présente dans ce bloc ?
      const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("attachment:" + escaped + "(?![\\w.-])");
      if (!re.test(blockText)) continue;

      const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
      if (!match) continue;

      att[name] = { [match[1]]: [match[2]] };
    }
    return Object.keys(att).length ? att : undefined;
  }

  for (const page of safePages) {
    // Liste des blocs markdown de la page (toujours au moins un, invariant).
    const blocks = (Array.isArray(page?.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page?.comment || "")];

    const code = normalizeNotebookText(page?.code || "");
    const pageImages = (page?.images && typeof page.images === "object") ? page.images : {};

    // Une cellule markdown par bloc. On exporte AUSSI les blocs vides
    // (ils peuvent être volontaires : emplacement en attente de réponse).
    for (const rawBlock of blocks) {
      const normalized = normalizeNotebookText(rawBlock || "");
      const source = normalized
        .split("\n")
        .map(line => line.trimEnd() + "  ")
        .join("\n");

      const attachments = buildAttachmentsForBlock(normalized, pageImages);

      cells.push({
        cell_type: "markdown",
        metadata: {
          dariush_cell_role: "comment"
        },
        source: source,
        ...(attachments ? { attachments } : {})
      });
    }

    cells.push({
      cell_type: "code",
      metadata: {
        dariush_top_line: parseInt(page?.topLine, 10) || 1
      },
      execution_count: null,
      outputs: [],
      source: code
    });
  }

  return {
    cells,
    metadata: {
      language_info: {
        name: "python"
      },
      orig_nbformat: 4,
      dariush_python: {
        exporter: "Dariush Python",
        export_version: 1
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}


async function buildPagesFromNotebookObject(nb) {
  const cells = Array.isArray(nb?.cells) ? nb.cells : [];
  const pages = [];
let pendingMarkdowns = [];
  let pendingImages = {};
  let imagesWereOptimized = false;

  // Génère un nom unique dans pendingImages en suffixant _2, _3, ... avant l'extension
  function makeUniqueAttachmentName(originalName) {
    if (!Object.prototype.hasOwnProperty.call(pendingImages, originalName)) {
      return originalName;
    }
    const dotIndex = originalName.lastIndexOf(".");
    const base = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
    const ext  = dotIndex > 0 ? originalName.slice(dotIndex) : "";
    let i = 2;
    let candidate = `${base}_${i}${ext}`;
    while (Object.prototype.hasOwnProperty.call(pendingImages, candidate)) {
      i += 1;
      candidate = `${base}_${i}${ext}`;
    }
    return candidate;
  }

  // Remplace la PREMIÈRE occurrence de attachment:oldName par attachment:newName
  // dans le DERNIER bloc markdown ajouté (le dernier élément de pendingMarkdowns).
  function renameAttachmentReferenceInLastMarkdown(oldName, newName) {
    if (!pendingMarkdowns.length) return;
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(!\\[[^\\]]*\\]\\(\\s*attachment:)" + escaped + "(\\s*\\))");
    const lastIndex = pendingMarkdowns.length - 1;
    pendingMarkdowns[lastIndex] = pendingMarkdowns[lastIndex].replace(re, "$1" + newName + "$2");
  }

  for (const cell of cells) {
    const cellType = String(cell?.cell_type || "");
    const sourceText = normalizeNotebookText(notebookSourceToString(cell?.source));

    if (cellType === "markdown" || cellType === "raw") {
      // Chaque cellule markdown/raw devient un BLOC distinct (plus de fusion).
      // On garde même les cellules vides (peuvent être volontaires : attente de réponse).
      pendingMarkdowns.push(sourceText);

      const attachments = cell?.attachments;
      if (attachments && typeof attachments === "object") {
        for (const [name, attachmentData] of Object.entries(attachments)) {
          if (!attachmentData || typeof attachmentData !== "object") continue;

          const mimeEntries = Object.entries(attachmentData);
          if (!mimeEntries.length) continue;

          const [mime, chunks] = mimeEntries[0];
          const base64 = Array.isArray(chunks) ? chunks.join("") : String(chunks || "");

          if (!mime.startsWith("image/") || !base64) continue;

          const originalName = String(name || "image").trim() || "image";
          let finalDataUrl = `data:${mime};base64,${base64}`;

          try {
            if (
              window.GestionImages &&
              typeof window.GestionImages.convertImageDataUrlToJpegDataUrl === "function"
            ) {
              finalDataUrl = await window.GestionImages.convertImageDataUrlToJpegDataUrl(finalDataUrl, {
                maxSize: 1000,
                quality: 0.7
              });

              imagesWereOptimized = true;
            }
          } catch (err) {
            console.warn("Impossible d'optimiser une image importée du notebook :", err);
          }

          // Si le nom existe déjà (collision entre deux cellules markdown
          // qui utilisent toutes les deux "image.png"), on renomme et on met
          // à jour la référence dans le markdown qu'on vient d'ajouter.
          const finalName = makeUniqueAttachmentName(originalName);
          if (finalName !== originalName) {
            renameAttachmentReferenceInLastMarkdown(originalName, finalName);
          }
          pendingImages[finalName] = finalDataUrl;
        }
      }

      continue;
    }

    
if (cellType === "code") {
      // Règle rigoureuse : une page = au moins un markdown + un code.
      // Si aucun markdown n'a précédé ce code (deux codes consécutifs, ou
      // code en tête), on intercale un markdown vide.
      const markdownsForPage = pendingMarkdowns.length ? pendingMarkdowns : [""];

      pages.push({
        code: sourceText,
        topLine: parseInt(cell?.metadata?.dariush_top_line, 10) || 1,
        comment: (typeof joinMarkdowns === "function")
          ? joinMarkdowns(markdownsForPage)
          : markdownsForPage.join("\n\n"),
        markdowns: markdownsForPage,
        images: { ...pendingImages }
      });

      pendingMarkdowns = [];
      pendingImages = {};
    }
  }

  // Flush des markdowns / images résiduels après la dernière cellule code :
  // si le notebook se termine par une ou plusieurs cellules markdown,
  // on crée une page finale avec une zone de code VIDE (règle rigoureuse).
  if (pendingMarkdowns.length || Object.keys(pendingImages).length > 0) {
    const markdownsForPage = pendingMarkdowns.length ? pendingMarkdowns : [""];

    pages.push({
      code: "",
      topLine: 1,
      comment: (typeof joinMarkdowns === "function")
        ? joinMarkdowns(markdownsForPage)
        : markdownsForPage.join("\n\n"),
      markdowns: markdownsForPage,
      images: { ...pendingImages }
    });
    pendingMarkdowns = [];
    pendingImages = {};
  }

  // Cas dégénéré : notebook complètement vide -> au moins une page vide.
  if (!pages.length) {
    pages.push({
      code: "",
      topLine: 1,
      comment: "",
      markdowns: [""],
      images: {}
    });
  }
  return {
    pages,
    imagesWereOptimized
  };
}


async function openNotebookFileFromDisk(file) {
  if (!file) return;

  const raw = await file.text();
  if (!raw.trim()) {
    throw new Error("Le notebook est vide.");
  }

  let notebook;
  try {
    notebook = JSON.parse(raw);
  } catch (err) {
    throw new Error("Le fichier .ipynb n'est pas un JSON valide.");
  }

  if (!Array.isArray(notebook.cells)) {
    throw new Error("Notebook Jupyter invalide : propriété 'cells' absente.");
  }

 const hasMarkdown = notebook.cells.some(
  cell => String(cell?.cell_type || "") === "markdown"
);

const importResult = await buildPagesFromNotebookObject(notebook);
const pages = importResult.pages;
const imagesWereOptimized = importResult.imagesWereOptimized;

if (hasMarkdown || imagesWereOptimized) {
  let message =
    "Notebook importé.\n\n" +
    "Les cellules ont été adaptées au format Dariush Python (une page = texte + code).";

  if (imagesWereOptimized) {
    message +=
      "\n\nLes images du notebook ont été légèrement compressées et redimensionnées si nécessaire.";
  }

  alert(message);
}
  if (window.PagesMultiples && typeof window.PagesMultiples.setAllPages === "function") {
    window.PagesMultiples.setAllPages(pages, 0);
  } else if (window.pythonEditor) {
    const first = pages[0] || { code: "", comment: "" };
    window.pythonEditor.setValue(first.code || "");

    if (typeof window.setExerciseText === "function") {
      window.setExerciseText(first.comment || "");
    }
    
    if (typeof window.resetLoadedPageUi === "function") {
    window.resetLoadedPageUi();
  }
  }
  
  
    if (
    window.PythonAutosave &&
    typeof window.PythonAutosave.restorePersistentGlobalCss === "function"
  ) {
    window.PythonAutosave.restorePersistentGlobalCss();
  }

  const generatedLinkEl = document.getElementById("generatedLink");
  if (generatedLinkEl) {
    generatedLinkEl.value = "";
    generatedLinkEl.style.display = "none";
  }

  // Après l'import d'un notebook, on repart avec un interpréteur propre.
  // Cela évite qu'un worker fragilisé par une très grosse image reste planté.
  try {
    if (typeof window.resetWorkerPythonState === "function") {
      await window.resetWorkerPythonState();
    }
  } catch (err) {
    console.warn("Impossible de redémarrer le worker après import du notebook :", err);
  
}
}


/* =========================================================
   Conversion des blocs ```mermaid en images JPEG pour l'export .ipynb.
   Les éditeurs de notebooks ne rendent pas Mermaid : on remplace donc chaque
   bloc par une image (attachment Jupyter), en SVG -> JPEG (fond blanc).
   On reste en htmlLabels:false : labels en texte SVG pur, donc pas de
   foreignObject -> la conversion canvas->JPEG n'est pas bloquée.
   ========================================================= */
async function inlineMermaidAsJpegAttachments(pages) {
  const src = Array.isArray(pages) ? pages : [];
  if (!src.length || typeof window.mermaid === "undefined") return pages;

  const FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
  const fenceStart = /```mermaid[ \t]*\r?\n/;

  // Y a-t-il au moins un bloc mermaid à convertir ?
  let hasMermaid = false;
  for (const p of src) {
    const blocks = (Array.isArray(p?.markdowns) && p.markdowns.length)
      ? p.markdowns : [String(p?.comment || "")];
    if (blocks.some(b => fenceStart.test(String(b || "")))) { hasMermaid = true; break; }
  }
  if (!hasMermaid) return pages;

  // Config sûre pour l'export (texte SVG natif, pas de HTML/foreignObject)
  try {
    window.mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", theme: "default",
      flowchart: { htmlLabels: false }
    });
  } catch (e) {}

  const SCALE = 2;        // rendu généreux -> labels nets
  const QUALITY = 0.92;   // qualité JPEG
  let counter = 0;

  function svgToJpeg(svg) {
    return new Promise(function (resolve, reject) {
      let w = 0, h = 0;
      try {
        const el = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
        w = parseFloat(el.getAttribute("width")) || 0;
        h = parseFloat(el.getAttribute("height")) || 0;
        if (!w || !h) {
          const vb = (el.getAttribute("viewBox") || "").trim().split(/[ ,]+/).map(Number);
          if (vb.length === 4) { w = vb[2]; h = vb[3]; }
        }
      } catch (e) {}
      if (!w || !h) { w = 600; h = 400; }

      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () {
        const cw = Math.max(1, Math.round(w * SCALE));
        const ch = Math.max(1, Math.round(h * SCALE));
        const canvas = document.createElement("canvas");
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cw, ch); // fond blanc (JPEG)
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        try { resolve(canvas.toDataURL("image/jpeg", QUALITY)); }
        catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("SVG illisible")); };
      img.src = url;
    });
  }

  async function fenceToImage(code) {
    counter++;
    const id = "nbmmd-" + Date.now() + "-" + counter;
    const res = await window.mermaid.render(id, code);
    const svg = (res && res.svg) ? res.svg : "";
    if (!svg) throw new Error("rendu vide");
    return await svgToJpeg(svg);
  }

  const out = [];
  for (let pi = 0; pi < src.length; pi++) {
    const page = src[pi] || {};
    const baseImages = (page.images && typeof page.images === "object") ? page.images : {};
    const newImages = Object.assign({}, baseImages);
    const hadMarkdowns = Array.isArray(page.markdowns) && page.markdowns.length;
    const blocks = hadMarkdowns ? page.markdowns.slice() : [String(page.comment || "")];

    for (let bi = 0; bi < blocks.length; bi++) {
      let text = String(blocks[bi] || "");
      if (!fenceStart.test(text)) continue;

      const matches = [];
      text.replace(FENCE, function (whole, inner) { matches.push({ whole, code: String(inner).trim() }); return whole; });

      for (let mi = 0; mi < matches.length; mi++) {
        let dataUrl;
        try { dataUrl = await fenceToImage(matches[mi].code); }
        catch (e) { continue; } // diagramme invalide : on laisse le bloc en l'état
        const name = "graphe_" + (pi + 1) + "_" + (bi + 1) + "_" + (mi + 1) + ".jpg";
        newImages[name] = dataUrl;
        text = text.replace(matches[mi].whole, "![graphe](attachment:" + name + ")");
      }
      blocks[bi] = text;
    }

    const newPage = Object.assign({}, page, { images: newImages });
    if (hadMarkdowns) newPage.markdowns = blocks; else newPage.comment = blocks[0];
    out.push(newPage);
  }

  // Restaure le mode habituel (rendu live de Dariush avec labels HTML)
  try {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
  } catch (e) {}

  return out;
}


async function saveNotebookFileToDisk() {
  // Le notebook est construit APRÈS le choix de l'emplacement :
  // la fenêtre "Enregistrer sous" doit s'ouvrir tout de suite après le clic.
  const buildJson = async () => {
    let pages = getPagesForNotebookExport();

    // Convertit les blocs ```mermaid en images JPEG (attachments) :
    // les éditeurs de notebooks ne rendent pas Mermaid. En cas d'échec,
    // on garde les blocs en l'état (texte) sans bloquer l'export.
    try {
      pages = await inlineMermaidAsJpegAttachments(pages);
    } catch (err) {
      console.warn("Conversion Mermaid -> image impossible, les blocs restent en texte :", err);
    }

    // Nettoyage À L'EXPORT (sur copie) : on retire les images non citées
    // par les blocs avant de construire le notebook.
    if (
      window.GestionImages &&
      typeof window.GestionImages.pruneUnusedImages === "function"
    ) {
      pages = window.GestionImages.pruneUnusedImages(pages);
    }

    const notebook = buildNotebookObjectFromPages(pages);
    return JSON.stringify(notebook, null, 2);
  };

  return saveTextFileAs(buildJson, {
    defaultName: "activite" + JUPYTER_FILE_EXTENSION,
    extension: JUPYTER_FILE_EXTENSION,
    mimeType: JUPYTER_FILE_MIME,
    promptLabel: "Nom du notebook Jupyter :",
    description: "Notebook Jupyter"
  });
}


/** gestion des images avec show() de PIL
pour pouvoir importer des images et les afficher
*/
let currentPythonImageUrl = null;
let pythonImageUrls = [];
let currentPythonImageIndex = -1;

function initImageModal() {
  const modal = document.getElementById("imageModal");
  const modalBox = document.getElementById("imageModalBox");
  const header = document.getElementById("imageModalHeader");
  const closeBtn = document.getElementById("closeImageModal");
  const downloadBtn = document.getElementById("downloadImageBtn");
  const prevBtn = document.getElementById("prevImageBtn");
  const nextBtn = document.getElementById("nextImageBtn");
  const counter = document.getElementById("imageCounter");
  const img = document.getElementById("pythonImageViewer");
  const container = document.getElementById("imageContainer");

  if (!modal || !modalBox || !header || !closeBtn || !img || !container) return;

  let scale = 1;

  function applyZoom() {
    img.style.transform = `scale(${scale})`;
    img.style.transformOrigin = "center center";
  }

  function resetZoom() {
    scale = 1;

    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    img.style.width = "auto";
    img.style.height = "auto";
    img.style.display = "inline-block";

    container.style.overflow = "auto";
    container.style.cursor = "zoom-in";
    container.scrollTop = 0;
    container.scrollLeft = 0;

    applyZoom();
  }

  function resetModalPosition() {
    modalBox.style.left = "50%";
    modalBox.style.top = "4vh";
    modalBox.style.transform = "translateX(-50%)";
  }

  function updateImageCounter() {
    if (!counter) return;

    if (!pythonImageUrls.length || currentPythonImageIndex < 0) {
      counter.textContent = "0/0";
      return;
    }

    counter.textContent = `${currentPythonImageIndex + 1}/${pythonImageUrls.length}`;
  }

  function showImageAt(index) {
    if (!img || !pythonImageUrls.length) return;
    if (index < 0 || index >= pythonImageUrls.length) return;

    currentPythonImageIndex = index;
    currentPythonImageUrl = pythonImageUrls[index];
    img.src = currentPythonImageUrl;

    resetZoom();
    updateImageCounter();
    modal.classList.remove("hidden");
  }

  function closeModal() {
    modal.classList.add("hidden");
    resetZoom();
    resetModalPosition();
  }

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeModal();
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  if (prevBtn) {
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentPythonImageIndex > 0) {
        showImageAt(currentPythonImageIndex - 1);
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (currentPythonImageIndex < pythonImageUrls.length - 1) {
        showImageAt(currentPythonImageIndex + 1);
      }
    });
  }

  img.addEventListener("click", (e) => {
    e.stopPropagation();

    scale *= 1.5;
    if (scale > 6) scale = 1;

    applyZoom();
    container.style.cursor = scale === 1 ? "zoom-in" : "zoom-out";
  });

  container.addEventListener("wheel", (e) => {
    e.preventDefault();

    const factor = e.deltaY < 0 ? 1.2 : 0.8;
    scale *= factor;

    if (scale < 1) scale = 1;
    if (scale > 10) scale = 10;

    applyZoom();
    container.style.cursor = scale === 1 ? "zoom-in" : "zoom-out";
  }, { passive: false });

  if (downloadBtn) {
    downloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!img.src) return;

      const a = document.createElement("a");
      a.href = img.src;
      a.download = "image_python.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  header.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;

    isDragging = true;

    const rect = modalBox.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    modalBox.style.transform = "none";
    modalBox.style.left = rect.left + "px";
    modalBox.style.top = rect.top + "px";

    header.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });

 header.addEventListener("pointermove", (e) => {
    if (!isDragging) return;

    let left = e.clientX - dragOffsetX;
    let top = e.clientY - dragOffsetY;

    // Contraintes : le header doit rester visible et cliquable
    const boxRect = modalBox.getBoundingClientRect();
    const headerHeight = header.offsetHeight || 40;
    const minVisible = 40;  // au moins 40px du header restent attrapables

    const maxLeft = window.innerWidth - minVisible;
    const minLeft = -(boxRect.width - minVisible);
    const maxTop = window.innerHeight - headerHeight;
    const minTop = 0;  // jamais au-dessus du haut de l'écran

    if (left > maxLeft) left = maxLeft;
    if (left < minLeft) left = minLeft;
    if (top > maxTop) top = maxTop;
    if (top < minTop) top = minTop;

    modalBox.style.left = left + "px";
    modalBox.style.top = top + "px";
  });

  function stopDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    header.releasePointerCapture?.(e.pointerId);
  }

  header.addEventListener("pointerup", stopDrag);
  header.addEventListener("pointercancel", stopDrag);

  updateImageCounter();

  window.resetPythonImageModalZoom = resetZoom;
  window.resetPythonImageModalPosition = resetModalPosition;
  window.showPythonImageAt = showImageAt;
}

document.addEventListener("DOMContentLoaded", initImageModal);

function displayPythonImageFromBase64(base64Png) {
  const modal = document.getElementById("imageModal");
  if (!modal) return;

  const binary = atob(base64Png);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: "image/png" });
  const objectUrl = URL.createObjectURL(blob);

  pythonImageUrls.push(objectUrl);

  if (typeof window.resetPythonImageModalPosition === "function") {
    window.resetPythonImageModalPosition();
  }

  if (typeof window.showPythonImageAt === "function") {
    window.showPythonImageAt(pythonImageUrls.length - 1);
  }
}

function resetPythonImageGallery() {
  for (const url of pythonImageUrls) {
    URL.revokeObjectURL(url);
  }

  pythonImageUrls = [];
  currentPythonImageUrl = null;
  currentPythonImageIndex = -1;
}

window.resetPythonImageGallery = resetPythonImageGallery;
window.displayPythonImageFromBase64 = displayPythonImageFromBase64;

/* =========================================================
   Sépare les lignes from X import * ou from X import*
   ========================================================= */
function splitStarImports(code) {
  const lines = String(code || "").split("\n");
  const starImports = [];
  const mainLines = [];

  for (const line of lines) {
    if (/^\s*from\s+[A-Za-z0-9_\.]+\s+import\s*\*/.test(line)) {
      starImports.push(line);
    } else {
      mainLines.push(line);
    }
  }

  return {
    starImports: starImports.join("\n"),
    mainCode: mainLines.join("\n")
  };
}

/* =========================================================
   Choix : ouvrir un fichier ou charger un module / ressource
   ========================================================= */
function askOpenPythonAction() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.35)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "9999";

    const panel = document.createElement("div");
    panel.style.background = "white";
    panel.style.padding = "16px";
    panel.style.borderRadius = "10px";
    panel.style.minWidth = "340px";
    panel.style.maxWidth = "90vw";
    panel.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";
    overlay.appendChild(panel);

    const title = document.createElement("div");
    title.textContent = "Que veux-tu ouvrir ?";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "12px";
    panel.appendChild(title);
    if (window.DariushDrive) window.DariushDrive.attachCheckbox(title);
    const actions = [
  {
    value: "open_dariush",
    label: "1 : Ouvrir un fichier Dariush Python (.dpy)"
  },
  {
    value: "open_file",
    label: "2 : Importer un fichier Python et le copier dans la zone de code"
  },
  {
    value: "open_notebook",
    label: "3 : Importer un notebook Jupyter (.ipynb)"
  },
  {
    value: "load_module",
    label: "4 : Charger un module Python pour pouvoir l'importer"
  },
  {
    value: "load_resource",
    label: "5 : Charger une image ou un autre fichier ressource"
  },
  {
    value: "import_pdf",
    label: "6 : Importer un PDF pour le transformer en notebook"
  }
];

   

    const list = document.createElement("div");
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "8px";
    panel.appendChild(list);

    function close(value) {
      overlay.remove();
      resolve(value);
    }

 for (const action of actions) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = action.label;

  btn.className = "nav-item";
  btn.style.width = "100%";
  btn.style.justifyContent = "flex-start";
  btn.style.textAlign = "left";

  btn.addEventListener("click", () => close(action.value));
  list.appendChild(btn);
}

const btnRow = document.createElement("div");
btnRow.style.display = "flex";
btnRow.style.justifyContent = "flex-end";
btnRow.style.marginTop = "12px";
panel.appendChild(btnRow);

const btnCancel = document.createElement("button");
btnCancel.type = "button";
btnCancel.textContent = "Annuler";

btnCancel.className = "nav-item"; // cohérence visuelle

btnCancel.addEventListener("click", () => close(null));
btnRow.appendChild(btnCancel);

overlay.addEventListener("click", (e) => {
  if (e.target === overlay) close(null);
});

document.body.appendChild(overlay);
  });
}

function choosePythonFile() {
  // Case "Google Drive" cochée : le fichier vient du Drive
  if (window.DariushDrive && window.DariushDrive.isEnabled()) {
    const driveInput = document.getElementById("openPyFile");
    return window.DariushDrive.pickFile(driveInput ? driveInput.accept : "");
  }

  return new Promise((resolve) => {
    const input = document.getElementById("openPyFile");
    if (!input) {
      resolve(null);
      return;
    }

    input.value = "";

    const onChange = () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      resolve(file);
    };

    input.addEventListener("change", onChange, { once: true });
    input.click();
  });
}

async function loadPythonModuleFromDisk(file) {
  if (!file) return null;

  const filename = file.name || "";
  if (!filename.toLowerCase().endsWith(".py")) {
    throw new Error("Le fichier choisi doit être un fichier .py");
  }

  const moduleName = filename.replace(/\.py$/i, "");

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) {
    throw new Error(
      "Nom de module invalide. Utilise un nom de fichier Python simple, par exemple monmodule.py"
    );
  }

  // Pyodide tourne dans le worker : on écrit le fichier dans le FS
  // du worker (exactement comme pour les ressources) : la page principale
  // n'a pas d'instance Pyodide.
  if (typeof window.writeFileToWorker !== "function") {
    throw new Error("Worker Python non disponible.");
  }

  const bytes = new TextEncoder().encode(await file.text());
  await window.writeFileToWorker(`${moduleName}.py`, bytes);

  return moduleName;
}

async function loadResourceFileIntoPyodide(file) {
  if (!file) {
    throw new Error("Aucun fichier choisi.");
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const filename = file.name;

  if (typeof window.writeFileToWorker !== "function") {
    throw new Error("Worker Python non disponible.");
  }

  await window.writeFileToWorker(filename, bytes);

  return filename;
}


async function openDariushFileFromDisk(file) {
  if (!file) return;

  const raw = (await file.text()).trim();
  if (!raw) return;

  if (typeof decode_url !== "function") {
    throw new Error("Fonction decode_url introuvable.");
  }
  
  const fakeUrl = "https://physalgo.fr/Dariush_Python/index.html?" + raw;
     
    
  const ok = await decode_url(fakeUrl);

  if (!ok) {
    throw new Error("Impossible d'ouvrir le fichier Dariush Python.");
  }
}

function showImportInfoModal(title, message) {
  const existing = document.getElementById("importInfoModalOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "importInfoModalOverlay";
  overlay.className = "menu-modal-overlay";
  overlay.style.display = "flex";

  const windowEl = document.createElement("div");
  windowEl.className = "menu-modal-window";
  windowEl.style.width = "min(700px, calc(100vw - 32px))";

  windowEl.innerHTML = `
    <div class="menu-modal-header">
      <h3>${title}</h3>
      <button class="menu-close-btn nav-item nav-btn" type="button" aria-label="Fermer">✕</button>
    </div>

    <div class="menu-modal-body">
      <div class="import-info-content"></div>
    </div>

    <div class="menu-modal-footer">
      <button class="nav-item nav-btn" type="button">Fermer</button>
    </div>
  `;

  const content = windowEl.querySelector(".import-info-content");
  content.textContent = message;

  function closeModal() {
    overlay.remove();
  }

  const buttons = windowEl.querySelectorAll("button");
  buttons.forEach(btn => btn.addEventListener("click", closeModal));

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener("keydown", function onKeyDown(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", onKeyDown);
    }
  });

  overlay.appendChild(windowEl);
  document.body.appendChild(overlay);
}

async function handleOpenPythonAction() {
  const action = await askOpenPythonAction();
  if (!action) return;

  const input = document.getElementById("openPyFile");
  if (!input) {
    throw new Error("Champ de sélection de fichier introuvable.");
  }

  input.value = "";

  if (action === "open_dariush") {
    input.accept = ".dpy";

    const file = await choosePythonFile();
    if (!file) return;

    await openDariushFileFromDisk(file);
    return;
  }

  if (action === "open_file") {
    input.accept = ".py";

    const file = await choosePythonFile();
    if (!file) return;

    await openPythonFileFromDisk(file);
    return;
  }
  
  if (action === "open_notebook") {
  input.accept = ".ipynb";

  const file = await choosePythonFile();
  if (!file) return;

  await openNotebookFileFromDisk(file);
  return;
}

  if (action === "load_module") {
    input.accept = ".py";

    const file = await choosePythonFile();
    if (!file) return;

    const moduleName = await loadPythonModuleFromDisk(file);
    showImportInfoModal(
      "Module chargé",
      `Module "${moduleName}" chargé.\n\nVous pouvez à présent l'importer : import ${moduleName}`
    );
    
    return;
  }

  if (action === "load_resource") {
    input.accept = ".png,.jpg,.jpeg,.gif,.bmp,.webp,.txt,.csv,.json";

    const file = await choosePythonFile();
    if (!file) return;

    const filename = await loadResourceFileIntoPyodide(file);
     showImportInfoModal(
      "Ressource chargée",
      `Fichier "${filename}" chargé en mémoire.\n\nVous pouvez maintenant l'utiliser avec Python`
    );
    
    return;
  }

  if (action === "import_pdf") {
    if (window.ImporterPdf && typeof window.ImporterPdf.open === "function") {
      await window.ImporterPdf.open();
    } else {
      throw new Error("Le module d'import PDF (importer_pdf.js) n'est pas chargé.");
    }
    return;
  }

  throw new Error("Action inconnue : " + action);
}

async function preparePythonImports(code) {
  if (!window.pyodideInstance || !code) return;

  await window.pyodideInstance.loadPackagesFromImports(code, {
    messageCallback: () => {},
    errorCallback: () => {}
  });
}

window.handleOpenPythonAction = handleOpenPythonAction;
window.preparePythonImports = preparePythonImports;
window.splitStarImports = splitStarImports;
/* =========================================================================
   Exposition pour la generation de notebook (RAG.js).
   Importe un objet notebook (.ipynb deja en memoire) a la place du fichier
   actuel, en reproduisant la meme sequence que l'import depuis un fichier.
   ========================================================================= */
window.importNotebookObject = async function (nb) {
  if (!nb || !Array.isArray(nb.cells)) {
    throw new Error("Notebook invalide : propriete 'cells' absente.");
  }

  const importResult = await buildPagesFromNotebookObject(nb);
  const pages = importResult.pages;

  if (window.PagesMultiples && typeof window.PagesMultiples.setAllPages === "function") {
    window.PagesMultiples.setAllPages(pages, 0);
  } else if (window.pythonEditor) {
    const first = pages[0] || { code: "", comment: "" };
    window.pythonEditor.setValue(first.code || "");
    if (typeof window.setExerciseText === "function") {
      window.setExerciseText(first.comment || "");
    }
    if (typeof window.resetLoadedPageUi === "function") {
      window.resetLoadedPageUi();
    }
  }

  if (
    window.PythonAutosave &&
    typeof window.PythonAutosave.restorePersistentGlobalCss === "function"
  ) {
    window.PythonAutosave.restorePersistentGlobalCss();
  }

  const generatedLinkEl = document.getElementById("generatedLink");
  if (generatedLinkEl) {
    generatedLinkEl.value = "";
    generatedLinkEl.style.display = "none";
  }

  try {
    if (typeof window.resetWorkerPythonState === "function") {
      await window.resetWorkerPythonState();
    }
  } catch (err) {
    console.warn("Impossible de redemarrer le worker apres generation :", err);
  }
};