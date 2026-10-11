 let helpBugButton;

/* =========================================================
   OUTILS GÉNÉRAUX (pour corriger sans toucher aux chaînes)
   petit debugeur personnel de mauvaise qualité..............à améliorer
   ========================================================= */

/**
 * splitCodeAndComment(line)
 * Sépare une ligne en 2 parties :
 *  - code : tout ce qui est avant un # "réel" (hors guillemets)
 *  - comment : le commentaire (à partir de #) ou "" si absent
 *
 * Objectif : pouvoir corriger le code sans casser les commentaires
 *            et surtout sans modifier ce qui est dans "..." ou '...'.
 */
function splitCodeAndComment(line) {
  let inS = false, inD = false, esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }

    if (!inD && c === "'") inS = !inS;
    else if (!inS && c === '"') inD = !inD;
    else if (!inS && !inD && c === "#") {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: "" };
}

/**
 * hasOpenBrackets(code)
 * Renvoie true si la ligne a des parenthèses/crochets/accolades
 * "ouvertes" (balance > 0) hors chaînes.
 *
 * Objectif : éviter d'ajouter ":" au milieu d'une expression multi-ligne.
 */
function hasOpenBrackets(code) {
  let inS = false, inD = false, esc = false;
  let p = 0, b = 0, c = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }

    if (!inD && ch === "'") { inS = !inS; continue; }
    if (!inS && ch === '"') { inD = !inD; continue; }
    if (inS || inD) continue;

    if (ch === "(") p++;
    else if (ch === ")") p = Math.max(0, p - 1);
    else if (ch === "[") b++;
    else if (ch === "]") b = Math.max(0, b - 1);
    else if (ch === "{") c++;
    else if (ch === "}") c = Math.max(0, c - 1);
  }
  return (p + b + c) > 0;
}

/**
 * replaceOutsideStrings(code, fnCharHandler)
 * Applique une transformation caractère par caractère sur "code"
 * en ignorant ce qui est à l'intérieur des chaînes.
 *
 * fnCharHandler(ch, prevCh, nextCh) doit retourner :
 *  - null/undefined pour garder le char tel quel
 *  - une string pour remplacer ce char
 */
function replaceOutsideStrings(code, fnCharHandler) {
  let out = "";
  let inS = false, inD = false, esc = false;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const prev = i > 0 ? code[i - 1] : "";
    const next = i + 1 < code.length ? code[i + 1] : "";

    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }

    if (!inD && ch === "'") { inS = !inS; out += ch; continue; }
    if (!inS && ch === '"') { inD = !inD; out += ch; continue; }

    if (inS || inD) { out += ch; continue; }

    const rep = fnCharHandler(ch, prev, next);
    out += (rep === null || rep === undefined) ? ch : rep;
  }
  return out;
}


/* =========================================================
   UI : CONFIRMATIONS LIGNE PAR LIGNE / GLOBAL
   ========================================================= */

/**
 * applyLineDiffsWithConfirm(beforeCode, afterCode, buildMessage)
 *
 * Compare before/after ligne par ligne.
 * Pour chaque ligne modifiée, affiche un window.confirm :
 *  - OK      => applique la correction sur cette ligne
 *  - Annuler => conserve la ligne originale
 *
 * Retourne : { code, changed, incompatible }
 *
 * Incompatible = true si le nombre de lignes diffère (diff "structurel").
 * Dans ce cas, il vaut mieux proposer un confirm global.
 */


function normalizeCodeForDiff(code) {
  return String(code ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+$/g, "");
}

function restoreSingleTrailingNewline(code) {
  const normalized = normalizeCodeForDiff(code);
  return normalized ? (normalized + "\n") : "";
}






async function applyLineDiffsWithConfirm(beforeCode, afterCode, buildMessage) {
  const beforeLines = beforeCode.split("\n");
  const afterLines = afterCode.split("\n");

  if (beforeLines.length !== afterLines.length) {
    return { code: beforeCode, changed: false, incompatible: true };
  }

  let changed = false;

  // Synchroniser l'éditeur avec le code "avant" AVANT de surligner,
  // pour que les numéros de ligne correspondent à ce que l'utilisateur voit.
  if (typeof editor !== "undefined" && editor && typeof editor.getValue === "function") {
    if (editor.getValue() !== beforeCode) {
      editor.setValue(beforeCode);
    }
  }

  for (let i = 0; i < beforeLines.length; i++) {
    if (beforeLines[i] === afterLines[i]) continue;

    const lineNo = i + 1;
    const msg = buildMessage(lineNo, beforeLines[i], afterLines[i]);

    if (typeof highlightDebugLine === "function") {
      highlightDebugLine(lineNo);
    }

    const ok = await askCorrectionModal(
      lineNo,
      beforeLines[i],
      afterLines[i],
      msg
    );

    if (ok) {
      beforeLines[i] = afterLines[i];
      changed = true;
    }
  }

  if (typeof clearDebugHighlight === "function") {
    clearDebugHighlight();
  }

  return { code: beforeLines.join("\n"), changed, incompatible: false };
}

/**
 * applyWholeChangeWithConfirm(beforeCode, afterCode, message)
 *
 * Pour les corrections qui peuvent changer le nombre de lignes
 * (ex : conversion triple quotes), on propose un seul OK/Annuler.
 */
function applyWholeChangeWithConfirm(beforeCode, afterCode, message) {
  if (beforeCode === afterCode) return { code: beforeCode, changed: false };
  if (window.confirm(message)) return { code: afterCode, changed: true };
  return { code: beforeCode, changed: false };
}


/* =========================================================
   A) TRIPLE QUOTES -> COMMENTAIRES #
   ========================================================= */

/**
""" Transforme des blocs de docstrings/commentaires Python ('''...''' ou """...""")
en commentaires # ... pour éviter de casser la détection de input().

Règle volontairement restrictive :
- On ne transforme que si les triples quotes commencent au début d’une ligne (après indentation)
- On transforme jusqu’à la prochaine occurrence de la même triple-quote, sur une ligne ou plusieurs.
"""
*/
function Correcteur_tripleQuotesToHashComments(code) {
  const lines = code.split("\n");
  const out = [];

  let inBlock = false;
  let delim = null;      // "'''" ou '"""'
  let indent = "";       // indentation du début du bloc

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (!inBlock) {
      // Détecter ''' ou """ au début (après espaces)
      const m = line.match(/^(\s*)('''|""")/);
      if (!m) {
        out.push(line);
        continue;
      }

      indent = m[1];
      delim = m[2];
      inBlock = true;

      // Contenu après l'ouverture
      let rest = line.slice((indent + delim).length);

      // Cas 1 : ouverture et fermeture sur la même ligne
      const endPos = rest.indexOf(delim);
      if (endPos !== -1) {
        const inside = rest.slice(0, endPos);
        out.push(indent + "# " + inside.trimRight());
        // Reste après la fermeture (rare), on le garde tel quel
        const after = rest.slice(endPos + delim.length);
        if (after.trim().length) out.push(indent + "# " + after.trimRight());
        inBlock = false;
        delim = null;
        indent = "";
      } else {
        // Début de bloc multi-lignes
        out.push(indent + "# " + rest.trimRight());
      }
    } else {
      // On est dans le bloc
      const endPos = line.indexOf(delim);
      if (endPos !== -1) {
        const before = line.slice(0, endPos);
        out.push(indent + "# " + before.trimRight());
        // Reste après la fermeture
        const after = line.slice(endPos + delim.length);
        if (after.trim().length) out.push(indent + "# " + after.trimRight());
        inBlock = false;
        delim = null;
        indent = "";
      } else {
        out.push(indent + "# " + line.trimRight());
      }
    }
  }

  return out.join("\n");
}

function containsTripleQuotes(code) {
  return code.includes("'''") || code.includes('"""');
}


/* =========================================================
   B) INDENTATION "ÉVIDENTE" (tes 2 règles)
   ========================================================= */

/**
 * Correction_indentation_evidente(code)
 *
 * Règles simples :
 * 1) Si une ligne se termine par ":" (hors commentaire),
 *    la prochaine ligne "réelle" doit être plus indentée.
 *
 * 2) Si une ligne est plus indentée que la précédente "réelle"
 *    alors que la précédente ne se termine pas par ":",
 *    -> on aligne cette ligne sur la précédente.
 *
 * Notes :
 * - Ne suppose PAS 4 espaces.
 * - Remplace TAB par espaces (pour éviter IndentationError tab/espaces).
 * - Ignore lignes vides et commentaires seuls.
 */
function Correction_indentation_evidente(code) {
  // Normaliser TAB -> espaces
  var lines = code.replace(/\t/g, "    ").split("\n");

  function indentLen(line) {
    var m = line.match(/^ */);
    return m ? m[0].length : 0;
  }

  function trimRight(s) {
    return s.replace(/\s+$/, "");
  }

  // "ouvre un bloc" si ça finit par ":" hors commentaire
  function opensBlock(line) {
    var t = trimRight(line);
    if (t.trim() === "" || t.trim().startsWith("#")) return false;
    var noComment = t.split("#")[0]; // approximation : un # dans une chaîne coupe aussi la ligne
    return trimRight(noComment).endsWith(":");
  }

  function nextRealLineIndex(from) {
    for (var k = from; k < lines.length; k++) {
      var tr = lines[k].trim();
      if (tr === "" || tr.startsWith("#")) continue;
      return k;
    }
    return -1;
  }

  function prevRealLineIndex(from) {
    for (var k = from; k >= 0; k--) {
      var tr = lines[k].trim();
      if (tr === "" || tr.startsWith("#")) continue;
      return k;
    }
    return -1;
  }

  // Déterminer un "pas" d'indentation : plus petite indentation positive rencontrée
  var minStep = null;
  for (var i = 0; i < lines.length; i++) {
    var tr = lines[i].trim();
    if (tr === "" || tr.startsWith("#")) continue;
    var n = indentLen(lines[i]);
    if (n > 0 && (minStep === null || n < minStep)) minStep = n;
  }
  if (minStep === null) minStep = 2;

  for (var i2 = 0; i2 < lines.length; i2++) {
    var line = lines[i2];
    var tr2 = line.trim();

    if (tr2 === "" || tr2.startsWith("#")) continue;

    // Règle 2 (aligner)
    var pIdx = prevRealLineIndex(i2 - 1);
    if (pIdx !== -1) {
      var prevLine = lines[pIdx];
      var prevIndent = indentLen(prevLine);
      var curIndent = indentLen(line);

      if (!opensBlock(prevLine) && curIndent > prevIndent) {
        lines[i2] = " ".repeat(prevIndent) + line.trimStart();
        line = lines[i2];
      }
    }

    // Règle 1 (bloc après ":")
    if (opensBlock(line)) {
      var nIdx = nextRealLineIndex(i2 + 1);
      if (nIdx !== -1) {
        var baseIndent = indentLen(line);
        var nextIndent = indentLen(lines[nIdx]);

        if (nextIndent <= baseIndent) {
          var target = baseIndent + minStep;
          lines[nIdx] = " ".repeat(target) + lines[nIdx].trimStart();
        }
      }
    }
  }

  return lines.join("\n");
}


/* =========================================================
   D) POINT 6 — CARACTÈRES INVISIBLES / COPIER-COLLER
   ========================================================= */

/**
 * Correcteur_normalizeCopyPasteChars(code)
 *
 * Corrige des caractères très fréquents en copier/coller :
 * - espace insécable (NBSP) -> espace normal
 * - guillemets typographiques “ ” -> "
 * - apostrophes typographiques ‘ ’ -> '
 *
 * Important : correction "texte brut" volontairement simple.
 */
function Correcteur_normalizeCopyPasteChars(code) {
  return code
    .replace(/\u00A0/g, " ")   // NBSP
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}


/* =========================================================
   E) POINT 1 — PETITES FAUTES DE SYNTAXE TRÈS COURANTES
      (ET POINT 2 en partie : "else if" -> "elif" + &&/||/true/null)
   ========================================================= */

/**
 * Correcteur_fixCommonTokensPython(code)
 *
 * Corrige des habitudes venant de JS / pseudo-code :
 * - && -> and
 * - || -> or
 * - true/false -> True/False
 * - null -> None
 * - "else if ..." -> "elif ..."
 * - "!" (non suivi de "=") -> "not "
 *
 * Corrige uniquement la partie "code" de chaque ligne (hors commentaires #...).
 * Ne touche pas aux chaînes de caractères.
 */
function Correcteur_fixCommonTokensPython(code) {
  const lines = code.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tr = line.trim();
    if (tr === "" || tr.startsWith("#")) continue;

    const { code: codePart, comment } = splitCodeAndComment(line);

    // 1) else if -> elif (sur le code uniquement)
    let newCode = codePart.replace(/^(\s*)else\s+if\b/, "$1elif");

    // 2) &&, || (hors chaînes)
    newCode = replaceOutsideStrings(newCode, (ch, prev, next) => {
      if (ch === "&" && next === "&") return "and";
      if (ch === "|" && next === "|") return "or";
      return null;
    });

    // Nettoyage (cas rares) : si seul le 1er caractère de &&/|| a été remplacé,
    // il peut rester un 2e char. Ici on retire les résidus si présents.
    newCode = newCode.replace(/and&/g, "and").replace(/or\|/g, "or");

    // 3) true/false/null (mots entiers)
    newCode = newCode.replace(/\btrue\b/g, "True")
                     .replace(/\bfalse\b/g, "False")
                     .replace(/\bnull\b/g, "None");

    // 4) ! -> not  (avec prudence : ne pas casser !=)
    newCode = replaceOutsideStrings(newCode, (ch, prev, next) => {
      if (ch === "!" && next !== "=") {
        return "not ";
      }
      return null;
    });

    const merged = newCode + comment;
    if (merged !== line) {
      lines[i] = merged;
      changed = true;
    }
  }

  return changed ? lines.join("\n") : code;
}

/**
 * Correcteur_addMissingColon(code)
 *
 * Ajoute ":" manquant après un en-tête de bloc :
 * if / elif / else / for / while / def / class / try / except / finally / with
 *
 * Ne le fait PAS si :
 * - la ligne a déjà ":"
 * - la ligne est probablement une expression multi-ligne (parenthèses ouvertes)
 * - la ligne est vide/commentaire
 */
function Correcteur_addMissingColon(code) {
  const lines = code.split("\n");
  let changed = false;

  const headerRe = /^\s*(if|elif|else|for|while|def|class|try|except|finally|with)\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tr = line.trim();
    if (tr === "" || tr.startsWith("#")) continue;

    const { code: codePart, comment } = splitCodeAndComment(line);
    if (!headerRe.test(codePart)) continue;

    const trimmed = codePart.replace(/\s+$/, "");
    if (trimmed.endsWith(":")) continue;
    if (hasOpenBrackets(codePart)) continue;

    lines[i] = trimmed + ":" + comment;
    changed = true;
  }

  return changed ? lines.join("\n") : code;
}

/**
 * Correcteur_fixEqualsInConditions(code)
 *
 * Corrige l'erreur classique : "=" au lieu de "==" dans if/elif/while.
 * Ex :  if x = 3:  ->  if x == 3:
 *
 * Règle prudente :
 * - On ne modifie que les lignes commençant par if/elif/while
 * - On remplace uniquement les "=" "simples" (pas ==, !=, <=, >=, ===, :=)
 * - On ne touche pas aux chaînes ni aux commentaires
 */
function Correcteur_fixEqualsInConditions(code) {
  const lines = code.split("\n");
  let changed = false;

  const condRe = /^\s*(if|elif|while)\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tr = line.trim();
    if (tr === "" || tr.startsWith("#")) continue;

    const { code: codePart, comment } = splitCodeAndComment(line);
    if (!condRe.test(codePart)) continue;

    const fixed = replaceOutsideStrings(codePart, (ch, prev, next) => {
      if (ch !== "=") return null;

      // ignorer == et ===
      if (next === "=" || prev === "=") return null;

      // ignorer <= >= !=
      if (prev === "<" || prev === ">" || prev === "!") return null;

      // ignorer walrus :=
      if (prev === ":") return null;

      // "=" simple -> "=="
      return "==";
    });

    const merged = fixed + comment;
    if (merged !== line) {
      lines[i] = merged;
      changed = true;
    }
  }

  return changed ? lines.join("\n") : code;
}



/* =========================================================
   F) POINT 2 — print Python 2 -> Python 3 (safe)
   ========================================================= */

/**
 * Correcteur_python2PrintToPython3(code)
 *
 * Convertit les print "Python 2" vers Python 3 :
 * - print "salut"  -> print("salut")
 * - print x        -> print(x)
 *
 * Cas spécial :
 * - print x,   (virgule finale en Python2 = pas de retour à la ligne)
 *   -> print(x, end=" ")
 *
 * Règles prudentes :
 * - Ne touche pas si c'est déjà print(...)
 * - Ne touche pas aux lignes vides/commentaires
 * - Ne touche pas aux "print" dans des chaînes
 */
function Correcteur_python2PrintToPython3(code) {
  const lines = code.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tr = line.trim();
    if (tr === "" || tr.startsWith("#")) continue;

    const { code: codePart, comment } = splitCodeAndComment(line);

    // déjà print(...)
    if (/^\s*print\s*\(/.test(codePart)) continue;

    // détecter print <quelquechose>
    const m = codePart.match(/^(\s*)print\s+(.+?)\s*$/);
    if (!m) continue;

    const indent = m[1];
    let expr = m[2];

    // Si "print" est seul : print -> print()
    if (!expr || expr.trim() === "") {
      lines[i] = indent + "print()" + comment;
      changed = true;
      continue;
    }

    // Cas python2 "print x," (virgule finale)
    const exprTrim = expr.replace(/\s+$/, "");
    if (exprTrim.endsWith(",")) {
      const inside = exprTrim.slice(0, -1).trimRight();
      lines[i] = indent + 'print(' + inside + ', end=" ")' + comment;
      changed = true;
      continue;
    }

    // Cas normal : print x -> print(x)
    lines[i] = indent + "print(" + exprTrim + ")" + comment;
    changed = true;
  }

  return changed ? lines.join("\n") : code;
}


/* =========================================================
   tentative_correction() — APPLIQUE TOUT + LOG + CONFIRM UI
   ========================================================= */

async function Correcteur_autopep8(code) {
  if (typeof window.ensureAutopep8Ready !== "function") {
    throw new Error("ensureAutopep8Ready introuvable");
  }

  await window.ensureAutopep8Ready();

  if (!window.pyWorker || !window.pyWorkerReady) {
    throw new Error("Worker Python non prêt");
  }

  const inputCode = String(code ?? "");

  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data || {};

      if (data.type === "autopep8_result") {
        window.pyWorker.removeEventListener("message", onMessage);
        resolve(normalizeCodeForDiff(String(data.fixed ?? "")));
        return;
      }

      if (data.type === "error") {
        window.pyWorker.removeEventListener("message", onMessage);
        reject(new Error(data.message || "Erreur worker"));
      }
    };

    window.pyWorker.addEventListener("message", onMessage);
    window.pyWorker.postMessage({
      type: "run_autopep8",
      code: inputCode
    });
  });
}

async function tentative_correction() {
  if (!editor) return;

  // 1) Récupérer le code actuel de CodeMirror
  let code = editor.getValue();
  let changed = false;

  // 2) Log dans la sortie
  if (typeof ensureNewLine === "function") ensureNewLine();
  if (typeof appendOutput === "function") {
    appendOutput("\n");
    appendOutput("=== Aide-bug : analyse et corrections ===\n");
  }

  /* ---------------------------------------------------------
     A) Correction docstrings/commentaires multilignes ''' / """
     -> Comme ça peut changer le nombre de lignes, on propose un confirm global.
     --------------------------------------------------------- */
  if (typeof containsTripleQuotes === "function" && containsTripleQuotes(code)) {
    if (typeof appendOutput === "function") {
      appendOutput("• Détection : commentaires/docstrings ''' ou \"\"\" trouvés.\n");
    }

    if (typeof Correcteur_tripleQuotesToHashComments === "function") {
      const beforeA = code;
      const afterA = Correcteur_tripleQuotesToHashComments(code);

      const resA = applyWholeChangeWithConfirm(
        beforeA,
        afterA,
        "Docstrings / triple quotes détectés.\nVoulez-vous convertir ces blocs en commentaires # (recommandé pour éviter des bugs) ?"
      );

      if (resA.changed) {
        code = resA.code;
        changed = true;
        if (typeof appendOutput === "function") {
          appendOutput("• Correction appliquée : conversion '''/\"\"\" en commentaires #.\n");
        }
      }
    } else if (typeof appendOutput === "function") {
      appendOutput("ERR: Correcteur_tripleQuotesToHashComments est introuvable.\n");
    }
  }

  /* ---------------------------------------------------------
     B) Correction d'indentation "évidente" (2 règles)
     -> confirm ligne par ligne : "Ligne X : ... Voulez-vous corriger ?"
     --------------------------------------------------------- */
   try {
    const beforeB = normalizeCodeForDiff(code);

let autopep8Ready = false;
if (typeof window.ensureAutopep8Ready === "function") {
  try {
    await window.ensureAutopep8Ready();
    autopep8Ready = true;
  } catch (err) {
    autopep8Ready = false;
  }
}

let afterB = beforeB;
let sourceLabel = "autopep8";

if (autopep8Ready && typeof Correcteur_autopep8 === "function") {
  afterB = normalizeCodeForDiff(await Correcteur_autopep8(beforeB));

      if (afterB === beforeB && typeof Correction_indentation_evidente === "function") {
        afterB = normalizeCodeForDiff(Correction_indentation_evidente(beforeB));
        sourceLabel = "Dariush";

        if (typeof appendOutput === "function") {
          appendOutput("• autopep8 n'a proposé aucune correction sur ce code.\n");
          appendOutput("• Utilisation du correcteur d'indentation de Dariush.\n");
        }
      }
    } else if (typeof Correction_indentation_evidente === "function") {
      afterB = normalizeCodeForDiff(Correction_indentation_evidente(beforeB));
      sourceLabel = "Dariush";

      if (typeof appendOutput === "function") {
        const info =
          (typeof window.getAutopep8StatusMessage === "function")
            ? window.getAutopep8StatusMessage()
            : "autopep8 indisponible";
        appendOutput("• " + info + "\n");
        appendOutput("• Utilisation du correcteur d'indentation de Dariush.\n");
      }
    } else if (typeof appendOutput === "function") {
      appendOutput("• Indentation : aucun correcteur disponible.\n");
    }
    const resB = await applyLineDiffsWithConfirm(
      beforeB,
      afterB,
      (lineNo) => `Ligne ${lineNo} : Correction proposée par ${sourceLabel}.\nVoulez-vous corriger ?`
    );

    if (resB.incompatible) {
      const resWhole = applyWholeChangeWithConfirm(
        beforeB,
        afterB,
        `Plusieurs corrections structurelles ont été détectées par ${sourceLabel}.\nVoulez-vous appliquer la correction automatique (global) ?`
      );

      if (resWhole.changed) {
        code = restoreSingleTrailingNewline(resWhole.code);
        changed = true;
        if (typeof appendOutput === "function") {
          appendOutput(`• Correction appliquée : indentation / formatage (${sourceLabel}, global).\n`);
        }
      }
    } else if (resB.changed) {
     code = restoreSingleTrailingNewline(resB.code);
      changed = true;
      if (typeof appendOutput === "function") {
        appendOutput(`• Corrections appliquées : indentation / formatage (${sourceLabel}, ligne par ligne).\n`);
      }
    }
  } catch (err) {
    if (typeof appendOutput === "function") {
      appendOutput("• autopep8 a échoué : " + (err?.message || String(err)) + "\n");
    }

    if (typeof Correction_indentation_evidente === "function") {
      const beforeB = code;
      const afterB = Correction_indentation_evidente(beforeB);

      const resB = await applyLineDiffsWithConfirm(
        beforeB,
        afterB,
        (lineNo) => `Ligne ${lineNo} : Erreur d'indentation détectée (mode Dariush).\nVoulez-vous corriger ?`
      );

      if (resB.incompatible) {
        const resWhole = applyWholeChangeWithConfirm(
          beforeB,
          afterB,
          "Erreurs d'indentation détectées (mode Dariush).\nVoulez-vous appliquer la correction automatique (global) ?"
        );

        if (resWhole.changed) {
          code = resWhole.code;
          changed = true;
          if (typeof appendOutput === "function") {
            appendOutput("• Correction appliquée : indentation (, global).\n");
          }
        }
      } else if (resB.changed) {
        code = resB.code;
        changed = true;
        if (typeof appendOutput === "function") {
          appendOutput("• Corrections appliquées : indentation (Dariush, ligne par ligne).\n");
        }
      }
    }
  }
  /* ---------------------------------------------------------
     D) Normalisation copier/coller (NBSP, “ ”, ‘ ’)
     -> confirm ligne par ligne
     --------------------------------------------------------- */
  if (typeof Correcteur_normalizeCopyPasteChars === "function") {
    const beforeD = code;
    const afterD = Correcteur_normalizeCopyPasteChars(code);

    const resD =await  applyLineDiffsWithConfirm(
      beforeD,
      afterD,
      (lineNo) => `Ligne ${lineNo} : Caractères invisibles / guillemets typographiques détectés.\nVoulez-vous normaliser ?`
    );

    if (!resD.incompatible && resD.changed) {
      code = resD.code;
      changed = true;
      if (typeof appendOutput === "function") {
        appendOutput("• Corrections appliquées : normalisation copier-coller (ligne par ligne).\n");
      }
    }
  }

  /* ---------------------------------------------------------
     E) Tokens fréquents (&&/||/!/true/false/null/else if...)
     -> confirm ligne par ligne
     --------------------------------------------------------- */
  if (typeof Correcteur_fixCommonTokensPython === "function") {
    const beforeE = code;
    const afterE = Correcteur_fixCommonTokensPython(code);

    const resE =await  applyLineDiffsWithConfirm(
      beforeE,
      afterE,
      (lineNo) => `Ligne ${lineNo} : Syntaxe type JS/pseudo-code détectée (&&, ||, true, null, else if, !...).\nVoulez-vous corriger ?`
    );

    if (!resE.incompatible && resE.changed) {
      code = resE.code;
      changed = true;
      if (typeof appendOutput === "function") {
        appendOutput("• Corrections appliquées : tokens fréquents (ligne par ligne).\n");
      }
    }
  }

  /* ---------------------------------------------------------
     E2) Ajout des ":" manquants sur en-têtes de blocs
     -> confirm ligne par ligne
     --------------------------------------------------------- */
  if (typeof Correcteur_addMissingColon === "function") {
    const beforeE2 = code;
    const afterE2 = Correcteur_addMissingColon(code);

    const resE2 =await  applyLineDiffsWithConfirm(
      beforeE2,
      afterE2,
      (lineNo) => `Ligne ${lineNo} : Deux-points ':' manquant après un en-tête (if/for/def/...).\nVoulez-vous l'ajouter ?`
    );

    if (!resE2.incompatible && resE2.changed) {
      code = resE2.code;
      changed = true;
      if (typeof appendOutput === "function") {
        appendOutput("• Corrections appliquées : ajout de ':' manquant (ligne par ligne).\n");
      }
    }
  }

  /* ---------------------------------------------------------
     E3) "=" au lieu de "==" dans if/elif/while
     -> confirm ligne par ligne
     --------------------------------------------------------- */
  if (typeof Correcteur_fixEqualsInConditions === "function") {
    const beforeE3 = code;
    const afterE3 = Correcteur_fixEqualsInConditions(code);

    const resE3 =await  applyLineDiffsWithConfirm(
      beforeE3,
      afterE3,
      (lineNo) => `Ligne ${lineNo} : Utilisation de '=' au lieu de '==' dans une condition.\nVoulez-vous corriger ?`
    );

    if (!resE3.incompatible && resE3.changed) {
      code = resE3.code;
      changed = true;
      if (typeof appendOutput === "function") {
        appendOutput("• Corrections appliquées : '=' -> '==' (ligne par ligne).\n");
      }
    }
  }

  /* ---------------------------------------------------------
     F) print Python 2 -> Python 3
     -> confirm ligne par ligne
     --------------------------------------------------------- */
  if (typeof Correcteur_python2PrintToPython3 === "function") {
    const beforeF = code;
    const afterF = Correcteur_python2PrintToPython3(code);

    const resF =await  applyLineDiffsWithConfirm(
      beforeF,
      afterF,
      (lineNo) => `Ligne ${lineNo} : 'print' Python 2 détecté.\nVoulez-vous convertir en print(...) Python 3 ?`
    );

    if (!resF.incompatible && resF.changed) {
      code = resF.code;
      changed = true;
      if (typeof appendOutput === "function") {
        appendOutput("• Corrections appliquées : print Python 2 -> Python 3 (ligne par ligne).\n");
      }
    }
  }

  /* ---------------------------------------------------------
     Z) Appliquer dans CodeMirror (une seule fois à la fin)
     --------------------------------------------------------- */
  if (changed) {
    editor.setValue(code);
    if (typeof appendOutput === "function") {
      appendOutput("=== Fin de la tentative de corrections de bugs ===\n");
    }
  } else if (typeof appendOutput === "function") {
    appendOutput("=== Aucune correction appliquée ===\n");
  }

  if (typeof appendOutput === "function") appendOutput("\n");
}
function escapeHtmlCorrecteur(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function askCorrectionModal(lineNo, beforeLine, afterLine, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.pointerEvents = "none";
    overlay.style.display = "flex";
    overlay.style.zIndex = "14000";

    const modal = document.createElement("div");
    modal.className = "menu-modal-window";
    modal.style.width = "min(760px, calc(100vw - 32px))";
    modal.style.maxHeight = "min(80vh, 900px)";
    modal.style.position = "absolute";
    modal.style.top = "80px";
    modal.style.left = "80px";
    modal.style.pointerEvents = "auto";

    modal.innerHTML = `
      <div class="menu-modal-header">
        <h3>Correction proposée — ligne ${lineNo}</h3>
      </div>

      <div class="menu-modal-body">
        <p>${escapeHtmlCorrecteur(message)}</p>

        <div style="margin-top:12px;">
          <div style="font-weight:600; margin-bottom:6px;">Avant</div>
          <pre style="margin:0; padding:10px; background:#f7f7f7; border:1px solid #ddd; border-radius:8px; white-space:pre-wrap;">${escapeHtmlCorrecteur(beforeLine)}</pre>
        </div>

        <div style="margin-top:12px;">
          <div style="font-weight:600; margin-bottom:6px;">Après</div>
          <pre style="margin:0; padding:10px; background:#f7f7f7; border:1px solid #ddd; border-radius:8px; white-space:pre-wrap;">${escapeHtmlCorrecteur(afterLine)}</pre>
        </div>
      </div>

      <div class="menu-modal-footer" style="gap:10px;">
        <button type="button" class="nav-item nav-btn" data-action="no">Ignorer</button>
        <button type="button" class="nav-item nav-btn" data-action="yes">Corriger</button>
      </div>
    `;

    // ===== déplacement de la fenêtre =====
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const header = modal.querySelector(".menu-modal-header");
    if (header) {
      header.style.cursor = "move";

      header.addEventListener("mousedown", (e) => {
        // évite de démarrer un drag si un texte est sélectionné
        isDragging = true;
        offsetX = e.clientX - modal.offsetLeft;
        offsetY = e.clientY - modal.offsetTop;
        e.preventDefault();
      });

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }

    function onMouseMove(e) {
      if (!isDragging) return;

      modal.style.left = (e.clientX - offsetX) + "px";
      modal.style.top = (e.clientY - offsetY) + "px";
    }

    function onMouseUp() {
      isDragging = false;
    }

    function cleanupDragListeners() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    function close(answer) {
      cleanupDragListeners();
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(answer);
    }

    modal.querySelector('[data-action="yes"]').addEventListener("click", () => close(true));
    modal.querySelector('[data-action="no"]').addEventListener("click", () => close(false));

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        close(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}