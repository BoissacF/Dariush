/* =========================================================================
   importer_pdf.js  —  Import d'un PDF vers notebook Dariush
   -------------------------------------------------------------------------
   Module autonome.
   N'expose qu'un seul global : window.ImporterPdf.open()

   Déroulé en deux temps :
     1) Extraction du texte + des images du PDF (pdf.js v3 UMD, chargé depuis
        cdnjs au premier appel).
     2) Interface plein écran de découpage :
          - tout est markdown par défaut ;
          - double-clic = insère une frontière (trait pointillé + select) ;
          - le select choisit le type de ce qui suit jusqu'à la frontière
            suivante : markdown / code / saut de page / supprimer ce pointillé.
        Puis "Créer le notebook" génère un objet notebook (cellules markdown
        + code) et le passe à window.importNotebookObject(nb), qui applique
        DÉJÀ toutes les règles Dariush (page = ≥1 markdown + 1 code, code vide
        intercalé entre deux codes, page finale à code vide, etc.).

   Règles spécifiques appliquées AVANT de déléguer à importNotebookObject :
     - un "saut de page" devient une cellule code VIDE (= rupture de page) ;
     - toute image restée dans un bloc "code" est rebasculée dans le markdown
       qui précède (une image n'a aucun sens dans CodeMirror).
   ========================================================================= */

(function () {
  "use strict";

  // ---- Configuration pdf.js (UMD, dernière version non-ESM) ----------------
  var PDFJS_VERSION = "3.11.174";
  var PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION;
  var PDFJS_LIB_URL = PDFJS_BASE + "/pdf.min.js";
  var PDFJS_WORKER_URL = PDFJS_BASE + "/pdf.worker.min.js";

  // Délimiteurs internes pour repérer une image dans le flux (jamais affichés
  // bruts : l'unité "image" est rendue comme une puce distincte).
  var IMG_OPTIONS = { maxSize: 1000, quality: 0.7 };

  // ----------------------------------------------------------------------- //
  //  1. CHARGEMENT DE pdf.js                                                 //
  // ----------------------------------------------------------------------- //

  var _pdfjsLoading = null;

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (_pdfjsLoading) return _pdfjsLoading;

    _pdfjsLoading = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = PDFJS_LIB_URL;
      script.async = true;
      script.onload = function () {
        if (!window.pdfjsLib) {
          reject(new Error("pdf.js chargé mais window.pdfjsLib absent."));
          return;
        }
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        } catch (e) {
          // non bloquant
        }
        resolve(window.pdfjsLib);
      };
      script.onerror = function () {
        reject(new Error("Impossible de charger pdf.js depuis le CDN."));
      };
      document.head.appendChild(script);
    });

    return _pdfjsLoading;
  }

  // ----------------------------------------------------------------------- //
  //  2. EXTRACTION TEXTE + IMAGES                                            //
  // ----------------------------------------------------------------------- //

  // Médiane d'un tableau de nombres.
  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Produit de deux matrices 2D affines (convention pdf.js Util.transform).
  function mulMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  // Normalise une ligne pour comparer les en-têtes/pieds entre pages :
  // minuscules, chiffres retirés (le numéro de page change d'une page à l'autre),
  // espaces compactés.
  function normHF(t) {
    return String(t || "").toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim();
  }

  // Une ligne ressemble-t-elle à un simple numéro de page ?
  function isPageNumberLike(t) {
    var s = String(t || "").trim();
    if (!s) return false;
    if (/^\d{1,4}$/.test(s)) return true;                       // "3"
    if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(s)) return true;       // "- 3 -"
    if (/^page\s+\d+/i.test(s)) return true;                    // "Page 3"
    if (/^\d+\s*\/\s*\d+$/.test(s)) return true;                // "3/11"
    return false;
  }

  // Reconstruit les LIGNES d'une page : { text, y, size }
  //   y    : position verticale (espace utilisateur, y vers le haut)
  //   size : taille de police de la ligne (max des fragments) -> titres
  //   links: rectangles de liens hypertexte -> texte couvert enveloppé [..](url)
  function buildPageLines(textContent, links) {
    var items = (textContent && textContent.items) || [];
    links = links || [];
    var lines = [];
    var current = "";
    var lastY = null;
    var lineY = null;
    var lineSize = 0;
    var lineX0 = null;
    var lineX1 = null;
    var lineFrags = [];   // fragments {text, x} pour la détection de colonnes (tableaux)
    var openUrl = null; // URL du lien en cours d'ouverture dans la ligne

    function findUrl(x, y) {
      for (var k = 0; k < links.length; k++) {
        var lk = links[k];
        if (x >= lk.x1 - 1 && x <= lk.x2 + 1 && y >= lk.y1 - 1 && y <= lk.y2 + 1) {
          return lk.url;
        }
      }
      return null;
    }

    function closeRun() {
      if (openUrl !== null) {
        current += "](" + openUrl + ")";
        openUrl = null;
      }
    }

    function appendItem(str, url) {
      if (url !== openUrl) {
        closeRun();
        if (url !== null) {
          current += "[";
          openUrl = url;
        }
      }
      current += str;
    }

    function pushLine() {
      closeRun();
      lines.push({
        text: current,
        y: (lineY !== null ? lineY : 0),
        size: lineSize,
        x0: (lineX0 !== null ? lineX0 : 0),
        x1: (lineX1 !== null ? lineX1 : 0),
        frags: lineFrags
      });
      current = "";
      lineSize = 0;
      lineY = null;
      lineX0 = null;
      lineX1 = null;
      lineFrags = [];
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var str = (it && typeof it.str === "string") ? it.str : "";
      var tr = (it && it.transform && it.transform.length >= 6) ? it.transform : null;
      var y = tr ? tr[5] : null;
      var sz = tr ? Math.hypot(tr[2], tr[3]) : 0;

      // Nouvelle ligne détectée par un saut de Y.
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        pushLine();
      }

      if (lineY === null && y !== null) lineY = y;
      if (sz > lineSize) lineSize = sz;

      // Étendue horizontale de la ligne.
      if (tr) {
        var ix0 = tr[4];
        var ix1 = tr[4] + (typeof it.width === "number" ? it.width : 0);
        if (lineX0 === null || ix0 < lineX0) lineX0 = ix0;
        if (lineX1 === null || ix1 > lineX1) lineX1 = ix1;
        // Fragment positionné (pour les tableaux). On ignore les fragments vides
        // (espaces seuls) qui n'aident pas à repérer les colonnes.
        if (str && str.trim()) lineFrags.push({ text: str, x: tr[4] });
      }

      // Lien hypertexte couvrant le centre horizontal de ce fragment ?
      var url = null;
      if (tr) {
        var cx = tr[4] + (typeof it.width === "number" ? it.width / 2 : 0);
        url = findUrl(cx, y);
      }
      appendItem(str, url);

      if (it && it.hasEOL) {
        pushLine();
      }

      if (y !== null) lastY = y;
    }

    if (current.length || openUrl !== null) pushLine();

    return reflectVerticalGaps(lines);
  }

  // Mode (valeur la plus fréquente) d'une liste, avec tolérance de regroupement.
  function modeOf(values, tol) {
    if (!values.length) return 0;
    var counts = {}, bestKey = null, bestN = 0;
    for (var i = 0; i < values.length; i++) {
      var key = Math.round(values[i] / tol);
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > bestN) { bestN = counts[key]; bestKey = key; }
    }
    return (bestKey === null) ? 0 : bestKey * tol;
  }

  // Insère des lignes vides pour refléter les écarts verticaux du PDF.
  // Méthode LOCALE, ligne par ligne : on compare l'écart à la taille de police
  // des lignes concernées et on compte combien d'interlignes de cette taille il
  // contient. Pour des lignes qui se suivent, écart ≈ 1 interligne -> 0 ligne
  // vide ; si l'écart vaut ~2, ~3 interlignes -> 1, 2 lignes vides.
  function reflectVerticalGaps(lines) {
    if (lines.length < 2) return lines;

    var sizes = [];
    for (var s = 0; s < lines.length; s++) if (lines[s].size > 0) sizes.push(lines[s].size);
    var fallback = median(sizes) || 12;

    var out = [lines[0]];
    for (var j = 1; j < lines.length; j++) {
      var gap = lines[j - 1].y - lines[j].y;
      // Taille de référence = la plus grande des deux lignes adjacentes
      // (gère le cas titre -> texte sans gonfler l'écart).
      var size = Math.max(lines[j - 1].size || 0, lines[j].size || 0) || fallback;
      var extra = 0;
      if (gap > 0 && size > 0) {
        extra = Math.round(gap / size) - 1; // -1 : la ligne elle-même n'est pas un vide
        if (extra < 0) extra = 0;
        if (extra > 3) extra = 3; // garde-fou
      }
      for (var k = 0; k < extra; k++) {
        out.push({ text: "", y: lines[j].y, size: 0, x0: 0, x1: 0, blank: true });
      }
      out.push(lines[j]);
    }
    return out;
  }

  // Convertit un objet image pdf.js en dataURL JPEG.
  // Gère bitmap OU données brutes + kind, et aplatit la transparence sur blanc
  // (les diagrammes de cours ont souvent un fond transparent qui deviendrait
  // noir en JPEG sinon).
  function imageObjToDataUrl(img, pdfjsLib) {
    if (!img) return null;

    var width = img.width || (img.bitmap && img.bitmap.width) || 0;
    var height = img.height || (img.bitmap && img.bitmap.height) || 0;
    if (!width || !height) return null;

    // 1) Canvas source (peut contenir de la transparence).
    var src = document.createElement("canvas");
    src.width = width;
    src.height = height;
    var sctx = src.getContext("2d");
    if (!sctx) return null;

    try {
      if (img.bitmap) {
        sctx.drawImage(img.bitmap, 0, 0, width, height);
      } else if (img.data) {
        var data = img.data;
        var kind = img.kind;
        var K = (pdfjsLib && pdfjsLib.ImageKind) || {
          GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3
        };
        var imageData = sctx.createImageData(width, height);
        var dst = imageData.data; // RGBA

        if (kind === K.RGBA_32BPP || (kind === undefined && data.length >= width * height * 4)) {
          dst.set(data.subarray(0, dst.length));
        } else if (kind === K.RGB_24BPP || (kind === undefined && data.length >= width * height * 3)) {
          // Gère un éventuel remplissage de ligne (stride).
          var stride = Math.floor(data.length / height);
          if (stride < width * 3) stride = width * 3;
          for (var yy = 0; yy < height; yy++) {
            var rs = yy * stride, rd = yy * width * 4;
            for (var xx = 0; xx < width; xx++) {
              var s = rs + xx * 3, d = rd + xx * 4;
              if (s + 2 >= data.length) break;
              dst[d] = data[s];
              dst[d + 1] = data[s + 1];
              dst[d + 2] = data[s + 2];
              dst[d + 3] = 255;
            }
          }
        } else if (kind === K.GRAYSCALE_1BPP) {
          var rowBytes = (width + 7) >> 3;
          for (var gy = 0; gy < height; gy++) {
            for (var gx = 0; gx < width; gx++) {
              var byte = data[gy * rowBytes + (gx >> 3)] || 0;
              var bit = (byte >> (7 - (gx & 7))) & 1;
              var v = bit ? 0 : 255; // 0 = noir dans pdf.js pour le 1bpp
              var gd = (gy * width + gx) * 4;
              dst[gd] = dst[gd + 1] = dst[gd + 2] = v;
              dst[gd + 3] = 255;
            }
          }
        } else {
          return null;
        }

        sctx.putImageData(imageData, 0, 0);
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }

    // 2) Aplatissement sur fond blanc puis export JPEG.
    try {
      var out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      var octx = out.getContext("2d");
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, width, height);
      octx.drawImage(src, 0, 0);
      return out.toDataURL("image/jpeg", IMG_OPTIONS.quality);
    } catch (e) {
      return null;
    }
  }

  // Rejette une promesse si elle dépasse 'ms' millisecondes (anti-blocage).
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error("Délai dépassé : " + label));
      }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  // Récupère un objet du store pdf.js de façon sûre, avec garde-fou de 4 s.
  // IMPORTANT : pdf.js a DEUX stockages — page.objs (local) et page.commonObjs
  // (partagé). Les images réutilisées/partagées sont souvent dans commonObjs ;
  // on consulte donc les deux.
  function getPageObj(page, name) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (done) return; done = true; resolve(v); }

      var t = setTimeout(function () { finish(null); }, 4000);

      // 1) Déjà résolu dans l'un des deux stores ?
      var stores = [page.objs, page.commonObjs];
      for (var i = 0; i < stores.length; i++) {
        var st = stores[i];
        try {
          if (st && typeof st.has === "function" && st.has(name)) {
            clearTimeout(t);
            finish(st.get(name));
            return;
          }
        } catch (e) { /* ignore */ }
      }

      // 2) Sinon, on s'abonne sur les deux ; le premier qui résout gagne.
      for (var j = 0; j < stores.length; j++) {
        (function (store) {
          if (!store || typeof store.get !== "function") return;
          try {
            store.get(name, function (obj) {
              if (obj) { clearTimeout(t); finish(obj); }
            });
          } catch (e) { /* ignore */ }
        })(stores[j]);
      }
    });
  }

  // Extrait les images peintes sur une page (XObjects + inline best-effort).
  async function extractPageImages(page, pageNumber, pdfjsLib) {
    var results = [];
    var OPS = pdfjsLib.OPS || {};
    var seen = {};
    var pageWidth = 0;

    // Étape clé : rendre la page hors-écran pour que pdf.js RÉSOLVE ses objets
    // image. Sans ce rendu, page.objs.get(...) reste en attente indéfiniment.
    // Le rendu a son propre délai : s'il échoue (page complexe, transparence
    // non gérée…), on abandonne les images de cette page SANS attendre.
    var rendered = false;
    try {
      var viewport = page.getViewport({ scale: 1.0 });
      pageWidth = viewport.width;
      var rcanvas = document.createElement("canvas");
      rcanvas.width = Math.max(1, Math.floor(viewport.width));
      rcanvas.height = Math.max(1, Math.floor(viewport.height));
      var rctx = rcanvas.getContext("2d");
      await withTimeout(
        page.render({ canvasContext: rctx, viewport: viewport }).promise,
        6000, "rendu de la page " + pageNumber
      );
      rendered = true;
    } catch (e) {
      console.warn("[ImportPDF] rendu page " + pageNumber + " KO (" + (e && e.message) + ") → images non extraites.");
    }

    if (!rendered) return results;

    var opList;
    try {
      opList = await page.getOperatorList();
    } catch (e) {
      return results;
    }

    // Compte d'images repérées (pour diagnostic).
    var imgOps = 0;
    for (var k = 0; k < opList.fnArray.length; k++) {
      var fk = opList.fnArray[k];
      if (
        fk === OPS.paintImageXObject ||
        fk === OPS.paintJpegXObject ||
        fk === OPS.paintImageXObjectRepeat ||
        fk === OPS.paintInlineImageXObject
      ) imgOps++;
    }
    console.log("[ImportPDF] page " + pageNumber + " : " + imgOps + " image(s) repérée(s).");

    var counter = 0;
    var ICON_MAX = 40;          // côté affiché (points) sous lequel = icône ignorée
    var ctm = [1, 0, 0, 1, 0, 0];
    var stack = [];
    var skippedIcons = 0;

    for (var i = 0; i < opList.fnArray.length; i++) {
      var fn = opList.fnArray[i];
      var args = opList.argsArray[i] || [];

      // Suivi de l'état graphique pour connaître la matrice courante.
      if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
      if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); continue; }
      if (fn === OPS.transform) {
        if (args.length >= 6) ctm = mulMatrix(ctm, args);
        continue;
      }

      var isXObject =
        fn === OPS.paintImageXObject ||
        fn === OPS.paintJpegXObject ||
        fn === OPS.paintImageXObjectRepeat;

      var isInline = fn === OPS.paintInlineImageXObject;

      if (!isXObject && !isInline) continue;

      // Taille AFFICHÉE et position depuis la matrice courante.
      var dispW = Math.hypot(ctm[0], ctm[1]);
      var dispH = Math.hypot(ctm[2], ctm[3]);
      var topY = ctm[5] + dispH; // haut de l'image (espace utilisateur, y-haut)

      // Petite image = icône décorative -> ignorée.
      if (Math.max(dispW, dispH) < ICON_MAX) {
        skippedIcons++;
        continue;
      }

      var dataUrl = null;
      var key = null;
      var srcObj = null;

      try {
        if (isXObject) {
          var name = args[0];
          if (typeof name !== "string") continue;
          key = name;
          if (seen[key]) continue; // déjà extraite (réutilisée)
          srcObj = await getPageObj(page, name);
        } else if (isInline) {
          // Image inline : l'objet est directement dans args[0].
          srcObj = args[0];
        }
        dataUrl = imageObjToDataUrl(srcObj, pdfjsLib);
      } catch (e) {
        dataUrl = null;
      }

      if (!dataUrl) {
        console.warn(
          "[ImportPDF] image NON convertie page " + pageNumber + " : " +
          (srcObj
            ? ("kind=" + srcObj.kind + " bitmap=" + !!srcObj.bitmap +
               " dims=" + srcObj.width + "x" + srcObj.height +
               " data=" + (srcObj.data ? srcObj.data.length : "—"))
            : "objet image absent")
        );
        continue;
      }
      if (key) seen[key] = true;

      counter++;
      var imgName = "imgP" + pageNumber + "_" + counter + ".jpg";

      // Alignement déduit des marges gauche/droite sur la page.
      var align = "left";
      var widthPct = 0;
      if (pageWidth) {
        var leftGap = ctm[4];
        var rightGap = pageWidth - (ctm[4] + dispW);
        if (Math.abs(leftGap - rightGap) < pageWidth * 0.12) align = "center";
        else if (leftGap > rightGap) align = "right";
        else align = "left";

        widthPct = Math.round((dispW / pageWidth) * 100);
        if (widthPct < 15) widthPct = 15;
        if (widthPct > 95) widthPct = 95;
      }

      // Optimisation/normalisation via le module existant si présent.
      try {
        if (
          window.GestionImages &&
          typeof window.GestionImages.convertImageDataUrlToJpegDataUrl === "function"
        ) {
          dataUrl = await window.GestionImages.convertImageDataUrlToJpegDataUrl(
            dataUrl, IMG_OPTIONS
          );
        }
      } catch (e) { /* on garde le dataUrl brut */ }

      results.push({
        name: imgName, dataUrl: dataUrl, y: topY, align: align, widthPct: widthPct,
        x0: ctm[4], x1: ctm[4] + dispW, y0: ctm[5], y1: topY
      });
    }

    if (skippedIcons) {
      console.log("[ImportPDF] page " + pageNumber + " : " + skippedIcons + " icône(s) ignorée(s).");
    }

    return results;
  }

  // Extraction complète : renvoie un tableau d'UNITÉS prêtes pour l'UI.
  //   { kind: 'pagemark', page }            -> séparateur visuel (ignoré à la génération)
  //   { kind: 'text',  text }               -> une ligne de texte (titres préfixés #/##/###)
  //   { kind: 'image', name, dataUrl }      -> une image
  async function extractPdf(arrayBuffer) {
    console.log("[ImportPDF] chargement de pdf.js…");
    var pdfjsLib = await loadPdfJs();
    console.log("[ImportPDF] pdf.js chargé, ouverture du document…");

    var loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    var pdf = await withTimeout(
      loadingTask.promise, 20000,
      "ouverture du PDF (worker pdf.js injoignable ?)"
    );
    console.log("[ImportPDF] document ouvert. Pages :", pdf.numPages);

    // 1) Collecte par page : lignes (avec y et taille) + images (avec y).
    var pagesData = [];
    var allSizes = [];

    for (var p = 1; p <= pdf.numPages; p++) {
      console.log("[ImportPDF] page " + p + "/" + pdf.numPages + "…");
      var page = await pdf.getPage(p);

      var pageHeight = 0, pageWidthPt = 0;
      try {
        var vp0 = page.getViewport({ scale: 1.0 });
        pageHeight = vp0.height; pageWidthPt = vp0.width;
      } catch (e) { pageHeight = 0; pageWidthPt = 0; }

      // Liens hypertexte = annotations de type "Link" (rectangle + URL).
      var links = [];
      try {
        var annots = await page.getAnnotations();
        for (var ai = 0; ai < annots.length; ai++) {
          var an = annots[ai];
          if (an && an.subtype === "Link") {
            var url = an.url || an.unsafeUrl || "";
            if (url && an.rect && an.rect.length >= 4) {
              links.push({
                x1: Math.min(an.rect[0], an.rect[2]),
                x2: Math.max(an.rect[0], an.rect[2]),
                y1: Math.min(an.rect[1], an.rect[3]),
                y2: Math.max(an.rect[1], an.rect[3]),
                url: url
              });
            }
          }
        }
      } catch (e) { /* pas d'annotations : tant pis */ }

      var textContent = await page.getTextContent();
      var lines = buildPageLines(textContent, links);
      for (var l = 0; l < lines.length; l++) {
        if (lines[l].text && lines[l].text.trim()) allSizes.push(lines[l].size);
      }

      var images = [];
      try {
        images = await withTimeout(
          extractPageImages(page, p, pdfjsLib), 15000,
          "extraction des images de la page " + p
        );
      } catch (e) {
        console.warn("[ImportPDF] images ignorées page " + p + " :", e && e.message);
        images = [];
      }

      pagesData.push({ page: p, lines: lines, images: images, pageHeight: pageHeight, pageWidth: pageWidthPt });
    }

    // 2) Étude des tailles de police du document.
    // Taille du "corps" = la plus fréquente (arrondie au point). Puis liste des
    // tailles SUPÉRIEURES au corps, triées : la plus petite -> ####, puis ###,
    // ##, et la plus grande -> #.
    var sizeCounts = {};
    for (var az = 0; az < allSizes.length; az++) {
      var ks = Math.round(allSizes[az]);
      if (ks > 0) sizeCounts[ks] = (sizeCounts[ks] || 0) + 1;
    }
    var bodySize = 0, bestCount = -1;
    for (var sk in sizeCounts) {
      if (sizeCounts[sk] > bestCount) { bestCount = sizeCounts[sk]; bodySize = Number(sk); }
    }
    if (!bodySize) bodySize = Math.round(median(allSizes)) || 0;

    // Tailles distinctes nettement plus grandes que le corps, par ordre croissant.
    var aboveSizes = [];
    for (var sk2 in sizeCounts) {
      var sv = Number(sk2);
      if (bodySize && sv > bodySize + 0.5) aboveSizes.push(sv);
    }
    aboveSizes.sort(function (a, b) { return a - b; });

    function headingPrefix(size) {
      if (!bodySize || !aboveSizes.length) return "";
      var rs = Math.round(size);
      if (rs <= bodySize) return "";
      // rang parmi les tailles supérieures (0 = la plus petite au-dessus du corps)
      var idx = -1;
      for (var i = 0; i < aboveSizes.length; i++) {
        if (rs >= aboveSizes[i] - 0.5) idx = i;
      }
      if (idx < 0) return "";
      // plus la taille est grande, moins il y a de # : #### (juste plus grand) -> # (le plus grand)
      var hashes = Math.max(1, 4 - idx);
      return new Array(hashes + 1).join("#") + " ";
    }

    // 2bis) Détection des EN-TÊTES / PIEDS DE PAGE.
    // Bandes haut/bas (8 % de la hauteur). Une ligne d'une bande est retirée si
    // elle ressemble à un numéro de page, OU si son texte (chiffres ôtés) se
    // répète sur assez de pages pour être un en-tête/pied courant.
    var TOP_BAND = 0.92;   // y >= hauteur * 0.92  -> en-tête
    var BOTTOM_BAND = 0.08; // y <= hauteur * 0.08  -> pied
    var bandFreq = {};

    for (var bp = 0; bp < pagesData.length; bp++) {
      var bpg = pagesData[bp];
      var h = bpg.pageHeight || 0;
      if (!h) continue;
      var seenThis = {};
      for (var bl = 0; bl < bpg.lines.length; bl++) {
        var bln = bpg.lines[bl];
        var inBand = (bln.y >= h * TOP_BAND) || (bln.y <= h * BOTTOM_BAND);
        if (!inBand) continue;
        var nn = normHF(bln.text);
        if (nn && !seenThis[nn]) {
          bandFreq[nn] = (bandFreq[nn] || 0) + 1;
          seenThis[nn] = true;
        }
      }
    }

    var hfThreshold = Math.max(2, Math.ceil(pdf.numPages * 0.4));
    var removedHF = 0;

    function isHeaderFooter(text, y, pageHeight) {
      if (!pageHeight) return false;
      var inBand = (y >= pageHeight * TOP_BAND) || (y <= pageHeight * BOTTOM_BAND);
      if (!inBand) return false;
      if (isPageNumberLike(text)) return true;
      var n = normHF(text);
      return !!(n && bandFreq[n] >= hfThreshold);
    }

    // Détecte s'il existe du texte à la MÊME hauteur que l'image, sur le côté
    // (vrai enroulement) plutôt qu'au-dessus / en dessous (image autonome).
    function imageHasSideText(img, lines) {
      var top = img.y1, bot = img.y0;
      var n = 0;
      for (var k = 0; k < lines.length; k++) {
        var ln = lines[k];
        if (!ln.text || !ln.text.trim()) continue;
        // La ligne est-elle dans la hauteur de l'image ?
        if (ln.y <= top && ln.y >= bot) {
          // … et nettement à gauche OU à droite de l'image (pas par-dessus) ?
          var beside = (ln.x0 >= img.x1 - 2) || (ln.x1 <= img.x0 + 2);
          if (beside) n++;
        }
      }
      return n >= 2; // au moins 2 lignes à côté pour conclure à un enroulement
    }

    // 3) Unités : pagemark, puis lignes + images ENTRELACÉES par position (haut->bas).
    var units = [];
    for (var pi = 0; pi < pagesData.length; pi++) {
      var pg = pagesData[pi];
      units.push({ kind: "pagemark", page: pg.page });

      var positioned = [];
      for (var li = 0; li < pg.lines.length; li++) {
        var ln = pg.lines[li];
        if (isHeaderFooter(ln.text, ln.y, pg.pageHeight)) { removedHF++; continue; }
        positioned.push({ y: ln.y, kind: "text", text: ln.text, size: ln.size, x0: ln.x0, x1: ln.x1, frags: ln.frags });
      }
      for (var ii = 0; ii < pg.images.length; ii++) {
        var img = pg.images[ii];
        var side = imageHasSideText(img, pg.lines);
        positioned.push({
          y: img.y, kind: "image", name: img.name, dataUrl: img.dataUrl,
          align: img.align, widthPct: img.widthPct, sideText: side
        });
      }

      // Ordre de lecture = du haut vers le bas = y décroissant (y vers le haut).
      positioned.sort(function (a, b) { return b.y - a.y; });

      for (var qi = 0; qi < positioned.length; qi++) {
        var u = positioned[qi];
        if (u.kind === "text") {
          var prefix = (u.text && u.text.trim()) ? headingPrefix(u.size) : "";
          units.push({ kind: "text", text: prefix + u.text, x0: u.x0, x1: u.x1, frags: u.frags });
        } else {
          units.push({
            kind: "image", name: u.name, dataUrl: u.dataUrl,
            align: u.align, widthPct: u.widthPct, sideText: u.sideText
          });
        }
      }
    }

    console.log(
      "[ImportPDF] extraction terminée. Unités : " + units.length +
      " | taille corps ≈ " + Math.round(bodySize) +
      " | en-têtes/pieds retirés : " + removedHF
    );
    return units;
  }

  // ----------------------------------------------------------------------- //
  //  3. GÉNÉRATION DU NOTEBOOK À PARTIR DU DÉCOUPAGE                         //
  // ----------------------------------------------------------------------- //

  function dataUrlToMimeBase64(dataUrl) {
    var m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!m) return null;
    return { mime: m[1], base64: m[2] };
  }

  // Markup d'une image selon son alignement et sa largeur relative.
  //  - centré              : bloc centré
  //  - droite/gauche étroite: float -> le texte voisin s'enroule à côté
  //  - droite large         : bloc aligné à droite (trop large pour enrouler)
  //  - gauche large / défaut: markdown simple ![nom](attachment:nom)
  // Le rendu autorise le HTML et résout attachment: même sur un <img> brut.
  function imageMarkup(u) {
    var ref = "attachment:" + u.name;
    var pct = (u.widthPct && u.widthPct > 0) ? u.widthPct : 45;

    // Enroulement SEULEMENT s'il y a réellement du texte à la même hauteur que
    // l'image (sideText). Sinon, l'image est seule : bloc, texte en dessous.
    if (u.sideText && u.align === "right") {
      return '\n<img src="' + ref +
        '" style="float:right;clear:right;max-width:' + pct + '%;margin:4px 0 8px 16px">\n';
    }
    if (u.sideText && u.align === "left") {
      return '\n<img src="' + ref +
        '" style="float:left;clear:left;max-width:' + pct + '%;margin:4px 16px 8px 0">\n';
    }

    // Image AUTONOME (pas de texte à côté, ou centrée) : clear:both -> elle passe
    // SOUS tout flottant précédent ; le texte qui suit se place EN DESSOUS.
    var alignCss = (u.align === "center") ? "center" : (u.align === "right" ? "right" : "left");
    return '\n<div style="clear:both;text-align:' + alignCss + '"><img src="' + ref +
      '" style="max-width:' + pct + '%"></div>\n';
  }

  // Neutralise un '>' en début de ligne : dans un PDF c'est du texte littéral
  // (invite Python >>> , flèche…), pas une citation markdown (bandes grises).
  function escapeMdLine(text) {
    return String(text == null ? "" : text).replace(/^(\s*)>/, "$1\\>");
  }

  // Construit une cellule markdown à partir d'une liste d'unités.
  // Renvoie null si le bloc est totalement vide (aucun texte, aucune image).
  // Construit un tableau markdown à partir d'une zone marquée "tableau".
  // Les COLONNES sont déduites de l'alignement horizontal des fragments :
  // on prend la rangée qui a le plus de fragments comme gabarit (ancres), puis
  // chaque fragment va dans la colonne dont l'ancre est la plus proche. Robuste
  // aux cases vides ou à un seul caractère (les colonnes viennent des positions).
  // Construit une liste markdown à partir d'une zone marquée "liste".
  // Chaque ligne non vide devient un item "- ..." : on retire l'indentation et
  // une éventuelle puce d'origine (•, -, –, *, ◦…). Les lignes vides sont
  // ignorées pour garder une liste compacte.
  function buildListMarkdown(units) {
    var out = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.kind !== "text") continue;
      var t = (u.text || "");
      if (!t.trim()) continue;
      // Retire tout ce qui précède le contenu et n'est ni lettre ni chiffre :
      // indentation ET puce d'origine, quelle qu'elle soit (•, rond, glyphe
      // inconnu rendu vide…). Le contenu d'un item commence par une lettre/chiffre.
      t = t.replace(/^[^0-9A-Za-z\u00C0-\u024F]+/, "");
      if (!t) continue;
      out.push("- " + t);
    }
    if (!out.length) return null;
    return out.join("\n");
  }

  function buildTableMarkdown(units) {
    var rows = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.kind !== "text") continue;
      if (!(u.text || "").trim()) continue;
      var frags = (u.frags && u.frags.length) ? u.frags : [{ text: u.text, x: 0 }];
      rows.push(frags);
    }
    if (rows.length < 1) return null;

    // Gabarit de colonnes = positions x de la rangée la plus fournie.
    var anchorsRow = rows[0];
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].length > anchorsRow.length) anchorsRow = rows[r];
    }
    var anchors = anchorsRow.map(function (f) { return f.x; }).sort(function (a, b) { return a - b; });
    if (anchors.length < 2) return null; // pas vraiment un tableau

    function colOf(x) {
      var best = 0, bd = Infinity;
      for (var c = 0; c < anchors.length; c++) {
        var d = Math.abs(x - anchors[c]);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }

    var out = [];
    for (var ri = 0; ri < rows.length; ri++) {
      var cells = [];
      for (var c0 = 0; c0 < anchors.length; c0++) cells.push("");
      var frs = rows[ri];
      for (var f = 0; f < frs.length; f++) {
        var ci = colOf(frs[f].x);
        var t = (frs[f].text || "").replace(/\|/g, "\\|").trim();
        cells[ci] = cells[ci] ? (cells[ci] + " " + t) : t;
      }
      out.push("| " + cells.join(" | ") + " |");
    }

    // Séparateur d'en-tête (markdown) inséré après la 1ère rangée.
    var sep = "|";
    for (var s = 0; s < anchors.length; s++) sep += " --- |";
    out.splice(1, 0, sep);

    return out.join("\n");
  }

  function buildMarkdownCell(unitList) {
    var parts = [];
    var attachments = {};
    var hasContent = false;
    var prevBlank = false;

    for (var i = 0; i < unitList.length; i++) {
      var u = unitList[i];
      if (u.kind === "text") {
        var raw = u.text || "";
        // Ligne vide insérée (écart du PDF) : la PREMIÈRE d'une série se rend
        // par une ligne vide markdown classique (saut de paragraphe) ; les
        // SUIVANTES par &nbsp; + retour forcé, car markdown fusionne les vides.
        if (!raw.trim()) {
          parts.push(prevBlank ? "&nbsp;  " : "");
          prevBlank = true;
          continue;
        }
        prevBlank = false;

        // Titre (préfixe #### …) : il doit être ISOLÉ par des lignes vides, sinon
        // markdown ne le rend pas comme titre (il serait au milieu d'un paragraphe).
        var hm = raw.match(/^(#{1,6})\s+(.*)$/);
        if (hm) {
          if (parts.length && parts[parts.length - 1] !== "") parts.push(""); // vide avant
          parts.push(hm[1] + " " + hm[2]);
          parts.push(""); // vide après ; les vides adjacents fusionnent en markdown
          prevBlank = false;
          hasContent = true;
          continue;
        }

        var line = escapeMdLine(raw);
        // "1." / "2)" ... en début de ligne : markdown en ferait une LISTE
        // numérotée. On met simplement le numéro en gras (**1.**). La ligne
        // commence alors par '*' (plus une liste), et le reste de la phrase —
        // même réparti sur plusieurs lignes — demeure du texte normal.
        line = line.replace(/^(\s*)(\d+[.)])(\s+)/, "$1**$2**$3");
        // Fidélité au PDF : chaque ligne d'origine est conservée comme une ligne
        // distincte (retour forcé via deux espaces), sinon markdown les fusionne
        // (breaks:false).
        line += "  ";
        parts.push(line);
        hasContent = true;
      } else if (u.kind === "image") {
        prevBlank = false;
        parts.push(imageMarkup(u));
        var mb = dataUrlToMimeBase64(u.dataUrl);
        if (mb) {
          attachments[u.name] = {};
          attachments[u.name][mb.mime] = [mb.base64];
        }
        hasContent = true;
      }
      // pagemark : ignoré
    }

    if (!hasContent) return null;

    var cell = {
      cell_type: "markdown",
      metadata: { dariush_cell_role: "comment" },
      source: parts.join("\n")
    };
    if (Object.keys(attachments).length) cell.attachments = attachments;
    return cell;
  }

  // Ajoute des images à une cellule markdown existante (cas image dans un code).
  function appendImagesToMarkdownCell(cell, images) {
    if (!cell || !images.length) return;
    var extra = [];
    if (!cell.attachments) cell.attachments = {};
    for (var i = 0; i < images.length; i++) {
      var u = images[i];
      extra.push(imageMarkup(u));
      var mb = dataUrlToMimeBase64(u.dataUrl);
      if (mb) {
        cell.attachments[u.name] = {};
        cell.attachments[u.name][mb.mime] = [mb.base64];
      }
    }
    cell.source = (cell.source ? cell.source + "\n" : "") + extra.join("\n");
  }

  // Parcourt le conteneur de découpage et construit la liste de cellules.
  // 'blocks' = [{type:'markdown'|'code'|'pagebreak', units:[...]}]
  // "Interligne -1" : raccourcit chaque série de lignes vides de 1 (une série
  // de N lignes vides devient N-1 : 1->0, 2->1, 3->2…). Appliqué à la création
  // du notebook, sur le markdown comme sur le code.
  function reduceBlankRuns(units) {
    var out = [];
    var inRun = false;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var isBlank = (u.kind === "text") && !((u.text || "").trim());
      if (isBlank) {
        if (!inRun) { inRun = true; continue; } // on retire la 1ère vide du run
        out.push(u);
      } else {
        inRun = false;
        out.push(u);
      }
    }
    return out;
  }

  function blocksToCells(blocks) {
    var cells = [];

    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];

      if (block.type === "pagebreak") {
        // Saut de page = cellule code vide (rupture de page côté Python).
        cells.push({
          cell_type: "code",
          metadata: { dariush_top_line: 1 },
          execution_count: null,
          outputs: [],
          source: ""
        });
        continue;
      }

      if (block.type === "cut") {
        // "Couper" : tout le contenu jusqu'à la prochaine frontière est supprimé.
        continue;
      }

      if (block.type === "list") {
        var listMd = buildListMarkdown(block.units);
        if (listMd) {
          var prevL = cells.length ? cells[cells.length - 1] : null;
          if (prevL && prevL.cell_type === "markdown") {
            // On rattache la liste au markdown précédent (ligne vide avant pour
            // que markdown la reconnaisse comme liste), pas de nouvelle cellule.
            prevL.source = (prevL.source ? prevL.source + "\n\n" : "") + listMd;
          } else {
            cells.push({
              cell_type: "markdown",
              metadata: { dariush_cell_role: "comment" },
              source: listMd
            });
          }
        } else {
          var fbl = buildMarkdownCell(reduceBlankRuns(block.units));
          if (fbl) cells.push(fbl);
        }
        continue;
      }

      if (block.type === "table") {
        var tableMd = buildTableMarkdown(block.units);
        if (tableMd) {
          cells.push({
            cell_type: "markdown",
            metadata: { dariush_cell_role: "comment" },
            source: tableMd
          });
        } else {
          // Repli : si la détection de colonnes échoue, on garde le texte normal.
          var fb = buildMarkdownCell(reduceBlankRuns(block.units));
          if (fb) cells.push(fb);
        }
        continue;
      }

      if (block.type === "markdown") {
        var mdCell = buildMarkdownCell(reduceBlankRuns(block.units));
        if (mdCell) cells.push(mdCell);
        continue;
      }

      if (block.type === "code") {
        // Sépare le texte (code) des images (à rebasculer en markdown).
        var reduced = reduceBlankRuns(block.units);
        var textUnits = [];
        var strayImages = [];
        for (var i = 0; i < reduced.length; i++) {
          var u = reduced[i];
          if (u.kind === "text") textUnits.push(u);
          else if (u.kind === "image") strayImages.push(u);
        }

        // Si le PDF avait déjà une colonne de numéros de ligne, on la retire
        // (sinon double numérotation + indentation faussée).
        textUnits = stripLineNumberGutter(textUnits);

        // Reconstruit l'indentation à partir de la position horizontale (les
        // espaces de début de ligne ne sont pas dans le texte du PDF, mais
        // encodés par la position x). Référence = ligne la moins indentée ;
        // largeur d'un caractère ≈ (x1-x0)/longueur (fiable en chasse fixe).
        var codeLines = reconstructIndentedLines(textUnits);

        // Les images d'un bloc code vont dans le markdown qui précède.
        if (strayImages.length) {
          var prev = cells.length ? cells[cells.length - 1] : null;
          if (prev && prev.cell_type === "markdown") {
            appendImagesToMarkdownCell(prev, strayImages);
          } else {
            // Aucun markdown juste avant : on en crée un dédié.
            var holder = {
              cell_type: "markdown",
              metadata: { dariush_cell_role: "comment" },
              source: ""
            };
            appendImagesToMarkdownCell(holder, strayImages);
            cells.push(holder);
          }
        }

        cells.push({
          cell_type: "code",
          metadata: { dariush_top_line: 1 },
          execution_count: null,
          outputs: [],
          source: codeLines.join("\n")
        });
        continue;
      }
    }

    return cells;
  }

  // Détecte une "gouttière" de numéros de ligne déjà présente dans le PDF
  // (la plupart des lignes commencent par un entier, le plus à gauche) et la
  // retire : le numéro disparaît du texte, et l'indentation est recalculée à
  // partir du PREMIER fragment de code (et non du numéro). Si aucune gouttière
  // n'est détectée, renvoie les unités inchangées.
  function stripLineNumberGutter(textUnits) {
    var considered = 0, numbered = 0;
    var info = [];
    for (var i = 0; i < textUnits.length; i++) {
      var u = textUnits[i];
      var blank = !((u.text || "").trim());
      var frags = (u.frags && u.frags.length)
        ? u.frags.slice().sort(function (a, b) { return a.x - b.x; })
        : null;
      // numéro = 1er fragment entier, suivi d'au moins un fragment de code
      var isNum = !blank && frags && frags.length >= 2 &&
        /^\d+$/.test((frags[0].text || "").trim());
      if (!blank) considered++;
      if (isNum) numbered++;
      info.push({ u: u, blank: blank, frags: frags, isNum: isNum });
    }
    // Pas une majorité nette de lignes numérotées -> on ne touche à rien.
    if (considered === 0 || numbered < considered * 0.6) return textUnits;

    var out = [];
    for (var j = 0; j < info.length; j++) {
      var p = info[j];
      if (p.blank) { out.push({ kind: "text", text: "", x0: 0, x1: 0 }); continue; }
      if (p.isNum) {
        var codeFrags = p.frags.slice(1); // sans le numéro
        var x0 = codeFrags.length ? codeFrags[0].x : p.u.x0;
        var num = (p.frags[0].text || "").trim();
        // retire le numéro de tête (et l'écart de gouttière) du texte
        var text = (p.u.text || "").replace(new RegExp("^\\s*" + num + "\\s*"), "");
        out.push({ kind: "text", text: text, x0: x0, x1: p.u.x1 });
      } else {
        out.push({ kind: "text", text: p.u.text, x0: p.u.x0, x1: p.u.x1 });
      }
    }
    return out;
  }

  // Reconstitue l'indentation de lignes de code à partir de leur position x0.
  function reconstructIndentedLines(textUnits) {
    var ref = Infinity;
    var widths = [];

    for (var i = 0; i < textUnits.length; i++) {
      var u = textUnits[i];
      var t = u.text || "";
      if (!t.trim()) continue;
      if (typeof u.x0 === "number" && typeof u.x1 === "number" && u.x1 > u.x0) {
        if (u.x0 < ref) ref = u.x0;
        if (t.length >= 4) widths.push((u.x1 - u.x0) / t.length);
      }
    }
    if (!isFinite(ref)) ref = 0;
    var charW = median(widths); // largeur moyenne d'un caractère

    var out = [];
    for (var j = 0; j < textUnits.length; j++) {
      var v = textUnits[j];
      var s = v.text || "";
      if (!s.trim()) { out.push(""); continue; }

      var stripped = s.replace(/^\s+/, ""); // on repart d'une ligne sans indentation
      var n = 0;
      if (charW > 0 && typeof v.x0 === "number") {
        n = Math.round((v.x0 - ref) / charW);
        if (n < 0) n = 0;
      }
      out.push(new Array(n + 1).join(" ") + stripped);
    }
    return out;
  }

  // Lit l'ordre réel du DOM (unités + frontières) et produit les blocs typés.
  function readBlocksFromDoc(docEl) {
    var blocks = [];
    var currentType = "markdown";
    var buffer = [];

    function flush() {
      if (buffer.length) {
        blocks.push({ type: currentType, units: buffer });
        buffer = [];
      }
    }

    var children = docEl.children;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];

      if (el.classList.contains("dpdf-frontier")) {
        var sel = el.querySelector("select");
        var val = sel ? sel.value : "markdown";

        if (val === "saut") {
          flush();
          blocks.push({ type: "pagebreak", units: [] });
          currentType = "markdown";
        } else if (val === "code") {
          flush();
          currentType = "code";
        } else if (val === "tableau") {
          flush();
          currentType = "table";
        } else if (val === "liste") {
          flush();
          currentType = "list";
        } else if (val === "couper") {
          flush();
          currentType = "cut";
        } else { // "markdown"
          flush();
          currentType = "markdown";
        }
        continue;
      }

      if (el.classList.contains("dpdf-unit") && el._unit) {
        buffer.push(el._unit);
      }
    }

    flush();
    return blocks;
  }

  async function generateNotebook(docEl) {
    var blocks = readBlocksFromDoc(docEl);
    var cells = blocksToCells(blocks);

    if (!cells.length) {
      // Notebook vide : on met au moins une page vide valable.
      cells.push({
        cell_type: "markdown",
        metadata: { dariush_cell_role: "comment" },
        source: ""
      });
    }

    var nb = {
      cells: cells,
      metadata: {
        language_info: { name: "python" },
        orig_nbformat: 4,
        dariush_python: { exporter: "Import PDF", export_version: 1 }
      },
      nbformat: 4,
      nbformat_minor: 5
    };

    if (typeof window.importNotebookObject !== "function") {
      throw new Error("window.importNotebookObject introuvable (importer.js non chargé ?).");
    }

    await window.importNotebookObject(nb);
  }

  // ----------------------------------------------------------------------- //
  //  4. INTERFACE PLEIN ÉCRAN DE DÉCOUPAGE                                   //
  // ----------------------------------------------------------------------- //

  var STYLE_ID = "dpdf-style";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ""
      + ".dpdf-overlay{position:fixed;inset:0;z-index:2147483600;background:#fff;"
      + "display:flex;flex-direction:column;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1b1b1b;}"
      + ".dpdf-head{flex:0 0 auto;padding:12px 16px;border-bottom:1px solid #ddd;background:#f7f7f8;}"
      + ".dpdf-title{font-size:16px;font-weight:600;margin:0 0 6px;}"
      + ".dpdf-help{font-size:13px;line-height:1.45;color:#444;margin:0 0 10px;}"
      + ".dpdf-help b{color:#1b1b1b;}"
      + ".dpdf-actions{display:flex;gap:10px;}"
      + ".dpdf-btn{cursor:pointer;border:1px solid #999;border-radius:6px;padding:7px 14px;"
      + "font-size:14px;background:#fff;color:#1b1b1b;}"
      + ".dpdf-btn:hover{background:#f0f0f0;}"
      + ".dpdf-cancel{background:#e9e9ea;border-color:#999;color:#1b1b1b;}"
      + ".dpdf-cancel:hover{background:#dedede;}"
      + ".dpdf-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff;}"
      + ".dpdf-btn-primary:hover{background:#1d4ed8;}"
      + ".dpdf-doc{flex:1 1 auto;overflow:auto;padding:14px 18px;}"
      + ".dpdf-unit{white-space:pre-wrap;font-family:ui-monospace,Consolas,Menlo,monospace;"
      + "font-size:13px;line-height:1.5;padding:1px 6px;border-radius:3px;cursor:pointer;"
      + "min-height:1.5em;}"
      + ".dpdf-unit:hover{background:#eef4ff;}"
      + ".dpdf-unit.dpdf-empty{min-height:0.9em;}"
      + ".dpdf-pagemark{font-family:system-ui,sans-serif;font-size:11px;color:#9ca3af;"
      + "text-align:center;margin:10px 0 4px;letter-spacing:.5px;text-transform:uppercase;cursor:default;}"
      + ".dpdf-pagemark:hover{background:transparent;}"
      + ".dpdf-img{display:inline-flex;align-items:center;gap:8px;background:#fff7ed;"
      + "border:1px solid #fdba74;border-radius:6px;padding:4px 10px;margin:4px 0;"
      + "font-family:system-ui,sans-serif;font-size:13px;color:#9a3412;}"
      + ".dpdf-img .dpdf-imgprev{max-width:180px;max-height:120px;display:block;margin-top:6px;"
      + "border:1px solid #fdba74;border-radius:4px;}"
      + ".dpdf-frontier{display:flex;align-items:center;gap:10px;margin:8px 0;}"
      + ".dpdf-frontier .dpdf-line{flex:1 1 auto;border-top:2px dashed #2563eb;}"
      + ".dpdf-frontier select{font-size:13px;padding:3px 6px;border:1px solid #2563eb;"
      + "border-radius:5px;background:#eff6ff;color:#1e3a8a;cursor:pointer;}"
      + ".dpdf-status{flex:0 0 auto;padding:8px 16px;font-size:13px;color:#555;"
      + "border-top:1px solid #eee;background:#fafafa;}";

    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Mode "sans code" (ex. Dariush Linux : pas de bloc de code par page).
  // La page hôte le déclenche avec  window.DARIUSH_PDF_NO_CODE = true;
  function noCodeMode() {
    return !!window.DARIUSH_PDF_NO_CODE;
  }

  function buildSelectHtml() {
    var opts = "";
    if (!noCodeMode()) {
      // En Python/SQL : tous les types.
      opts += '<option value="code">→ Code</option>';
      opts += '<option value="markdown">→ Markdown</option>';
    }
    // En mode sans code (Linux), tout est markdown : seuls "saut de page" et
    // "supprimer" ont du sens — plus "tableau" et "couper".
    opts += '<option value="tableau">→ Tableau</option>';
    opts += '<option value="liste">→ Liste</option>';
    opts += '<option value="couper">→ Couper (supprime jusqu\'à la suivante)</option>';
    opts += '<option value="saut">→ Saut de page</option>';
    opts += '<option value="supprimer">✕ Supprimer ce pointillé</option>';
    return '<select>' + opts + '</select>';
  }

  function makeFrontierEl() {
    var f = document.createElement("div");
    f.className = "dpdf-frontier";
    f.innerHTML = '<span class="dpdf-line"></span>' + buildSelectHtml() + '<span class="dpdf-line"></span>';

    var sel = f.querySelector("select");
    // Type par défaut au double-clic : "code" en Python/SQL, "saut de page" en
    // mode sans code (en Linux, on double-clique surtout pour créer une page).
    sel.value = noCodeMode() ? "saut" : "code";
    sel.addEventListener("change", function () {
      if (sel.value === "supprimer") {
        f.remove();
      }
    });
    // Empêche un double-clic SUR la frontière de créer une autre frontière.
    f.addEventListener("dblclick", function (e) { e.stopPropagation(); });

    return f;
  }

  function makeUnitEl(unit) {
    if (unit.kind === "pagemark") {
      var pm = document.createElement("div");
      pm.className = "dpdf-pagemark";
      pm.textContent = "──  page " + unit.page + "  ──";
      pm._unit = unit;
      pm.classList.add("dpdf-unit"); // pour la lecture DOM, mais ignoré à la génération
      return pm;
    }

    if (unit.kind === "image") {
      var ic = document.createElement("div");
      ic.className = "dpdf-unit dpdf-img";
      ic._unit = unit;

      var label = document.createElement("span");
      label.textContent = "🖼️ image : " + unit.name + "  (clic = aperçu)";
      ic.appendChild(label);

      var shown = false;
      var preview = null;
      label.addEventListener("click", function (e) {
        e.stopPropagation();
        if (shown) {
          if (preview) preview.style.display = "none";
          shown = false;
          return;
        }
        if (!preview) {
          preview = document.createElement("img");
          preview.className = "dpdf-imgprev";
          preview.src = unit.dataUrl;
          ic.appendChild(preview);
        }
        preview.style.display = "block";
        shown = true;
      });

      return ic;
    }

    // texte
    var d = document.createElement("div");
    d.className = "dpdf-unit";
    if (!unit.text || !unit.text.trim()) d.classList.add("dpdf-empty");
    d.textContent = unit.text || "";
    d._unit = unit;
    return d;
  }

  function buildOverlay(units) {
    injectStyle();

    var overlay = document.createElement("div");
    overlay.className = "dpdf-overlay";

    var head = document.createElement("div");
    head.className = "dpdf-head";
    head.innerHTML =
      '<p class="dpdf-title">Découpage du PDF en notebook</p>' +
      '<p class="dpdf-help">Tout est en <b>markdown</b> par défaut. ' +
      '<b>Double-cliquez</b> sur une ligne pour insérer une frontière (trait pointillé). ' +
      'Le menu de la frontière définit la nature de ce qui suit jusqu\'à la frontière suivante : ' +
      '<b>Code</b>, <b>Markdown</b>, <b>Saut de page</b>, ou <b>Supprimer ce pointillé</b>. ' +
      'Les images sont signalées par une puce 🖼️.</p>' +
      '<div class="dpdf-actions">' +
      '<button class="dpdf-btn dpdf-cancel" type="button">Annuler</button>' +
      '<button class="dpdf-btn dpdf-btn-primary dpdf-create" type="button">Créer le notebook</button>' +
      '</div>';

    var doc = document.createElement("div");
    doc.className = "dpdf-doc";

    for (var i = 0; i < units.length; i++) {
      doc.appendChild(makeUnitEl(units[i]));
    }

    // Double-clic sur une unité = insérer une frontière AVANT cette unité.
    doc.addEventListener("dblclick", function (e) {
      var unitEl = e.target;
      while (unitEl && unitEl !== doc && !unitEl.classList.contains("dpdf-unit")) {
        unitEl = unitEl.parentNode;
      }
      if (!unitEl || unitEl === doc) return;

      // Pas deux frontières au même endroit.
      var prev = unitEl.previousElementSibling;
      if (prev && prev.classList.contains("dpdf-frontier")) return;

      e.preventDefault();
      doc.insertBefore(makeFrontierEl(), unitEl);
    });

    var status = document.createElement("div");
    status.className = "dpdf-status";
    status.textContent = units.length + " éléments extraits.";

    overlay.appendChild(head);
    overlay.appendChild(doc);
    overlay.appendChild(status);

    function close() {
      overlay.remove();
      document.documentElement.style.overflow = "";
    }

    head.querySelector(".dpdf-cancel").addEventListener("click", close);

    head.querySelector(".dpdf-create").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      status.textContent = "Génération du notebook…";
      try {
        await generateNotebook(doc);
        close();
      } catch (err) {
        console.error("Import PDF :", err);
        status.textContent = "Erreur : " + (err && err.message ? err.message : err);
        btn.disabled = false;
      }
    });

    document.documentElement.style.overflow = "hidden";
    document.body.appendChild(overlay);
  }

  // ----------------------------------------------------------------------- //
  //  5. POINT D'ENTRÉE                                                       //
  // ----------------------------------------------------------------------- //

  function choosePdfFile() {
    // Case "Google Drive" cochée : le PDF vient du Drive
    if (window.DariushDrive && window.DariushDrive.isEnabled()) {
      return window.DariushDrive.pickFile(".pdf");
    }

    return new Promise(function (resolve) {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf,.pdf";
      input.style.display = "none";
      input.addEventListener("change", function () {
        var file = input.files && input.files[0] ? input.files[0] : null;
        input.remove();
        resolve(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  // Affiche un petit voile "extraction en cours" pendant le chargement.
  function showLoadingVeil(text) {
    var veil = document.createElement("div");
    veil.id = "dpdf-veil";
    veil.style.cssText =
      "position:fixed;inset:0;z-index:2147483601;background:rgba(255,255,255,.85);" +
      "display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;" +
      "font-size:15px;color:#333;";
    veil.textContent = text || "Extraction du PDF…";
    document.body.appendChild(veil);
    return veil;
  }

  async function open() {
    var file = await choosePdfFile();
    if (!file) return;

    var veil = showLoadingVeil("Chargement de pdf.js et extraction du PDF…");
    try {
      var arrayBuffer = await file.arrayBuffer();
      var units = await extractPdf(arrayBuffer);
      veil.remove();

      if (!units.length) {
        alert("Aucun contenu extrait de ce PDF.");
        return;
      }

      // PDF "scanné" : uniquement des images, aucun texte réel exploitable.
      var hasRealText = units.some(function (u) {
        return u.kind === "text" && u.text && u.text.trim();
      });
      if (!hasRealText) {
        alert("Je ne peux pas traiter ce style de PDF : il ne contient que des images (PDF scanné), sans texte exploitable.");
        return;
      }

      buildOverlay(units);
    } catch (err) {
      if (veil) veil.remove();
      console.error("Import PDF :", err);
      alert("Impossible d'importer ce PDF : " + (err && err.message ? err.message : err));
    }
  }

  window.ImporterPdf = { open: open };
})();