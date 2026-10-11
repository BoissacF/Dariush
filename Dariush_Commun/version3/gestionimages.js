(function () {
  "use strict";

  function normalizeImageName(name) {
    const raw = String(name || "").trim();
    if (!raw) return "image.jpg";
    return raw.replace(/[\\/:*?"<>|]/g, "_");
  }

  function ensurePageImages(page) {
    if (!page || typeof page !== "object") return {};
    if (!page.images || typeof page.images !== "object") {
      page.images = {};
    }
    return page.images;
  }

  function getImagesForPage(page) {
    const images = ensurePageImages(page);
    return { ...images };
  }

  function setImagesForPage(page, images) {
    if (!page || typeof page !== "object") return;
    page.images = {};

    if (!images || typeof images !== "object") return;

    for (const [name, dataUrl] of Object.entries(images)) {
      const safeName = normalizeImageName(name);
      page.images[safeName] = String(dataUrl || "");
    }
  }

  function addImageToPage(page, name, dataUrl) {
    if (!page || typeof page !== "object") return null;

    const images = ensurePageImages(page);
    const baseName = normalizeImageName(name);
    let finalName = baseName;

    if (images[finalName]) {
      const dot = baseName.lastIndexOf(".");
      const stem = dot === -1 ? baseName : baseName.slice(0, dot);
      const ext = dot === -1 ? "" : baseName.slice(dot);

      let i = 2;
      while (images[finalName]) {
        finalName = `${stem}_${i}${ext}`;
        i++;
      }
    }

    images[finalName] = String(dataUrl || "");
    return finalName;
  }

  function getImageDataUrlFromPage(page, name) {
    const images = ensurePageImages(page);
    const safeName = normalizeImageName(name);
    return images[safeName] || "";
  }

  function removeImageFromPage(page, name) {
    const images = ensurePageImages(page);
    const safeName = normalizeImageName(name);
    delete images[safeName];
  }

  function pageHasImages(page) {
    const images = ensurePageImages(page);
    return Object.keys(images).length > 0;
  }

  function pagesHaveImages(pages) {
    if (!Array.isArray(pages)) return false;
    return pages.some(page => pageHasImages(page));
  }

  function getActivePageObject() {
    if (!window.PagesMultiples) return null;
    if (typeof window.PagesMultiples.getAllPages !== "function") return null;
    if (typeof window.PagesMultiples.getActivePageIndex !== "function") return null;

    const pages = window.PagesMultiples.getAllPages();
    const index = window.PagesMultiples.getActivePageIndex();

    if (!Array.isArray(pages)) return null;
    if (index < 0 || index >= pages.length) return null;

    return pages[index];
  }

  function getActivePageImageDataUrl(name) {
    if (!window.PagesMultiples) return "";
    if (typeof window.PagesMultiples.getAllPages !== "function") return "";
    if (typeof window.PagesMultiples.getActivePageIndex !== "function") return "";

    const pages = window.PagesMultiples.getAllPages();
    const index = window.PagesMultiples.getActivePageIndex();

    if (!Array.isArray(pages)) return "";
    if (index < 0 || index >= pages.length) return "";

    const page = pages[index];
    return getImageDataUrlFromPage(page, name);
  }

  function getActivePageData() {
    if (!window.PagesMultiples) return null;
    if (typeof window.PagesMultiples.getAllPages !== "function") return null;
    if (typeof window.PagesMultiples.getActivePageIndex !== "function") return null;

    const pages = window.PagesMultiples.getAllPages();
    const index = window.PagesMultiples.getActivePageIndex();

    if (!Array.isArray(pages)) return null;
    if (index < 0 || index >= pages.length) return null;

    return {
      pages,
      index,
      page: pages[index]
    };
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Impossible de lire l'image."));
      reader.readAsDataURL(file);
    });
  }
  
  
 async function convertImageFileToJpegDataUrl(file, options = {}) {
  const maxSize = Number(options.maxSize || 1000);
  const quality = Number(options.quality || 0.7);

  const objectUrl = URL.createObjectURL(file);

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Impossible de charger l'image collée."));
      image.src = objectUrl;
    });

    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;

    if (!width || !height) {
      throw new Error("Dimensions d'image invalides.");
    }

    // Capture partielle d'écran en HiDPI (Retina / mise à l'échelle Windows) :
    // l'OS double (ou x1.5) les pixels par rapport à la zone réellement vue.
    // On ramène l'image à sa taille "visuelle" en divisant par la densité écran,
    // pour qu'une capture s'affiche à la même taille qu'à l'écran.
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    const scale = Math.min(1, (maxSize / width), (maxSize / height)) / dpr;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D indisponible.");
    }

    // fond blanc pour éviter les surprises si image transparente
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const jpegDataUrl = canvas.toDataURL("image/jpeg", quality);

    if (!jpegDataUrl || !jpegDataUrl.startsWith("data:image/jpeg;base64,")) {
      throw new Error("Conversion JPEG impossible.");
    }

    return jpegDataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
  
  
  
  async function convertImageDataUrlToJpegDataUrl(dataUrl, options = {}) {
  const maxSize = Number(options.maxSize || 1000);
  const quality = Number(options.quality || 0.7);

  const source = String(dataUrl || "").trim();
  if (!source.startsWith("data:image/")) {
    throw new Error("Data URL image invalide.");
  }

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Impossible de charger l'image du notebook."));
    image.src = source;
  });

  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;

  if (!width || !height) {
    throw new Error("Dimensions d'image invalides.");
  }

  const scale = Math.min(1, maxSize / width, maxSize / height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D indisponible.");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  const jpegDataUrl = canvas.toDataURL("image/jpeg", quality);

  if (!jpegDataUrl || !jpegDataUrl.startsWith("data:image/jpeg;base64,")) {
    throw new Error("Conversion JPEG impossible.");
  }

  return jpegDataUrl;
}

  function insertTextAtCursor(textarea, textToInsert) {
    if (!textarea) return;

    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);

    textarea.value = before + textToInsert + after;

    const newPos = start + textToInsert.length;
    textarea.selectionStart = newPos;
    textarea.selectionEnd = newPos;
  }

  function extractReferencedAttachmentNames(markdownText) {
    const text = String(markdownText || "");
    const names = new Set();
    const regex = /!\[[^\]]*\]\(\s*attachment:([^)]+?)\s*\)/g;

    let match;
    while ((match = regex.exec(text)) !== null) {
      const rawName = String(match[1] || "").trim();
      if (!rawName) continue;
      names.add(normalizeImageName(rawName));
    }

    return names;
  }

  function cleanupUnusedImagesForPage(page, markdownText) {
    if (!page || typeof page !== "object") return false;

    const images = ensurePageImages(page);
    const referencedNames = extractReferencedAttachmentNames(markdownText);
    let changed = false;

    for (const name of Object.keys(images)) {
      if (!referencedNames.has(normalizeImageName(name))) {
        delete images[name];
        changed = true;
      }
    }

    return changed;
  }

  function cleanupUnusedImagesOnActivePage(markdownText, options = {}) {
    const active = getActivePageData();
    if (!active || !active.page) return false;

    const changed = cleanupUnusedImagesForPage(active.page, markdownText);
    if (!changed) return false;

    active.page.comment = String(markdownText || "");

    if (
      window.PagesMultiples &&
      typeof window.PagesMultiples.setAllPages === "function"
    ) {
      window.PagesMultiples.setAllPages(active.pages, active.index);
    }

    const restoreSelection = options.restoreSelection || null;

    requestAnimationFrame(() => {
      const textarea = document.getElementById("exerciseText");
      if (!textarea) return;

      textarea.value = String(markdownText || "");

      if (restoreSelection) {
        const start = Math.max(0, Math.min(restoreSelection.start, textarea.value.length));
        const end = Math.max(0, Math.min(restoreSelection.end, textarea.value.length));
        textarea.selectionStart = start;
        textarea.selectionEnd = end;
      }

      if (typeof autoResizeTextarea === "function") {
        autoResizeTextarea(textarea);
      }
    });

    return true;
  }

 
  // MARKDOWNS MULTIPLES — nettoyage À L'EXPORT (sur COPIE).
  // Prend un tableau de pages, renvoie un NOUVEAU tableau où, pour chaque page,
  // le coffre 'images' ne contient que les images réellement citées via
  // attachment: dans l'UN QUELCONQUE de ses blocs 'markdowns' (union de tous
  // les blocs, pour ne jamais supprimer une image citée dans un autre bloc).
  // Ne modifie PAS les pages d'origine ni la mémoire : c'est une copie destinée
  // à l'export (fichier .dpy / lien / snapshot / notebook).
  function pruneUnusedImages(pages) {
    if (!Array.isArray(pages)) return pages;

    return pages.map((page) => {
      const safePage = page || {};
      const images = (safePage.images && typeof safePage.images === "object")
        ? safePage.images
        : {};

      // Texte de référence = tous les blocs réunis. On prend markdowns si présent,
      // sinon on retombe sur comment (compat mono-bloc / anciennes données).
      let allText = "";
      if (Array.isArray(safePage.markdowns) && safePage.markdowns.length) {
        allText = safePage.markdowns.join("\n");
      } else {
        allText = String(safePage.comment || "");
      }

      const referenced = extractReferencedAttachmentNames(allText);

      // Coffre réduit : on ne garde que les images citées.
      const prunedImages = {};
      for (const name of Object.keys(images)) {
        if (referenced.has(normalizeImageName(name))) {
          prunedImages[name] = images[name];
        }
      }

      // On renvoie une COPIE de la page avec le coffre réduit.
      // (Les autres champs sont conservés tels quels.)
      return Object.assign({}, safePage, { images: prunedImages });
    });
  }
  
  async function handlePasteImageIntoMarkdown(event) {
  const textarea = event?.target;
  if (!textarea || textarea.id !== "exerciseText") return false;

  const items = event.clipboardData?.items;
  if (!items || !items.length) return false;

  let imageFile = null;

  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      imageFile = item.getAsFile();
      break;
    }
  }

  if (!imageFile) return false;

  event.preventDefault();

  const active = getActivePageData();
  if (!active || !active.page) {
    console.warn("Aucune page active disponible pour coller l'image.");
    return false;
  }

  const dataUrl = await convertImageFileToJpegDataUrl(imageFile, {
    maxSize: 1000,
    quality: 0.7
  });

  const suggestedName = "image.jpg";
  const finalName = addImageToPage(active.page, suggestedName, dataUrl);
  const markdownToInsert = `\n![${finalName}](attachment:${finalName})\n`;

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const nextValue = before + markdownToInsert + after;
  const newCursor = start + markdownToInsert.length;

  active.page.comment = nextValue;

  if (
    window.PagesMultiples &&
    typeof window.PagesMultiples.setAllPages === "function"
  ) {
    window.PagesMultiples.setAllPages(active.pages, active.index);
  }

  requestAnimationFrame(() => {
    const freshTextarea = document.getElementById("exerciseText");
    if (!freshTextarea) return;

    freshTextarea.value = nextValue;
    freshTextarea.selectionStart = newCursor;
    freshTextarea.selectionEnd = newCursor;

    if (typeof autoResizeTextarea === "function") {
      autoResizeTextarea(freshTextarea);
    }

    freshTextarea.focus();

    if (typeof window.setExerciseText === "function") {
      window.setExerciseText(nextValue);
    }

    if (
      window.PagesMultiples &&
      typeof window.PagesMultiples.saveActivePageFromEditor === "function"
    ) {
      window.PagesMultiples.saveActivePageFromEditor();
    }

    if (
      window.MarkdownEditor &&
      typeof window.MarkdownEditor.refreshPreview === "function"
    ) {
      window.MarkdownEditor.refreshPreview();
    }
  });

  return true;
}
// MARKDOWNS MULTIPLES : convertit une image collée, l'ajoute au coffre de la
  // page active, et renvoie le NOM final de l'attachment (ou null si échec).
  // Cette fonction ne touche PAS au texte : c'est l'appelant (markdown.js) qui
  // insère la balise attachment: dans le bon bloc.
 async function pasteImageIntoActivePage(imageFile) {
    if (!imageFile) return null;

    // On vise la VRAIE page interne (par référence), pas la copie renvoyée
    // par getAllPages(), sinon l'image serait ajoutée à un objet jetable.
    let realPage = null;
    if (
      window.PagesMultiples &&
      typeof window.PagesMultiples.getCurrentPageRef === "function"
    ) {
      realPage = window.PagesMultiples.getCurrentPageRef();
    }
    // Repli : ancien comportement si getCurrentPageRef indisponible.
    if (!realPage) {
      const active = getActivePageData();
      realPage = active && active.page;
    }
    if (!realPage) {
      console.warn("Aucune page active disponible pour coller l'image.");
      return null;
    }

    const dataUrl = await convertImageFileToJpegDataUrl(imageFile, {
      maxSize: 1000,
      quality: 0.7
    });

    const suggestedName = "image.jpg";
    const finalName = addImageToPage(realPage, suggestedName, dataUrl);
    return finalName;
  }
  function bindMarkdownImagePaste() {
    const textarea = document.getElementById("exerciseText");
    if (!textarea) return;

    // Si le système multi-blocs est actif, l'ancien textarea #exerciseText est
    // caché et inutilisé : on ne branche NI le collage NI le nettoyage à la volée
    // dessus. Le collage est géré par bloc (markdown.js) et le nettoyage se fait
    // à l'export (pruneUnusedImages).
    if (window.MARKDOWNS_MULTIPLES_ACTIFS) {
      return;
    }

    textarea.addEventListener("paste", async (event) => {
      try {
        await handlePasteImageIntoMarkdown(event);
      } catch (err) {
        console.error("Erreur lors du collage d'image :", err);
        alert("Impossible d'insérer cette image.");
      }
    });

    textarea.addEventListener("input", () => {
      try {
        const currentTextarea = document.getElementById("exerciseText");
        if (!currentTextarea) return;

        cleanupUnusedImagesOnActivePage(currentTextarea.value, {
          restoreSelection: {
            start: currentTextarea.selectionStart ?? currentTextarea.value.length,
            end: currentTextarea.selectionEnd ?? currentTextarea.value.length
          }
        });
      } catch (err) {
        console.error("Erreur lors du nettoyage des images non utilisées :", err);
      }
    });
  }

window.GestionImages = {
  normalizeImageName,
  ensurePageImages,
  getImagesForPage,
  setImagesForPage,
  addImageToPage,
  getImageDataUrlFromPage,
  getActivePageImageDataUrl,
                              convertImageDataUrlToJpegDataUrl,
  removeImageFromPage,
  pageHasImages,
  pagesHaveImages,
  getActivePageObject,
  getActivePageData,
  readFileAsDataUrl,
  convertImageFileToJpegDataUrl,
  insertTextAtCursor,
  extractReferencedAttachmentNames,
  cleanupUnusedImagesForPage,
  cleanupUnusedImagesOnActivePage,
  pruneUnusedImages,
  handlePasteImageIntoMarkdown,
  pasteImageIntoActivePage,
  bindMarkdownImagePaste
};

  document.addEventListener("DOMContentLoaded", () => {
    if (
      window.GestionImages &&
      typeof window.GestionImages.bindMarkdownImagePaste === "function"
    ) {
      window.GestionImages.bindMarkdownImagePaste();
    }
  });
})();
