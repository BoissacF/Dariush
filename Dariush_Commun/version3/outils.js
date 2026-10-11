/*
un peu de tout en vrac :*
- redimensionnement de la zone de texte
- recuperer ou editer la zone de code
- codage decodage du code
-choisir l heure ou le lien sera accessible
-  mémoriser/restaurer la 1ère ligne visible CodeMirror*- memoriser ou detecter dans le lien la ligne du scroll a placer en haut de fenetre
- construire le lien
- fond d ecran clai ou sombre pour la zone de code
- ouvrir et enregistrer des fichiers
- envoi d un exercice

*/
/* =========================================================
   EXPORT PDF VIA IMPRESSION NAVIGATEUR (window.print)
   options.codeLanguage : "python" (défaut), "sql", ...
   options.includeCode  : true (défaut) ; false => markdowns seuls
   ========================================================= */
function exportNotebookToPrintPdf(options) {
  const opts = options || {};
  const codeLang = opts.codeLanguage || "python";
  const includeCode = opts.includeCode !== false; // défaut : true

  let pages = getPagesForNotebookExport();

  if (window.GestionImages && typeof window.GestionImages.pruneUnusedImages === "function") {
    pages = window.GestionImages.pruneUnusedImages(pages);
  }
  if (!Array.isArray(pages) || !pages.length) {
    alert("Rien à exporter.");
    return;
  }

  let md = null;
  if (typeof window.markdownit === "function") {
    md = window.markdownit({ html: true, linkify: true, breaks: false, typographer: false });
    if (typeof window.texmath === "function" && window.katex) {
      try {
        md.use(window.texmath, {
          engine: window.katex,
          delimiters: "dollars",
          katexOptions: { throwOnError: false }
        });
      } catch (e) {}
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdownBlock(text, images) {
    let html = md
      ? md.render(String(text ?? ""))
      : "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>";

    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll('img[src^="attachment:"]').forEach((img) => {
      const name = img.getAttribute("src").slice("attachment:".length).trim();
      const dataUrl = images && images[name];
      if (dataUrl) img.setAttribute("src", dataUrl);
    });
    return tmp.innerHTML;
  }

  const sections = [];
  pages.forEach((page) => {
    const blocks = (Array.isArray(page?.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page?.comment || "")];
    const images = (page?.images && typeof page.images === "object") ? page.images : {};

    let inner = "";
    blocks.forEach((b) => {
      const rendered = renderMarkdownBlock(b, images);
      if (rendered && rendered.trim()) {
        inner += `<div class="exercise-preview dpy-md">${rendered}</div>`;
      }
    });

    const code = String(page?.code || "");
    if (includeCode && code.trim()) {
      inner += `<pre class="dpy-code"><code class="language-${codeLang}">${escapeHtml(code)}</code></pre>`;
    }

    sections.push(`<section class="dpy-page">${inner}</section>`);
  });

  let headStyles = "";
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => {
    headStyles += el.outerHTML;
  });

  const HLJS_CSS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
  const HLJS_JS  = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
  headStyles += `<link rel="stylesheet" href="${HLJS_CSS}">`;

  // Mermaid : on résout le chemin local en URL ABSOLUE (la fenêtre d'impression
  // est un about:blank où un chemin relatif ne résoudrait pas).
  let MERMAID_JS = "";
  try {
    MERMAID_JS = new URL("../Dariush_Commun/fichiersannexes/libs/mermaid.min.js", window.location.href).href;
  } catch (e) { MERMAID_JS = ""; }

  const printCss = `
    <style>
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      @page { margin: 14mm; }
      body { font-family: system-ui, sans-serif; color:#111; background:#fff; }
      .dpy-page {
        margin: 0 0 16px; padding-bottom: 12px;
        border-bottom: 1px solid #e2e2e2;
        page-break-inside: avoid;
      }
      .dpy-page:last-child { border-bottom: none; }
      .exercise-preview {
        border: none; min-height: 0; cursor: auto;
        margin: 8px 0 12px; padding: 0;
      }
      .exercise-preview img { max-width: 100%; height: auto; }
      .dpy-code {
        background:#f6f8fa; border:1px solid #ddd; border-radius:6px;
        padding:10px 12px; font-size:13px;
        white-space:pre-wrap; word-break:break-word; page-break-inside:avoid;
      }
      .dpy-code code { font-family:Consolas,Menlo,monospace; background:none; padding:0; }
      .hljs { background:#f6f8fa; }
      .dpy-mermaid { text-align:center; margin:10px 0; page-break-inside:avoid; }
      .dpy-mermaid svg { max-width:100%; height:auto; }
    </style>`;

  const win = window.open("", "_blank");
  if (!win) {
    alert("La fenêtre d'impression a été bloquée. Autorisez les popups pour ce site.");
    return;
  }
  win.document.open();
  win.document.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>&nbsp;</title>${headStyles}${printCss}</head><body>${sections.join("")}</body></html>`
  );
  win.document.close();

  let printed = false;
  function doPrint() {
    if (printed) return;
    printed = true;
    try { win.focus(); win.print(); } catch (e) {}
  }

  // 1) Rend les blocs ```mermaid en SVG (htmlLabels:false = impression fiable),
  //    PUIS appelle next(). En cas d'absence de Mermaid, on imprime le code brut.
  function renderMermaidThen(next) {
    const codeEls = Array.prototype.slice.call(
      win.document.querySelectorAll("code.language-mermaid")
    );
    if (!codeEls.length || !MERMAID_JS) { next(); return; }

    const mscript = win.document.createElement("script");
    mscript.src = MERMAID_JS;
    mscript.onload = function () {
      let m;
      try {
        m = win.mermaid;
        m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", flowchart: { htmlLabels: false } });
      } catch (e) { next(); return; }

      const jobs = codeEls.map(function (codeEl, i) {
        const pre = codeEl.closest("pre") || codeEl;
        const code = String(codeEl.textContent || "").trim();
        const holder = win.document.createElement("div");
        holder.className = "dpy-mermaid";
        pre.replaceWith(holder);
        const id = "pmmd-" + Date.now() + "-" + i;
        return Promise.resolve()
          .then(function () { return m.render(id, code); })
          .then(function (res) { if (res && res.svg) holder.innerHTML = res.svg; })
          .catch(function () {
            // diagramme invalide : on remet le code brut, lisible
            const p = win.document.createElement("pre");
            p.className = "dpy-code";
            p.textContent = code;
            holder.replaceWith(p);
          });
      });
      Promise.all(jobs).then(next, next);
    };
    mscript.onerror = function () { next(); }; // Mermaid indisponible → code brut imprimé
    win.document.head.appendChild(mscript);
  }

  // 2) Coloration syntaxique du code (les blocs mermaid ont déjà été remplacés),
  //    PUIS impression.
  function highlightThenPrint() {
    const script = win.document.createElement("script");
    script.src = HLJS_JS;
    script.onload = function () {
      try {
        win.document.querySelectorAll('pre code[class*="language-"]').forEach((el) => {
          if (el.classList.contains("language-mermaid")) return; // sécurité
          win.hljs.highlightElement(el);
        });
      } catch (e) {}
      setTimeout(doPrint, 300);
    };
    script.onerror = function () { setTimeout(doPrint, 100); };
    win.document.head.appendChild(script);
  }

  // Enchaînement : Mermaid → highlight → impression
  renderMermaidThen(highlightThenPrint);

  // Filet de sécurité (un peu plus long pour laisser le temps au rendu Mermaid)
  setTimeout(doPrint, 4000);
}
window.exportNotebookToPrintPdf = exportNotebookToPrintPdf;







// Source de l'application courante (python, linux, sql, js, ...)
// Permet de filtrer les exercices selon l'appli depuis laquelle on les manipule

function getDariushSource() {
  if (window.location.pathname.includes("Dariush_Linux")) return "linux";
  if (window.location.pathname.includes("Dariush_SQL"))   return "sql";
  return "python";
}


const linkInput = document.getElementById("generatedLink");


//redimensionne la zone de texte qui decrit l exo
function vieuxautoResizeTextarea(el) {
  if (!el) return;

  el.style.height = "0px";
  el.style.height = (el.scrollHeight - 2) + "px";
}

function autoResizeTextarea(el) {
  if (!el) return;

  // Mémorise la position de défilement de la page et des parents scrollables,
  // car le passage à height="auto" raccourcit la page un instant et le
  // navigateur ferait remonter la vue (effet "la ligne saute en haut").
  const winX = window.scrollX;
  const winY = window.scrollY;
  const parents = [];
  let p = el.parentElement;
  while (p) {
    if (p.scrollHeight > p.clientHeight) {
      parents.push([p, p.scrollTop]);
    }
    p = p.parentElement;
  }

  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";

  // Restaure les positions : le texte ne bouge plus à l'écran.
  parents.forEach(([node, top]) => { node.scrollTop = top; });
  window.scrollTo(winX, winY);
}


/*

function autoResizeTextarea(el) {
  if (!el) return;

  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}
function autoResizeTextarea(el) {
  
  
  if (!el) return;

  el.style.height = "auto";           // reset
  el.style.height = el.scrollHeight + "px"; // ajuste à la hauteur du contenu
}
*/

function getExerciseTextValue() {
  if (window.getExerciseText) {
    return window.getExerciseText();
  }

  const el = document.getElementById("exerciseText");
  if (!el) return "";

  return String(el.value ?? "").replace(/\r\n/g, "\n").trim();
}

function setExerciseTextValue(text) {
  if (window.setExerciseText) {
    window.setExerciseText(text);
    return;
  }

  const el = document.getElementById("exerciseText");
  if (!el) return;

  el.value = String(text ?? "").replace(/\r\n/g, "\n").trim();
  autoResizeTextarea(el);
}

function isDefaultExerciseText(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim() === "";
}

function change_connexion() {
  const panel = document.getElementById("connexion");
  if (!panel) return;

  panel.classList.toggle("group-open");

  
}



/* =========================================================
   Encodage/décodage texte (même pipeline que le code)
   UTF-8 -> deflate -> base64 URL-safe
   ========================================================= */

function encode_text_deflate_b64url(text) {
  const utf8 = new TextEncoder().encode(text);
  const compressed = pako.deflate(utf8);

  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < compressed.length; i += chunkSize) {
    bin += String.fromCharCode.apply(null, compressed.subarray(i, i + chunkSize));
  }

  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode_text_deflate_b64url(b64url) {
  let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);

  const binary = atob(s);
  const compressed = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) compressed[i] = binary.charCodeAt(i);

  const utf8 = pako.inflate(compressed);
  return new TextDecoder("utf-8").decode(utf8);
}

/* =========================================================
   MARKDOWNS MULTIPLES — séparateur interne
   Un champ "comment" peut contenir PLUSIEURS markdowns,
   joints par un séparateur improbable.
   - joinMarkdowns([...])  -> une seule chaîne
   - splitMarkdowns("...") -> tableau (toujours au moins 1 élément)
   Compat : une ancienne chaîne sans séparateur = 1 seul markdown.
   ========================================================= */

const MD_SEP = "\n\u0000===DARIUSH-MD-SEP===\u0000\n";

function joinMarkdowns(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr.map(s => String(s ?? "")).join(MD_SEP);
}

function splitMarkdowns(text) {
  const str = String(text ?? "");
  if (str === "") return [""];
  const parts = str.split(MD_SEP);
  return parts.length ? parts : [""];
}

window.MD_SEP = MD_SEP;
window.joinMarkdowns = joinMarkdowns;
window.splitMarkdowns = splitMarkdowns;

function choisirDateHeureUTC_select() {
  return new Promise((resolve) => {
    // Overlay
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.35)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "9999";

    // Panel
    const panel = document.createElement("div");
    panel.style.background = "white";
    panel.style.padding = "16px";
    panel.style.borderRadius = "10px";
    panel.style.minWidth = "320px";
    panel.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";
    overlay.appendChild(panel);

    const title = document.createElement("div");
    title.textContent = "Choisir une date/heure d’ouverture (UTC)";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "10px";
    panel.appendChild(title);

    const row1 = document.createElement("div");
    row1.style.display = "flex";
    row1.style.gap = "8px";
    row1.style.alignItems = "center";
    row1.style.marginBottom = "10px";
    panel.appendChild(row1);

    const labDate = document.createElement("span");
    labDate.textContent = "Date (UTC) :";
    row1.appendChild(labDate);

    const selDay = document.createElement("select");
    const selMonth = document.createElement("select");
    const selYear = document.createElement("select");
    [selDay, selMonth, selYear].forEach(s => {
      s.style.padding = "4px";
    });

    row1.appendChild(selDay);
    row1.appendChild(selMonth);
    row1.appendChild(selYear);

    const row2 = document.createElement("div");
    row2.style.display = "flex";
    row2.style.gap = "8px";
    row2.style.alignItems = "center";
    row2.style.marginBottom = "12px";
    panel.appendChild(row2);

    const labTime = document.createElement("span");
    labTime.textContent = "Heure (UTC) :";
    row2.appendChild(labTime);

    const selHour = document.createElement("select");
    const selMin = document.createElement("select");
    [selHour, selMin].forEach(s => {
      s.style.padding = "4px";
    });
    row2.appendChild(selHour);
    row2.appendChild(selMin);

    // Options
    for (let d = 1; d <= 31; d++) {
      const o = document.createElement("option");
      o.value = String(d);
      o.textContent = String(d).padStart(2, "0");
      selDay.appendChild(o);
    }
    for (let m = 1; m <= 12; m++) {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = String(m).padStart(2, "0");
      selMonth.appendChild(o);
    }
    const now = new Date();
    const y0 = now.getUTCFullYear();
    for (let y = y0; y <= y0 + 5; y++) {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = String(y);
      selYear.appendChild(o);
    }

    for (let h = 0; h <= 23; h++) {
      const o = document.createElement("option");
      o.value = String(h);
      o.textContent = String(h).padStart(2, "0");
      selHour.appendChild(o);
    }
    for (let mi = 0; mi <= 59; mi++) {
      const o = document.createElement("option");
      o.value = String(mi);
      o.textContent = String(mi).padStart(2, "0");
      selMin.appendChild(o);
    }

    // Valeurs par défaut = maintenant UTC (arrondi minute)
    selDay.value = String(now.getUTCDate());
    selMonth.value = String(now.getUTCMonth() + 1);
    selYear.value = String(now.getUTCFullYear());
    selHour.value = String(now.getUTCHours());
    selMin.value = String(now.getUTCMinutes());

    // Boutons
    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.justifyContent = "flex-end";
    btnRow.style.gap = "10px";
    panel.appendChild(btnRow);

    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.textContent = "Annuler";
    btnCancel.style.padding = "6px 10px";

    const btnOk = document.createElement("button");
    btnOk.type = "button";
    btnOk.textContent = "Valider";
    btnOk.style.padding = "6px 10px";

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnOk);

    function close(val) {
      overlay.remove();
      resolve(val);
    }

    btnCancel.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });

    btnOk.addEventListener("click", () => {
      const d = parseInt(selDay.value, 10);
      const m = parseInt(selMonth.value, 10);
      const y = parseInt(selYear.value, 10);
      const h = parseInt(selHour.value, 10);
      const mi = parseInt(selMin.value, 10);

      const dt = new Date(Date.UTC(y, m - 1, d, h, mi, 0));

      // ISO sans millisecondes: YYYY-MM-DDTHH:MM:SSZ
      const iso = dt.toISOString().replace(/\.\d{3}Z$/, "Z");
      close(iso);
    });

    document.body.appendChild(overlay);
  });
}

/* =========================================================
   mémoriser/restaurer la 1ère ligne visible CodeMirror
   ========================================================= */

/** Renvoie le numéro (1-based) de la première ligne visible dans CodeMirror */
function getFirstVisibleLine1Based() {
  if (!editor) return 1;
  const info = editor.getScrollInfo();
  const firstLine0 = editor.lineAtHeight(info.top, "local"); // 0-based
  return firstLine0 + 1;
}

/**
 * Place la ligne `line1` (1-based) en haut de la fenêtre CodeMirror.
 * Si line1 absent/invalide -> ligne 1 (compat anciens liens).
 */
function scrollEditorLineToTop(line1) {
  if (!editor) return;

  let line0 = (parseInt(line1, 10) || 1) - 1;
  if (line0 < 0) line0 = 0;

  const last = editor.lastLine();
  if (line0 > last) line0 = last;

  // Calculer la position Y de la ligne et scroller exactement dessus
  const y = editor.heightAtLine(line0, "local");

  // Après setValue(), laisse CodeMirror recalculer, puis scroll
  requestAnimationFrame(() => {
  editor.refresh();
});
}

function testdecode() {
  let url = "https://www.monsite.fr/?code=eJxlUMtOwzAQvPsrhvRAC0FqgF4q5cLr1AMSggvikKZr1SixIz-qhKof1O_oj2EnMSCxB6_lmZ2Z9QSPLdVNRdgQSuWP585ulWSNFtJOkzslP5XTHm2cMCN4lswYm-BNOYNGuR19wVlRCUOBaLArtCjWFRnWIkc2Z51v1_NRkyerAkbVde-5bw8gi33nm_G9xSW6w2Bwr09HL-kkwYtbCsTqvOBclFvSTKp6rb1djvcsxXWKmxS3KRYfMfwqDC2TFCNzFoGX6F4Vg3IgGVdPI7G3fzgduZBiCMCVLK3wH7MhDl6UVmlB1VTOlgy-BIdEnmMOpYdbNgChNFmnJbL-gSpD_yCJi7-iV1kf4DV-qo_54z-u8BTZYY1FyP87v_D5o8E3yHqVVw";
  url = "https://www.monsite.fr/?code=eJxVjc8KgzAMh-8-RehFC8LuQtlLjB2FtEZWVlqpRmFPv_4Z4nJKvvzy5XhZR_CITEMDqSItwa-krF9469pnYEcf2AOvMKONBOzBB94JGQw6ww5w1HCHLty8bGWR2Pn0KOHFADoSvpuyw6TeuqoXqISsJ_qK9YmNyvrSTqDAwAhYJvpNdbfEfC1qWoneyCueUnRMr_rpD1PGOU3yC2YFSWs";

  decode_url(url);
}
async function generateLink() {
  const pages = getAllPagesForShareChecks();

  if (
    window.GestionImages &&
    typeof window.GestionImages.pagesHaveImages === "function" &&
    window.GestionImages.pagesHaveImages(pages)
  ) {
    alertImagesNotAllowedForShare();
    return;
  }

  const url = await buildLink({ askDate: true });
  if (!url) return;

  let finalUrl = url;

  if (url.length > 1800) {
    const ok = confirm(
      "Votre lien dépasse 1800 caractères.\n\n" +
      "Cela peut poser des problèmes si vous voulez l’échanger par mail ou l’exporter dans un PDF.\n\n" +
      "Voulez-vous raccourcir ce lien (1700 caractères) ?"
    );

    if (ok) {
      finalUrl = await demanderEtCreerLienCourt(url);
      if (!finalUrl) {
        return;
      }
    }
  }

  linkInput.style.display = "inline";
  linkInput.value = finalUrl;

  linkInput.focus();
  linkInput.select();

  try {
    await navigator.clipboard.writeText(finalUrl);
  } catch (err) {
    console.warn("Copie automatique échouée :", err);
  }
}


function getAllPagesForShareChecks() {
  if (window.PagesMultiples && typeof window.PagesMultiples.getAllPages === "function") {
    return window.PagesMultiples.getAllPages();
  }

  const firstLine =
    (typeof getFirstVisibleLine1Based === "function")
      ? getFirstVisibleLine1Based()
      : 1;

  return [{
    code: editor ? editor.getValue() : "",
    topLine: firstLine,
    comment: getExerciseTextValue ? getExerciseTextValue() : "",
    images: {}
  }];
}

const MAX_EXERCICE_LINK_BYTES = 300 * 1024; // 300 ko

function getUtf8ByteLength(text) {
  return new TextEncoder().encode(String(text || "")).length;
}

function isExerciseLinkTooLarge(link) {
  return getUtf8ByteLength(link) > MAX_EXERCICE_LINK_BYTES;
}

function getExerciseLinkTooLargeMessage() {
  return (
    "Cet exercice est trop volumineux pour être enregistré.\n\n" +
    "La limite actuelle est de 300 ko.\n\n" +
    "Réduisez la taille ou le nombre d'images, puis réessayez."
  );
}


function alertImagesNotAllowedForShare() {
  alert(
    "Ce document contient une ou plusieurs images intégrées.\n\n" +
    "Les images ne peuvent pas être incluses dans un lien classique.\n\n" +
    "Vous pouvez en revanche :\n" +
    "- enregistrer l'exercice dans la base de données si sa taille reste inférieure à 300 ko\n" +
    "- l’enregistrer en fichier .dpy\n" +
    "- ou l’exporter en notebook Jupyter (.ipynb)."
  );
}

async function demanderEtCreerLienCourt(urlComplete) {
  const choix = await choisirModeLienCourt();
  if (!choix) return null;

  let payload = {
    url_complete: urlComplete,
    code_utilisateur: "",
    duree_mode: "1mois"
  };

  if (choix.type === "temporaire") {
    payload.duree_mode = "1mois";
  } else if (choix.type === "permanent") {
    payload.duree_mode = "permanent";
    payload.code_utilisateur = choix.code_utilisateur || "";
  } else if (choix.type === "inscription") {
  const shortUrl = await creerLienCourtTemporaire(urlComplete);
  if (!shortUrl) return null;

  preparerFormulaireInscriptionPourLienCourt();

  return shortUrl;
}

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/creer_lien_court.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      alert(data.error || "Erreur lors de la création du lien court.");
      return null;
    }

    return data.short_url;
  } catch (err) {
    console.error(err);
    alert("Erreur réseau lors de la création du lien court.");
    return null;
  }
}


async function creerLienCourtTemporaire(urlComplete) {
  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/creer_lien_court.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url_complete: urlComplete,
        code_utilisateur: "",
        duree_mode: "1mois"
      })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      alert(data.error || "Erreur lors de la création du lien court.");
      return null;
    }

    return data.short_url;
  } catch (err) {
    console.error(err);
    alert("Erreur réseau lors de la création du lien court.");
    return null;
  }
}



function choisirModeLienCourt() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.35)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "99999";

    const panel = document.createElement("div");
    panel.style.background = "white";
    panel.style.padding = "16px";
    panel.style.borderRadius = "10px";
    panel.style.minWidth = "360px";
    panel.style.maxWidth = "90vw";
    panel.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";
    overlay.appendChild(panel);

    const title = document.createElement("div");
    title.textContent =
      "Si vous avez un compte utilisateur, votre lien court (1700 caractères) est sans limite de durée. Sinon il aura une durée de 1 mois.";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "12px";
    panel.appendChild(title);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Entrez votre code utilisateur";
    input.style.width = "100%";
    input.style.boxSizing = "border-box";
    input.style.marginBottom = "12px";
    input.style.padding = "8px";
    panel.appendChild(input);

    const btnPermanent = document.createElement("button");
    btnPermanent.type = "button";
    btnPermanent.textContent = "1 : Utiliser mon code utilisateur";
    btnPermanent.className = "nav-item";
    btnPermanent.style.width = "100%";
    btnPermanent.style.marginBottom = "8px";

    const btnInscription = document.createElement("button");
    btnInscription.type = "button";
    btnInscription.textContent = "2 : Obtenir un code utilisateur";
    btnInscription.className = "nav-item";
    btnInscription.style.width = "100%";
    btnInscription.style.marginBottom = "8px";

    const btnTemp = document.createElement("button");
    btnTemp.type = "button";
    btnTemp.textContent = "3 : Obtenir un lien court d’une durée de 1 mois";
    btnTemp.className = "nav-item";
    btnTemp.style.width = "100%";
    btnTemp.style.marginBottom = "8px";

    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.textContent = "Annuler";
    btnCancel.className = "nav-item";
    btnCancel.style.width = "100%";

    panel.appendChild(btnPermanent);
    panel.appendChild(btnInscription);
    panel.appendChild(btnTemp);
    panel.appendChild(btnCancel);

    function close(value) {
      overlay.remove();
      resolve(value);
    }

    btnPermanent.addEventListener("click", () => {
      close({
        type: "permanent",
        code_utilisateur: (input.value || "").trim()
      });
    });

    btnInscription.addEventListener("click", () => {
      close({ type: "inscription" });
    });

    btnTemp.addEventListener("click", () => {
      close({ type: "temporaire" });
    });

    btnCancel.addEventListener("click", () => {
      close(null);
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });

    document.body.appendChild(overlay);
    input.focus();
  });
}
/*
function buildLink() {
  const payload = code();
  const urlObj = new URL("https://physalgo.fr/Dariush_Python/index.html");
  urlObj.searchParams.set("code", payload);

  const exerciseText = getExerciseTextValue();
  
  if (!isDefaultExerciseText(exerciseText)) {
  urlObj.searchParams.set("c", encode_text_deflate_b64url(exerciseText));
}

  return urlObj.toString();
}*/


async function buildExerciseLinkForDatabase() {
  const url = await buildLink({ askDate: false });
  if (!url) return null;

  if (isExerciseLinkTooLarge(url)) {
    alert(getExerciseLinkTooLargeMessage());
    return null;
  }

  return url;
}

window.buildLink   = buildLink;
window.decode_url  = decode_url;
window.buildExerciseLinkForDatabase = buildExerciseLinkForDatabase;


async function buildLink(options = {}) {
  const askDate = options.askDate === true;

let pages = null;
  if (window.PagesMultiples && typeof window.PagesMultiples.getAllPages === "function") {
    pages = window.PagesMultiples.getAllPages();
  }

  if (!pages || !pages.length) {
    const firstLine =
      (typeof getFirstVisibleLine1Based === "function")
        ? getFirstVisibleLine1Based()
        : 1;

    pages = [{
      code: editor ? editor.getValue() : "",
      topLine: firstLine,
      comment: getExerciseTextValue ? getExerciseTextValue() : "",
      images: {}
    }];
  }

  // Nettoyage À L'EXPORT (sur copie) : on retire des coffres les images
  // qu'aucun bloc ne cite. La mémoire n'est pas touchée. Couvre aussi les
  // snapshots groupe/aide qui passent par buildLink.
  if (
    window.GestionImages &&
    typeof window.GestionImages.pruneUnusedImages === "function"
  ) {
    pages = window.GestionImages.pruneUnusedImages(pages);
  }
 

  //const urlObj = new URL("https://physalgo.fr/Dariush_Python/index.html");
  const isLinux = window.location.pathname.includes("Dariush_Linux");
  const isSql   = window.location.pathname.includes("Dariush_SQL");
  const urlObj = isLinux
    ? new URL("https://physalgo.fr/Dariush_Linux/index.html")
    : isSql
    ? new URL("https://physalgo.fr/Dariush_SQL/index.html")
    : new URL("https://physalgo.fr/Dariush_Python/index.html");



  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] || {};
    const codeValue = String(page.code || "");
    const encodedCode = encode_text_deflate_b64url(codeValue);
    const lineValue = parseInt(page.topLine, 10) || 1;
const markdownsArray = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page.comment || "")];
    let commentValue = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(markdownsArray)
      : String(page.comment || "");

    // Transformation optionnelle du markdown à l'export (ex. [AIDE:->[REP: pour
    // un corrigé). Appliquée sur la copie locale : le notebook affiché n'est pas touché.
    if (typeof options.transformMarkdown === "function") {
      commentValue = options.transformMarkdown(commentValue);
    }

    const imagesValue =
      (page.images && typeof page.images === "object")
        ? page.images
        : {};

    const codeKey = i === 0 ? "code" : `code${i + 1}`;
    const lineKey = i === 0 ? "l" : `l${i + 1}`;
    const commentKey = i === 0 ? "c" : `c${i + 1}`;
    const imagesKey = i === 0 ? "img" : `img${i + 1}`;

    urlObj.searchParams.set(codeKey, encodedCode);
    urlObj.searchParams.set(lineKey, lineValue);

    if (commentValue && !isDefaultExerciseText(commentValue)) {
      urlObj.searchParams.set(commentKey, encode_text_deflate_b64url(commentValue));
    }
    

    if (Object.keys(imagesValue).length > 0) {
      urlObj.searchParams.set(
        imagesKey,
        encode_text_deflate_b64url(JSON.stringify(imagesValue))
      );
    }
  }

  if (askDate) {
    const ok = confirm("Veux tu que ton lien ne soit accessible qu'a partir d une certaine date ?");
    if (ok) {
      const iso = await choisirDateHeureUTC_select();
      if (iso) {
        urlObj.searchParams.set("open", encode_text_deflate_b64url(iso));
      }
    }
  }

  return urlObj.toString();
}
// Encode le code Python de l'éditeur : UTF-8 -> compression (deflate) -> Base64 URL-safe
function code() {
  if (!editor) return "";

  const text = editor.getValue();                   // texte exact (espaces, \n, accents)
  const utf8 = new TextEncoder().encode(text);      // UTF-8 (octets)

  // Compression SANS PERTE (DEFLATE)
  const compressed = pako.deflate(utf8);

  // Uint8Array -> string binaire pour btoa()
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < compressed.length; i += chunkSize) {
    bin += String.fromCharCode.apply(
      null,
      compressed.subarray(i, i + chunkSize)
    );
  }

  // Base64
  const b64 = btoa(bin);

  // Base64 URL-safe
  return b64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Formate un ISO UTC "2026-02-28T08:00:00Z" -> "28-02-2026 08:00:00 UTC"
function formatDateFrUTC_full(isoUtc) {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return isoUtc;

  const jj = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();

  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");

  return `${jj}-${mm}-${yyyy} ${hh}:${mi}:${ss} UTC`;
}

// Renvoie "dans exactement X jours Y heures Z minutes" (diff en UTC)
function diffFrJoursHeuresMinutes(nowIsoUtc, openIsoUtc) {
  const nowMs = Date.parse(nowIsoUtc);
  const openMs = Date.parse(openIsoUtc);
  if (Number.isNaN(nowMs) || Number.isNaN(openMs)) return "";

  const diffMs0 = openMs - nowMs;
  if (diffMs0 <= 0) return "dans exactement 0 jour 0 heure et 0 minute";

  const totalMinutes = Math.floor(diffMs0 / 60000); // on ignore les secondes
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;

  const j = `${days} jour${days !== 1 ? "s" : ""}`;
  const h = `${hours} heure${hours !== 1 ? "s" : ""}`;
  const m = `${mins} minute${mins !== 1 ? "s" : ""}`;

  return `dans exactement ${j} ${h} et ${m}`;
}
async function resoudreLienCourtExercice(codeCourt) {
  try {
    const response = await fetch(
      "https://physalgo.fr/Dariush_Commun/LienCourtExercice.php?code=" + encodeURIComponent(codeCourt),
      { cache: "no-store" }
    );

    let data;
    try {
      data = await response.json();
    } catch (err) {
      alert("Réponse invalide du serveur pour le lien court d’exercice.");
      return null;
    }

    if (!response.ok || !data.ok || typeof data.lien !== "string" || !data.lien) {
      alert(data?.error || "Lien court d’exercice invalide.");
      return null;
    }

    return data.lien;
  } catch (err) {
    alert("Impossible de récupérer l’exercice associé au lien court.");
    return null;
  }
}
async function decode_url(code_url) {
  if (!editor) {
    console.error("Éditeur non initialisé");
    return false;
  }

  try {
    const url = new URL(code_url, window.location.href);

    // -----------------------------
    // Gestion nouveau lien court exercice ?exo=ABC123
    // -----------------------------
   const exo = (url.searchParams.get("exo") || "").trim();
    if (exo) {
      // Capture universelle de l'identité de l'exo (menu, URL directe, rechargement).
      // Le serveur retrouve descriptif + corrigé à partir du seul lien_court.
      try {
        window.__exerciceCourant = {
          lien_court: exo,
          source: (typeof getDariushSource === "function") ? getDariushSource() : "python"
        };
      } catch (e) { /* non bloquant */ }

      const lienComplet = await resoudreLienCourtExercice(exo);
      if (!lienComplet) {
        return false;
      }
      return await decode_url(lienComplet);
    }

    // -----------------------------
    // Gestion ancien lien court générique ?sid=...
    // -----------------------------
    const sid = url.searchParams.get("sid");
    if (sid) {
      url.searchParams.delete("sid");

      const prefixe = url.toString();

      let response;
      try {
        response = await fetch(
          "https://physalgo.fr/Dariush_Commun/recupere_partie_tronquee_url.php?sid=" + encodeURIComponent(sid),
          { cache: "no-store" }
        );
      } catch (err) {
        alert("Impossible de récupérer la partie manquante du lien.");
        return false;
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        alert("Réponse invalide du serveur pour le lien court.");
        return false;
      }

      if (!response.ok || !data.ok || typeof data.suffixe !== "string") {
        alert(data?.error || "Lien court invalide ou expiré.");
        return false;
      }

      return await decode_url(prefixe + data.suffixe);
    }

    // -----------------------------
    // Gestion date d'ouverture
    // -----------------------------
    let openIso = null;

    const openParam = url.searchParams.get("open");
    if (openParam) {
      try {
        openIso = decode_text_deflate_b64url(openParam);
      } catch {
        alert("Lien invalide (date illisible).");
        return false;
      }
    }

    let firstCodeParamRaw = url.searchParams.get("code");
    if (!firstCodeParamRaw) {
      console.warn("Aucun paramètre 'code' dans l'URL");
      return false;
    }

    if (!openIso) {
      const idx = firstCodeParamRaw.indexOf("~");
      if (idx !== -1) {
        const datePart = firstCodeParamRaw.slice(idx + 1) || null;
        firstCodeParamRaw = firstCodeParamRaw.slice(0, idx);

        if (datePart) {
          try {
            openIso = decode_text_deflate_b64url(datePart);
          } catch {
            alert("Lien invalide (date illisible).");
            return false;
          }
        }
      }
    }

    if (openIso) {
      const openMs = Date.parse(openIso);
      if (Number.isNaN(openMs)) {
        alert("Lien invalide (date incorrecte).");
        return false;
      }

      let nowIso;
      try {
        const now = await date_du_jour();
        nowIso = now.utc_iso;
      } catch {
        alert("Impossible de vérifier la date UTC (serveur).");
        return false;
      }

      const nowMs = Date.parse(nowIso);
      if (Number.isNaN(nowMs)) {
        alert("Impossible de lire la date UTC du serveur.");
        return false;
      }

      if (nowMs < openMs) {
        const frDate = formatDateFrUTC_full(openIso);
        const countdown = diffFrJoursHeuresMinutes(nowIso, openIso);

        alert(
          "Ce lien sera accessible à partir du " +
          frDate +
          " " +
          countdown
        );
        return false;
      }
    }

    // -----------------------------
    // Lecture des pages
    // -----------------------------
    const pages = [];

    let index = 1;
    while (true) {
      const codeKey = index === 1 ? "code" : `code${index}`;
      const lineKey = index === 1 ? "l" : `l${index}`;
      const commentKey = index === 1 ? "c" : `c${index}`;
      const imagesKey = index === 1 ? "img" : `img${index}`;

      let codeParam = null;

      if (index === 1) {
        codeParam = firstCodeParamRaw;
      } else {
        codeParam = url.searchParams.get(codeKey);
      }

      if (!codeParam) break;

      let codePart = codeParam;

      if (index === 1) {
        const idx = codePart.indexOf("~");
        if (idx !== -1) {
          codePart = codePart.slice(0, idx);
        }
      }

      let text;
      try {
        text = decode_text_deflate_b64url(codePart);
      } catch (err) {
        console.error("Erreur décodage page", index, err);
        return false;
      }

      const lineParam = url.searchParams.get(lineKey) || "1";
      const commentParamForPage = url.searchParams.get(commentKey);
      const imagesParamForPage = url.searchParams.get(imagesKey);

      let commentText = window.DEFAULT_EXERCISE_TEXT || "";

      if (commentParamForPage) {
        try {
          commentText = decode_text_deflate_b64url(commentParamForPage);
        } catch (err) {
          console.warn("Impossible de décoder le commentaire de la page", index, err);
        }
      }

      let imagesValue = {};

      if (imagesParamForPage) {
        try {
          const decodedImagesJson = decode_text_deflate_b64url(imagesParamForPage);
          const parsedImages = JSON.parse(decodedImagesJson);

          if (parsedImages && typeof parsedImages === "object") {
            imagesValue = parsedImages;
          }
        } catch (err) {
          console.warn("Impossible de décoder les images de la page", index, err);
        }
      }

      const markdownsForPage = (typeof splitMarkdowns === "function")
        ? splitMarkdowns(commentText)
        : [commentText];

      pages.push({
        code: text,
        topLine: parseInt(lineParam, 10) || 1,
        comment: commentText,
        markdowns: markdownsForPage,
        images: imagesValue
      });

      index++;
    }

    if (!pages.length) {
      console.warn("Aucune page décodable trouvée.");
      return false;
    }

    if (window.PagesMultiples && typeof window.PagesMultiples.setAllPages === "function") {
      window.PagesMultiples.setAllPages(pages, 0);
    } else {
      editor.setValue(pages[0].code || "");
      setExerciseTextValue(
        pages[0].comment || (window.DEFAULT_EXERCISE_TEXT || "")
      );

      if (typeof scrollEditorLineToTop === "function") {
        scrollEditorLineToTop(pages[0].topLine || 1);
      }
    }

    return true;

  } catch (err) {
    console.error("Erreur lors du décodage :", err);
    return false;
  }
}

//donne la date du jour
//async = “je promets une valeur plus tard”
//await = “j’attends que mon fichier php me la donne”
async function date_du_jour() {
  const r = await fetch(
    "https://physalgo.fr/Dariush_Commun/date_utc.php",
    { cache: "no-store" }
  );
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}




/* =========================================================
  OUVRIR ENREGISTRER fichiers Python / Dariush Python
   ========================================================= */
/* =========================================================
   OUVRIR un fichier Python simple dans CodeMirror
   ========================================================= */




async function openPythonFileFromDisk(file) {
  if (!editor) return;
  if (!file) return;

  const text = await file.text();
  editor.setValue(text);
  
  requestAnimationFrame(() => {
  editor.refresh();
});

  // Remet le texte d'exercice par défaut
  setExerciseTextValue(window.DEFAULT_EXERCISE_TEXT || "");

  if (typeof window.resetLoadedPageUi === "function") {
  window.resetLoadedPageUi();
}
  
    if (
    window.PythonAutosave &&
    typeof window.PythonAutosave.restorePersistentGlobalCss === "function"
  ) {
    window.PythonAutosave.restorePersistentGlobalCss();
  }
  
  
  // Revenir en haut de l'éditeur
  if (typeof scrollEditorLineToTop === "function") {
    scrollEditorLineToTop(1);
  }
  
  

  // Effacer le lien généré affiché, s'il existe
  const generatedLinkEl = document.getElementById("generatedLink");
  if (generatedLinkEl) {
    generatedLinkEl.value = "";
    generatedLinkEl.style.display = "none";
  }
}
const DARIUSH_FILE_EXTENSION = ".dpy";
const DARIUSH_FILE_MIME = "text/plain;charset=utf-8";

/**
 * Petite fenêtre modale de choix : renvoie la valeur choisie ou null.
 */
function chooseActionDialog(title, choices) {
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

    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.style.fontWeight = "bold";
    titleEl.style.marginBottom = "12px";
    panel.appendChild(titleEl);
    if (window.DariushDrive) window.DariushDrive.attachCheckbox(titleEl);

    const list = document.createElement("div");
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "8px";
    panel.appendChild(list);

    function close(value) {
      overlay.remove();
      resolve(value);
    }

  for (const choice of choices) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = choice.label;
  btn.className = "nav-item";
  btn.style.width = "100%";
  btn.style.justifyContent = "flex-start";
  btn.style.textAlign = "left";

  btn.addEventListener("click", () => close(choice.value));
  list.appendChild(btn);
}

const cancelRow = document.createElement("div");
cancelRow.style.display = "flex";
cancelRow.style.justifyContent = "flex-end";
cancelRow.style.marginTop = "12px";
panel.appendChild(cancelRow);

const cancelBtn = document.createElement("button");
cancelBtn.type = "button";
cancelBtn.textContent = "Annuler";
cancelBtn.className = "nav-item";
cancelBtn.addEventListener("click", () => close(null));
cancelRow.appendChild(cancelBtn);

overlay.addEventListener("click", (e) => {
  if (e.target === overlay) close(null);
});

document.body.appendChild(overlay);
  });
}

/**
 * Construit le contenu texte du fichier Dariush Python :
 * code=...&l=...&c=...
 * sans le début de l'URL.
 */
function buildDariushRawPayload() {
  let pages = null;
  if (window.PagesMultiples && typeof window.PagesMultiples.getAllPages === "function") {
    pages = window.PagesMultiples.getAllPages();
  }

  if (!pages || !pages.length) {
    const firstLine =
      (typeof getFirstVisibleLine1Based === "function")
        ? getFirstVisibleLine1Based()
        : 1;

    pages = [{
      code: editor ? editor.getValue() : "",
      topLine: firstLine,
      comment: "",
      images: {}
    }];
  }

  // Nettoyage À L'EXPORT (sur copie) : on retire les images non citées.
  if (
    window.GestionImages &&
    typeof window.GestionImages.pruneUnusedImages === "function"
  ) {
    pages = window.GestionImages.pruneUnusedImages(pages);
  }

  const params = new URLSearchParams();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] || {};
    const codeValue = String(page.code || "");
    const encodedCode = encode_text_deflate_b64url(codeValue);
    const lineValue = parseInt(page.topLine, 10) || 1;

    const markdownsArray = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page.comment || "")];
    const commentValue = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(markdownsArray)
      : String(page.comment || "");
    const imagesValue = (page.images && typeof page.images === "object") ? page.images : {};

    const codeKey = i === 0 ? "code" : `code${i + 1}`;
    const lineKey = i === 0 ? "l" : `l${i + 1}`;
    const commentKey = i === 0 ? "c" : `c${i + 1}`;
    const imagesKey = i === 0 ? "img" : `img${i + 1}`;

    params.set(codeKey, encodedCode);
    params.set(lineKey, lineValue);

    if (commentValue && !isDefaultExerciseText(commentValue)) {
      params.set(commentKey, encode_text_deflate_b64url(commentValue));
    }

    if (Object.keys(imagesValue).length > 0) {
      params.set(imagesKey, encode_text_deflate_b64url(JSON.stringify(imagesValue)));
    }
  }

  return params.toString();
}

/**
 * Télécharge un fichier texte.
 */
function downloadTextFile(text, filename, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

/**
 * Enregistre un fichier texte en laissant choisir le dossier et le nom.
 *
 * - Chrome / Edge : vraie fenêtre "Enregistrer sous" (showSaveFilePicker).
 *   Le dernier dossier utilisé est retenu par le navigateur.
 * - Autres navigateurs : on demande le nom puis téléchargement classique.
 *
 * La fenêtre doit s'ouvrir juste après le clic de l'utilisateur, donc
 * `contenu` peut être une fonction (async) appelée seulement APRÈS le choix
 * de l'emplacement (utile quand la préparation du fichier est longue).
 *
 * Renvoie true si le fichier a été enregistré, false si annulé ou erreur.
 */
async function saveTextFileAs(contenu, { defaultName, extension, mimeType, promptLabel, description }) {
  // Case "Google Drive" cochée : le fichier part sur le Drive
  if (window.DariushDrive && window.DariushDrive.isEnabled()) {
    return window.DariushDrive.saveText(contenu, { defaultName, extension, promptLabel });
  }

  const getText = async () => (typeof contenu === "function" ? await contenu() : contenu);

  if (typeof window.showSaveFilePicker === "function") {
    let handle = null;
    try {
      handle = await window.showSaveFilePicker({
        id: "dariush-enregistrer",
        suggestedName: defaultName,
        types: [{ description: description || extension, accept: { "text/plain": [extension] } }]
      });
    } catch (err) {
      if (err && err.name === "AbortError") return false; // Annuler dans la fenêtre
      console.warn("Enregistrer sous indisponible, téléchargement classique :", err);
    }

    if (handle) {
      try {
        const text = await getText();
        if (text == null) return false;
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return true;
      } catch (err) {
        console.error("Erreur d'écriture du fichier :", err);
        alert("Impossible d'écrire le fichier : " + (err?.message || String(err)));
        return false;
      }
    }
  }

  // Repli : demande du nom + dossier Téléchargements
  const text = await getText();
  if (text == null) return false;

  const saisie = prompt(promptLabel || "Nom du fichier :", defaultName);
  if (saisie === null) return false;
  const filename = saisie.trim() || defaultName;
  const finalName = filename.toLowerCase().endsWith(extension.toLowerCase())
    ? filename
    : (filename + extension);

  downloadTextFile(text, finalName, mimeType || "text/plain;charset=utf-8");
  return true;
}

/**
 * Enregistre seulement le code actif dans un fichier .py
 */
function savePythonFileToDisk() {
  if (!editor) return;

  return saveTextFileAs(editor.getValue(), {
    defaultName: "code.py",
    extension: ".py",
    mimeType: "text/x-python;charset=utf-8",
    promptLabel: "Nom du fichier Python :",
    description: "Fichier Python"
  });
}

/**
 * Enregistre tout dans un fichier Dariush Python .dpy
 * Format texte : code=...&l=...&c=...
 */
function saveDariushFileToDisk() {
  const rawPayload = buildDariushRawPayload();
  if (!rawPayload) return;

  return saveTextFileAs(rawPayload, {
    defaultName: "activite" + DARIUSH_FILE_EXTENSION,
    extension: DARIUSH_FILE_EXTENSION,
    mimeType: DARIUSH_FILE_MIME,
    promptLabel: "Nom du fichier Dariush Python :",
    description: "Fichier Dariush Python"
  });
}


function saveDariushFileToDiskWithFixedName(filename = "sauvegarde_avant_connexion.dpy") {
  const rawPayload = buildDariushRawPayload();
  if (!rawPayload) return false;

  const finalName = filename.toLowerCase().endsWith(DARIUSH_FILE_EXTENSION)
    ? filename
    : (filename + DARIUSH_FILE_EXTENSION);

  downloadTextFile(rawPayload, finalName, DARIUSH_FILE_MIME);
  return true;
}

window.saveDariushFileToDiskWithFixedName = saveDariushFileToDiskWithFixedName;

/**
 * Menu Enregistrer
 */
async function handleSavePythonAction() {
  const choice = await chooseActionDialog("Quel format de fichier ?", [
    {
      value: "dpy",
      label: "1 : Enregistrer tout dans un fichier Dariush Python (" + DARIUSH_FILE_EXTENSION + ")"
    },
    {
      value: "py",
      label: "2 : Exporter le code actif dans un fichier Python (.py)"
    },
    {
      value: "ipynb",
      label: "3 : Exporter en notebook Jupyter (.ipynb)"
    },
    { value: "pdf",   label: "4 : Exporter en PDF (impression)" }
  ]);

  if (!choice) return;

  if (choice === "py") {
    savePythonFileToDisk();
    return;
  }

  if (choice === "dpy") {
    saveDariushFileToDisk();
    return;
  }

  if (choice === "ipynb") {
    saveNotebookFileToDisk();
    return;
  }

   if (choice === "pdf")   { exportNotebookToPrintPdf(); return; }

  throw new Error("Action inconnue : " + choice);
}
/* =========================================================
   THEME CODEMIRROR : sombre / clair et horizontal/vertical
   ========================================================= */

const EDITOR_THEME_STORAGE_KEY = "dariush_editor_theme_v1";
const EDITOR_LAYOUT_STORAGE_KEY = "dariush_editor_layout_v1";

/* Trois modes possibles :
   - "clair"   : CodeMirror clair  + markdown/fond clair
   - "monokai" : CodeMirror sombre + markdown/fond clair  (défaut)
   - "sombre"  : CodeMirror sombre + markdown/fond sombre
*/
const EDITOR_MODES = ["clair", "monokai", "sombre"];

function getSavedEditorMode() {
  try {
    const saved = localStorage.getItem(EDITOR_THEME_STORAGE_KEY);
    // Migration des anciennes valeurs ("default" => "clair")
    if (saved === "default") return "clair";
    if (EDITOR_MODES.includes(saved)) return saved;
    return "monokai"; // défaut
  } catch (err) {
    console.warn("Impossible de lire le thème sauvegardé :", err);
    return "monokai";
  }
}

// Renvoie le thème CodeMirror correspondant au mode
function cmThemeFromMode(mode) {
  return mode === "clair" ? "default" : "monokai";
}

// Conservé pour compatibilité : interpreteur.js l'appelle au chargement
function getSavedEditorTheme() {
  return cmThemeFromMode(getSavedEditorMode());
}

function saveEditorTheme(modeName) {
  try {
    localStorage.setItem(EDITOR_THEME_STORAGE_KEY, modeName);
  } catch (err) {
    console.warn("Impossible de sauvegarder le thème :", err);
  }
}

function getSavedEditorLayout() {
  try {
    const saved = localStorage.getItem(EDITOR_LAYOUT_STORAGE_KEY);
    return saved === "vertical" ? "vertical" : "horizontal";
  } catch (err) {
    console.warn("Impossible de lire l'affichage sauvegardé :", err);
    return "horizontal";
  }
}

function saveEditorLayout(layoutName) {
  try {
    const finalLayout = layoutName === "horizontal" ? "horizontal" : "vertical";
    localStorage.setItem(EDITOR_LAYOUT_STORAGE_KEY, finalLayout);
  } catch (err) {
    console.warn("Impossible de sauvegarder l'affichage :", err);
  }
}

function updateThemeButtonAppearance(mode) {
  const themeButton = document.getElementById("themeButton");
  if (!themeButton) return;

  if (mode === "clair") {
    themeButton.textContent = "🌙";
    themeButton.title = "Thème actuel : clair — cliquer pour passer en Monokai";
  } else if (mode === "monokai") {
    themeButton.textContent = "🌘";
    themeButton.title = "Thème actuel : Monokai — cliquer pour passer en Sombre";
  } else { // "sombre"
    themeButton.textContent = "☀️";
    themeButton.title = "Thème actuel : sombre — cliquer pour passer en clair";
  }
}

function applyEditorTheme(modeOrLegacyTheme) {
  if (!editor) return;

  // Accepte soit un mode ("clair"/"monokai"/"sombre"), soit une ancienne valeur ("default"/"monokai")
  let mode;
  if (modeOrLegacyTheme === "default") mode = "clair";
  else if (EDITOR_MODES.includes(modeOrLegacyTheme)) mode = modeOrLegacyTheme;
  else mode = "monokai";

  editor.setOption("theme", cmThemeFromMode(mode));
  updateThemeButtonAppearance(mode);
  saveEditorTheme(mode);

  // Mode sombre global : assombrit le markdown, le fond de page et l'output
  document.body.classList.toggle("dariush-dark", mode === "sombre");
}

function toggleEditorTheme() {
  if (!editor) return;
  const currentMode = getSavedEditorMode();
  const idx = EDITOR_MODES.indexOf(currentMode);
  const nextMode = EDITOR_MODES[(idx + 1) % EDITOR_MODES.length];
  applyEditorTheme(nextMode);
}


window.getSavedEditorLayout = getSavedEditorLayout;
window.saveEditorLayout = saveEditorLayout;

/* =========================================================
   REDIMENSIONNEMENT DES COLONNES code / résultat
   Sans sauvegarde : retour au layout par défaut à chaque lancement
   ========================================================= */

function initColumnResize() {
  const split = document.getElementById("mainSplit");
  const leftCol = document.getElementById("leftCol");
  const rightCol = document.getElementById("rightCol");
  const resizer = document.getElementById("colResizer");

  if (!split || !leftCol || !rightCol || !resizer) return;

  const MIN_LEFT = 420;   // largeur mini de la zone code
  const MIN_RIGHT = 100;  // largeur mini de la zone résultat

  let isDragging = false;

  function refreshEditorAfterLayout() {
    if (window.pythonEditor && typeof window.pythonEditor.refresh === "function") {
      requestAnimationFrame(() => {
        window.pythonEditor.refresh();
      });
    }
  }

  function setDefaultSplitLayout() {
    split.style.gridTemplateColumns = `minmax(${MIN_LEFT}px, 1fr) 10px minmax(${MIN_RIGHT}px, 1fr)`;
    refreshEditorAfterLayout();
  }

  function setSplitLayout(leftPx, totalWidth) {
    const resizerWidth = resizer.offsetWidth || 10;
    const maxLeft = totalWidth - resizerWidth - MIN_RIGHT;

    const safeLeft = Math.max(MIN_LEFT, Math.min(leftPx, maxLeft));
    const rightPx = totalWidth - resizerWidth - safeLeft;

    split.style.gridTemplateColumns = `${safeLeft}px ${resizerWidth}px ${rightPx}px`;
    refreshEditorAfterLayout();
  }

  function updateFromPointer(clientX) {
    const rect = split.getBoundingClientRect();
    const totalWidth = rect.width;
    const leftPx = clientX - rect.left;

    setSplitLayout(leftPx, totalWidth);
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    updateFromPointer(e.clientX);
  }

  function onPointerUp() {
    if (!isDragging) return;

    isDragging = false;
    split.classList.remove("is-dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);

    refreshEditorAfterLayout();
  }

  resizer.addEventListener("pointerdown", (e) => {
    if (window.innerWidth <= 460) return;

    isDragging = true;
    split.classList.add("is-dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    e.preventDefault();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth <= 460) {
      split.style.gridTemplateColumns = "";
      refreshEditorAfterLayout();
      return;
    }

    setDefaultSplitLayout();
  });

  if (window.innerWidth > 460) {
    setDefaultSplitLayout();
  }
}


//fermeture par la croix du panneau travailler en groupe
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("closeConnexionPanel");
  const panel = document.getElementById("connexion");

  if (closeBtn && panel) {
    closeBtn.addEventListener("click", () => {
      panel.classList.remove("group-open");

      
    });
  }
});
/* ================================
   envoi d un exercice
================================ */

window.verifierCodeUtilisateur = async function () {
  const code = document.getElementById("verificationCodeUtilisateur")?.value.trim() || "";
  const message = document.getElementById("messageVerificationCode");

  if (message) {
    message.textContent = "";
  }

  if (!code) {
    if (message) {
      message.textContent = "Merci d’entrer un code utilisateur.";
      message.style.color = "#b00020";
    }
    return;
  }

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/verifier_code_utilisateur.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        code_utilisateur: code
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Erreur lors de la vérification");
    }

    if (data.valide) {
      document.getElementById("proposerEtapeCode").style.display = "none";
      document.getElementById("proposerEtapeInscription").style.display = "none";
      document.getElementById("proposerEtapeFormulaire").style.display = "block";

      if (message) {
        message.textContent = "";
      }
    } else {
      afficherDemandeInscription("Code utilisateur non reconnu.");
    }
  } catch (err) {
    console.error(err);
    afficherDemandeInscription("Erreur lors de la vérification du code utilisateur.");
  }
};

window.afficherDemandeInscription = function (messageTexte = "") {
  const messageCode = document.getElementById("messageVerificationCode");
  const messageInscription = document.getElementById("messageInscriptionExercice");

  document.getElementById("proposerEtapeCode").style.display = "none";
  document.getElementById("proposerEtapeFormulaire").style.display = "none";
  document.getElementById("proposerEtapeInscription").style.display = "block";

  if (messageCode) {
    messageCode.textContent = "";
  }

  if (messageInscription) {
    messageInscription.textContent = messageTexte || "";
    messageInscription.style.color = "#b00020";
  }
};

window.envoyerPropositionExercice = async function () {
  const codeUtilisateur = document.getElementById("verificationCodeUtilisateur")?.value.trim() || "";
  const niveau = document.getElementById("proposerNiveau")?.value || "autre";
  const descriptif = document.getElementById("proposerDescriptif")?.value.trim() || "";
  const lienSaisi = document.getElementById("proposerLien")?.value.trim() || "";
  const accesRestreint = document.getElementById("proposerAccesRestreint")?.checked ? true : false;

  if (!codeUtilisateur || !descriptif) {
    alert("Merci de remplir au moins le code utilisateur et le descriptif.");
    return;
  }

  let lien = lienSaisi;

  if (!lien) {
    lien = await buildExerciseLinkForDatabase();
    if (!lien) {
      return;
    }

    const lienTextarea = document.getElementById("proposerLien");
    if (lienTextarea) {
      lienTextarea.value = lien;
    }
  }

  if (isExerciseLinkTooLarge(lien)) {
    alert(getExerciseLinkTooLargeMessage());
    return;
  }

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/ajouter_exercice.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        code_utilisateur: codeUtilisateur,
        niveau: niveau,
        descriptif: descriptif,
        lien: lien,
        acces_restreint: accesRestreint,
        source: getDariushSource()
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Erreur lors de l'envoi");
    }

    let message = "Exercice ajouté avec succès.";
    if (data.url_courte) {
      message += "\n\nLien court d'ouverture :\n" + data.url_courte;
    }

    alert(message);

     

    showMenuPanel('panel-enseignant');

    document.getElementById("proposerNiveau").value = "premiere";
    document.getElementById("proposerDescriptif").value = "";
    document.getElementById("proposerLien").value = "";
    document.getElementById("proposerEtapeFormulaire").style.display = "none";
    document.getElementById("proposerEtapeInscription").style.display = "none";
    document.getElementById("proposerEtapeCode").style.display = "block";
    const messageCode = document.getElementById("messageVerificationCode");
    if (messageCode) messageCode.textContent = "";

   /*
    document.getElementById("verificationCodeUtilisateur").value = "";
    document.getElementById("proposerNiveau").value = "premiere";
    document.getElementById("proposerDescriptif").value = "";
    document.getElementById("proposerLien").value = "";

    document.getElementById("proposerEtapeFormulaire").style.display = "none";
    document.getElementById("proposerEtapeInscription").style.display = "none";
    document.getElementById("proposerEtapeCode").style.display = "block";

    const messageCode = document.getElementById("messageVerificationCode");
    if (messageCode) {
      messageCode.textContent = "";
    }*/
  } catch (err) {
    console.error(err);
    alert("Erreur : " + err.message);
  }
};

window.ouvrirMailInscriptionExercice = function () {
  const nom = document.getElementById("inscriptionNom")?.value.trim() || "";
  const prenom = document.getElementById("inscriptionPrenom")?.value.trim() || "";
  const ville = document.getElementById("inscriptionVille")?.value.trim() || "";
  const statut = document.getElementById("inscriptionStatut")?.value || "";
  const niveau = document.getElementById("inscriptionNiveau")?.value || "";
  const descriptif = document.getElementById("inscriptionDescriptif")?.value.trim() || "";
  const lien = document.getElementById("inscriptionLien")?.value.trim() || "";
  const checkbox = document.getElementById("inscriptionCodeOublie");
  const codeOublie = checkbox ? checkbox.checked : false;
  const messageInscription = document.getElementById("messageInscriptionExercice");

  if (messageInscription) {
    messageInscription.textContent = "";
  }

  // ===== MODE SPÉCIAL : demande de code pour lien court =====
  if (window.modeDemandeCodeLienCourt === true) {
    if (!nom || !prenom || !ville || !statut) {
      if (messageInscription) {
        messageInscription.textContent = "Merci de remplir tous les champs.";
        messageInscription.style.color = "#b00020";
      }
      return;
    }

    const sujet = encodeURIComponent(
      codeOublie
        ? "récupération de code utilisateur pour lien court"
        : "demande de code utilisateur pour lien court"
    );

    const corps = encodeURIComponent(
      "Bonjour,\n\n" +
      "Je souhaite " + (codeOublie ? "récupérer" : "obtenir") + " un code utilisateur pour bénéficier d’un lien court permanent.\n\n" +
      "Nom : " + nom + "\n" +
      "Prénom : " + prenom + "\n" +
      "Ville / établissement : " + ville + "\n" +
      "Statut : " + statut + "\n" +
      "J’avais un code utilisateur mais je l’ai oublié : " + (codeOublie ? "OUI" : "NON") + "\n"
    );

    window.location.href = `mailto:prof.boissac@gmail.com?subject=${sujet}&body=${corps}`;
    return;
  }

  // ===== MODE NORMAL EXISTANT =====
  if (!nom || !prenom || !ville || !statut || !niveau || !descriptif || !lien) {
    if (messageInscription) {
      messageInscription.textContent = "Merci de remplir tous les champs.";
      messageInscription.style.color = "#b00020";
    }
    return;
  }

  if (isExerciseLinkTooLarge(lien)) {
    if (messageInscription) {
      messageInscription.textContent = getExerciseLinkTooLargeMessage();
      messageInscription.style.color = "#b00020";
    } else {
      alert(getExerciseLinkTooLargeMessage());
    }
    return;
  }

  let niveauLibelle = "";
  if (niveau === "premiere") niveauLibelle = "Collège jusqu'à Première NSI";
  else if (niveau === "terminale") niveauLibelle = "Jusqu'à Terminale NSI";
  else if (niveau === "autre") niveauLibelle = "Supérieur (Post-Bac)";

  const sujet = encodeURIComponent(
    codeOublie
      ? "demande de récupération de code utilisateur et proposition d’exercice"
      : "demande de code utilisateur et proposition d’exercice"
  );

  const corps = encodeURIComponent(
    "Bonjour,\n\n" +
    "Je souhaite " + (codeOublie ? "récupérer" : "obtenir") + " un code utilisateur pour pouvoir ajouter mes exercices sur Dariush Python.\n\n" +
    "Nom : " + nom + "\n" +
    "Prénom : " + prenom + "\n" +
    "Ville : " + ville + "\n" +
    "Statut : " + statut + "\n" +
    "J’avais un code utilisateur mais je l’ai oublié : " + (codeOublie ? "OUI" : "NON") + "\n\n" +
    "Premier exercice à ajouter :\n" +
    "Niveau : " + niveauLibelle + "\n" +
    "Descriptif : " + descriptif + "\n" +
    "Lien : " + lien + "\n"
  );

  window.location.href = `mailto:prof.boissac@gmail.com?subject=${sujet}&body=${corps}`;
};

async function remplirLiensPropositionDepuisEditeur() {
  let lienCourant = "";

  if (typeof buildLink === "function") {
    try {
      lienCourant = await buildLink({ askDate: false });
    } catch (err) {
      console.warn("Impossible de construire le lien :", err);
    }
  }

  if (!lienCourant) {
    lienCourant = document.getElementById("generatedLink")?.value || "";
  }

  const proposerLien = document.getElementById("proposerLien");
  if (proposerLien) {
    proposerLien.value = lienCourant;
    proposerLien.placeholder = "";
  }

  const inscriptionLien = document.getElementById("inscriptionLien");
  if (inscriptionLien) {
    inscriptionLien.value = lienCourant;
    inscriptionLien.placeholder = "";
  }
}


window.envoyerDemandeCodeUtilisateur = function () {
  const nom = document.getElementById("obtenirCodeNom")?.value.trim() || "";
  const prenom = document.getElementById("obtenirCodePrenom")?.value.trim() || "";
  const ville = document.getElementById("obtenirCodeVille")?.value.trim() || "";
  const statut = document.getElementById("obtenirCodeStatut")?.value || "";
  const codeOublie = document.getElementById("obtenirCodeOublie")?.checked || false;
  const message = document.getElementById("messageObtenirCode");

  if (message) message.textContent = "";

  if (!nom || !prenom || !ville || !statut) {
    if (message) {
      message.textContent = "Merci de remplir tous les champs.";
      message.style.color = "#b00020";
    }
    return;
  }

  const sujet = encodeURIComponent(
    codeOublie
      ? "Récupération de code utilisateur Dariush Python"
      : "Demande de code utilisateur Dariush Python"
  );

  const corps = encodeURIComponent(
    "Bonjour,\n\n" +
    "Je souhaiterais " + (codeOublie ? "récupérer" : "obtenir") + " un code utilisateur pour Dariush Python.\n\n" +
    "Nom : " + nom + "\n" +
    "Prénom : " + prenom + "\n" +
    "Ville / établissement : " + ville + "\n" +
    "Statut : " + statut + "\n" +
    "J'avais un code utilisateur mais je l'ai oublié : " + (codeOublie ? "OUI" : "NON") + "\n"
  );

  window.location.href = `mailto:prof.boissac@gmail.com?subject=${sujet}&body=${corps}`;
};

window.resetObtenirCodePanel = function () {
  const fields = ["obtenirCodeNom", "obtenirCodePrenom", "obtenirCodeVille"];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const statut = document.getElementById("obtenirCodeStatut");
  if (statut) statut.value = "";
  const oublie = document.getElementById("obtenirCodeOublie");
  if (oublie) oublie.checked = false;
  const msg = document.getElementById("messageObtenirCode");
  if (msg) msg.textContent = "";
};
window.resetProposerPanel = function () {
  
  window.modeDemandeCodeLienCourt = false;
restaurerFormulaireInscriptionNormal();
  
  document.getElementById("proposerEtapeCode").style.display = "block";
  document.getElementById("proposerEtapeFormulaire").style.display = "none";
  document.getElementById("proposerEtapeInscription").style.display = "none";

  const messageCode = document.getElementById("messageVerificationCode");
  if (messageCode) {
    messageCode.textContent = "";
  }

  const messageInscription = document.getElementById("messageInscriptionExercice");
  if (messageInscription) {
    messageInscription.textContent = "";
  }

  //document.getElementById("verificationCodeUtilisateur").value = "";

  const proposerNiveau = document.getElementById("proposerNiveau");
  if (proposerNiveau) proposerNiveau.value = "premiere";

  const proposerDescriptif = document.getElementById("proposerDescriptif");
  if (proposerDescriptif) proposerDescriptif.value = "";

  const inscriptionNom = document.getElementById("inscriptionNom");
  if (inscriptionNom) inscriptionNom.value = "";

  const inscriptionPrenom = document.getElementById("inscriptionPrenom");
  if (inscriptionPrenom) inscriptionPrenom.value = "";

  const inscriptionVille = document.getElementById("inscriptionVille");
  if (inscriptionVille) inscriptionVille.value = "";

  const inscriptionStatut = document.getElementById("inscriptionStatut");
  if (inscriptionStatut) inscriptionStatut.value = "";

  const inscriptionCodeOublie = document.getElementById("inscriptionCodeOublie");
  if (inscriptionCodeOublie) inscriptionCodeOublie.checked = false;

  const inscriptionNiveau = document.getElementById("inscriptionNiveau");
  if (inscriptionNiveau) inscriptionNiveau.value = "";

  const inscriptionDescriptif = document.getElementById("inscriptionDescriptif");
  if (inscriptionDescriptif) inscriptionDescriptif.value = "";

  remplirLiensPropositionDepuisEditeur();
};
  
  
  
 /* modal pour lien court */
window.modeDemandeCodeLienCourt = false;



function preparerFormulaireInscriptionPourLienCourt() {
  window.modeDemandeCodeLienCourt = true;

  showMenuPanel("panel-proposer");
  afficherDemandeInscription();

  const messageInscription = document.getElementById("messageInscriptionExercice");
  if (messageInscription) {
    messageInscription.textContent =
      "Récupérez votre lien court. Sa durée sera illimitée dès réception de votre code utilisateur.";
    messageInscription.style.color = "";
  }

  const idsOuBlocs = [
    "blocInscriptionNiveau",
    "blocInscriptionDescriptif",
    "blocInscriptionLien"
  ];

  let blocTrouve = false;

  idsOuBlocs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "none";
      blocTrouve = true;
    }
  });

  // Si les blocs n'existent pas dans le HTML, on masque directement champs + labels
  if (!blocTrouve) {
    const ids = ["inscriptionNiveau", "inscriptionDescriptif", "inscriptionLien"];

    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";

      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.style.display = "none";
    });
  }
}

function restaurerFormulaireInscriptionNormal() {
  window.modeDemandeCodeLienCourt = false;

  const idsOuBlocs = [
    "blocInscriptionNiveau",
    "blocInscriptionDescriptif",
    "blocInscriptionLien"
  ];

  let blocTrouve = false;

  idsOuBlocs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "";
      blocTrouve = true;
    }
  });

  if (!blocTrouve) {
    const ids = ["inscriptionNiveau", "inscriptionDescriptif", "inscriptionLien"];

    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = "";

      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.style.display = "";
    });
  }

  const messageInscription = document.getElementById("messageInscriptionExercice");
  if (messageInscription) {
    messageInscription.textContent = "";
  }
}
  
  
  /* gestion du bouton d affichage de la zone de commentaires*/
  const toggleBtn = document.getElementById("previewToggleBtn");
const bloc = document.getElementById("fenetrescommentaires");

let isVisible = true;

toggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();

  isVisible = !isVisible;

  if (isVisible) {
    bloc.style.display = "inline";
    toggleBtn.textContent = "—";
    toggleBtn.title = "Masquer le texte";
  } else {
    bloc.style.display = "none";
    toggleBtn.textContent = "□";
    toggleBtn.title = "Réafficher le texte";
  }
});