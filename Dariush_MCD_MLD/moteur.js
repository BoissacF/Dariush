/*
  moteur.js — Dariush MCD-MLD
  Cœur de calcul, indépendant de la page (aucun accès au DOM) :
  - lecture et écriture d'un MCD au format texte Mocodo (sous-ensemble) ;
  - passage MCD -> MLD selon les règles de Merise ;
  - génération du bloc Mermaid du MCD, du MLD (texte markdown et schéma
    Mermaid erDiagram) et du script SQL (SQLite, pour sql.js).
  Exposé via window.MoteurMCD.

  Modèle manipulé :
  {
    sens: "LR" | "TB",
    entites:      [{ id, nom, attributs: [{ nom, ident, type }] }],
    associations: [{ id, nom, pattes: [{ entite, card, role }], attributs: [{ nom, type }] }]
  }
  card vaut "01", "11", "0N", "1N" ou "" (pas encore choisie).
  Non gérés (signalés par un avertissement) : identifiants relatifs, héritage.
*/
(function () {
  "use strict";

  const CARDS = ["01", "11", "0N", "1N"];
  const estFonctionnelle = (c) => c === "01" || c === "11";
  const cardTexte = (c) => (CARDS.includes(c) ? c.charAt(0) + "," + c.charAt(1) : "?");

  let compteurId = 0;
  const nouvelId = (prefixe) => prefixe + (++compteurId);

  function nouveauModele() {
    return { sens: "LR", entites: [], associations: [] };
  }

  // ============================================================
  //   OUTILS TEXTE
  // ============================================================

  // Découpe sur un séparateur en ignorant ceux placés entre crochets.
  function decouper(texte, sep) {
    const morceaux = [];
    let profondeur = 0, courant = "";
    for (const ch of String(texte)) {
      if (ch === "[") profondeur++;
      else if (ch === "]" && profondeur > 0) profondeur--;
      if (ch === sep && profondeur === 0) { morceaux.push(courant); courant = ""; }
      else courant += ch;
    }
    morceaux.push(courant);
    return morceaux;
  }

  function indexHorsCrochets(texte, car) {
    let profondeur = 0;
    for (let i = 0; i < texte.length; i++) {
      const ch = texte[i];
      if (ch === "[") profondeur++;
      else if (ch === "]" && profondeur > 0) profondeur--;
      else if (ch === car && profondeur === 0) return i;
    }
    return -1;
  }

  // Nom utilisable dans le texte Mocodo (pas de , : [ ] ni de _ en tête).
  function nomMocodo(s) {
    return String(s || "").replace(/[,:\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().replace(/^_+/, "");
  }

  // Nom SQL : sans accents, lettres, chiffres et _ seulement.
  function nomSQL(s) {
    let n = String(s || "")
      .replace(/œ/g, "oe").replace(/Œ/g, "OE").replace(/æ/g, "ae").replace(/Æ/g, "AE").replace(/ß/g, "ss")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    if (!n) n = "x";
    if (/^[0-9]/.test(n)) n = "_" + n;
    return n;
  }

  const MOTS_RESERVES = new Set((
    "ABORT ACTION ADD AFTER ALL ALTER ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY " +
    "CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT_DATE " +
    "CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT " +
    "DROP EACH ELSE END ESCAPE EXCEPT EXCLUSIVE EXISTS EXPLAIN FAIL FOR FOREIGN FROM FULL GLOB GROUP " +
    "HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS " +
    "ISNULL JOIN KEY LEFT LIKE LIMIT MATCH NATURAL NO NOT NOTNULL NULL OF OFFSET ON OR ORDER OUTER " +
    "PLAN PRAGMA PRIMARY QUERY RAISE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE " +
    "RESTRICT RIGHT ROLLBACK ROW SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TO TRANSACTION " +
    "TRIGGER UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WITH WITHOUT"
  ).split(" "));
  const q = (n) => (MOTS_RESERVES.has(n.toUpperCase()) ? '"' + n + '"' : n);

  // Échappements : HTML (étiquettes Mermaid) et markdown (MLD texte).
  function echapEtiquette(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/#/g, "#35;").replace(/"/g, "#quot;");
  }
  function echapMd(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/([\\*_`])/g, "\\$1");
  }

  // Type SQL choisi quand l'attribut est en « type auto » : entier pour un
  // identifiant dont le nom commence par num, numéro, n°, no, id ou
  // identifiant (id client, num adhérent…), texte pour tout le reste
  // (code rayon, réf produit, isbn, matricule…). En SQLite, une clé primaire
  // INTEGER refuse le texte : un code comme 'R1' doit donc être en texte.
  function typeAuto(nom, ident) {
    if (!ident) return "TEXT";
    const n = String(nom || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    return /^(num|numero|n°|no|id|identifiant)(?![a-z0-9])/.test(n) ? "INTEGER" : "TEXT";
  }
  function typeEffectif(type, ident, nom) {
    const t = String(type || "").trim();
    return t ? t : typeAuto(nom, ident);
  }
  // Mot français affiché dans le schéma du MLD.
  function typeFr(type) {
    const t = String(type).toUpperCase();
    if (/INT/.test(t)) return "entier";
    if (/REAL|FLOA|DOUB|DEC|NUM/.test(t)) return "réel";
    if (/DATE|TIME/.test(t)) return "date";
    if (/BOOL/.test(t)) return "booléen";
    return "texte";
  }

  // ============================================================
  //   TEXTE MOCODO -> MODÈLE
  // ============================================================

  function lireAttribut(brut, index, pourEntite) {
    let s = String(brut).trim();
    let type = "";
    const m = s.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
    if (m) { s = m[1].trim(); type = m[2].trim(); }
    let bascule = false;
    if (s.startsWith("_")) { bascule = true; s = s.slice(1).trim(); }
    const attr = { nom: s, type };
    // Mocodo : le premier attribut est l'identifiant ; "_" inverse ce statut.
    if (pourEntite) attr.ident = (index === 0) !== bascule;
    return attr;
  }

  function lireMocodo(texte) {
    const modele = nouveauModele();
    const avertissements = [];
    const parNom = {};
    const associationsLues = [];

    String(texte || "").split(/\r?\n/).forEach((ligneBrute, num) => {
      const ligne = ligneBrute.trim();
      if (!ligne || ligne.startsWith("%")) return;
      if (/^:+$/.test(ligne)) return; // case vide de la grille Mocodo
      if (ligne.startsWith("/") || ligne.includes("<=") || ligne.startsWith("(")) {
        avertissements.push("Ligne " + (num + 1) + " ignorée (héritage ou contrainte, non gérés) : " + ligne);
        return;
      }
      const i = indexHorsCrochets(ligne, ":");
      const tete = i >= 0 ? ligne.slice(0, i) : ligne;
      const queue = i >= 0 ? ligne.slice(i + 1) : "";
      const parts = decouper(tete, ",").map((p) => p.trim());
      const attrsBruts = queue.trim() ? decouper(queue, ",") : [];

      if (parts.length === 1) {
        const nom = parts[0];
        if (!nom) return;
        if (parNom[nom]) { avertissements.push("L'entité " + nom + " est définie deux fois : la seconde définition est ignorée."); return; }
        const e = {
          id: nouvelId("e"), nom,
          attributs: attrsBruts.map((a, k) => lireAttribut(a, k, true)).filter((a) => a.nom)
        };
        parNom[nom] = e;
        modele.entites.push(e);
      } else {
        associationsLues.push({ nom: parts[0], pattes: parts.slice(1), attrsBruts, num });
      }
    });

    associationsLues.forEach((al) => {
      const as = {
        id: nouvelId("a"), nom: al.nom, pattes: [],
        attributs: al.attrsBruts.map((a, k) => lireAttribut(a, k, false)).filter((a) => a.nom)
      };
      al.pattes.forEach((brut) => {
        if (!brut) return;
        // Patte Mocodo : [_]carte[<>] [rôle] ENTITÉ, par exemple « 0N [parrain] ÉLÈVE ».
        const m = brut.trim().match(/^(_?)(?:([0-9X*][0-9NX*])(?=[\s\[<>]))?\s*[<>]?\s*(?:\[([^\]]*)\])?\s*(.*)$/i);
        const relatif = m[1] === "_";
        let card = (m[2] || "").toUpperCase();
        const role = m[3] ? m[3].trim() : "";
        const nomEnt = m[4].trim();
        if (card === "XX") card = "";
        if (card && !CARDS.includes(card)) {
          avertissements.push(as.nom + " : cardinalité « " + card + " » non gérée, à choisir à nouveau.");
          card = "";
        }
        if (relatif) avertissements.push(as.nom + " : identifiant relatif (entité faible) non géré, traité comme une patte ordinaire.");
        if (!nomEnt) return;
        let e = parNom[nomEnt];
        if (!e) {
          e = { id: nouvelId("e"), nom: nomEnt, attributs: [] };
          parNom[nomEnt] = e;
          modele.entites.push(e);
          avertissements.push("L'entité " + nomEnt + " est utilisée par " + as.nom + " sans être définie : elle a été créée sans attribut.");
        }
        as.pattes.push({ entite: e.id, card, role });
      });
      modele.associations.push(as);
    });

    return { modele, avertissements };
  }

  // Accepte un texte Mocodo OU un bloc Mermaid produit par Dariush MCD-MLD
  // (le texte Mocodo y est rangé dans les commentaires « %% mcd: »).
  function lireTexteColle(texte) {
    const t = String(texte || "");
    const lignes = t.split(/\r?\n/);
    const cachees = lignes.filter((l) => /^\s*%%\s*mcd:/.test(l)).map((l) => l.replace(/^\s*%%\s*mcd:\s?/, ""));
    let sens = null;
    let source;
    if (cachees.length) {
      source = cachees.join("\n");
      const m = t.match(/^\s*(?:graph|flowchart)\s+(LR|RL|TB|TD|BT)\b/m);
      if (m) sens = (m[1] === "LR" || m[1] === "RL") ? "LR" : "TB";
    } else {
      source = lignes.filter((l) => !/^\s*```/.test(l)).join("\n");
    }
    const res = lireMocodo(source);
    if (sens) res.modele.sens = sens;
    return res;
  }

  // ============================================================
  //   MODÈLE -> TEXTE MOCODO
  // ============================================================

  function ecrireAttributs(attributs, pourEntite) {
    const valides = attributs.filter((a) => nomMocodo(a.nom));
    return valides.map((a, k) => {
      let s = nomMocodo(a.nom);
      if (pourEntite && ((k === 0) !== !!a.ident)) s = "_" + s;
      if (a.type && String(a.type).trim()) s += " [" + String(a.type).trim().replace(/[\[\]]/g, "") + "]";
      return s;
    }).join(", ");
  }

  function ecrireMocodo(modele) {
    const parId = {};
    modele.entites.forEach((e) => { parId[e.id] = e; });
    const lignes = [];
    const faites = new Set();

    const ligneEntite = (e) => {
      if (faites.has(e.id)) return;
      faites.add(e.id);
      const nom = nomMocodo(e.nom);
      if (!nom) return;
      const attrs = ecrireAttributs(e.attributs, true);
      lignes.push(nom + ":" + (attrs ? " " + attrs : ""));
    };

    modele.associations.forEach((as) => {
      const nom = nomMocodo(as.nom);
      const pattes = as.pattes.filter((p) => parId[p.entite] && nomMocodo(parId[p.entite].nom));
      if (pattes.length) ligneEntite(parId[pattes[0].entite]);
      if (nom && pattes.length) {
        let l = nom + ", " + pattes.map((p) => {
          const card = CARDS.includes(p.card) ? p.card : "XX";
          const role = p.role && nomMocodo(p.role) ? " [" + nomMocodo(p.role) + "]" : "";
          return card + role + " " + nomMocodo(parId[p.entite].nom);
        }).join(", ");
        const attrs = ecrireAttributs(as.attributs, false);
        if (attrs) l += ": " + attrs;
        lignes.push(l);
      }
      pattes.slice(1).forEach((p) => ligneEntite(parId[p.entite]));
    });
    modele.entites.forEach(ligneEntite);
    return lignes.join("\n");
  }

  // ============================================================
  //   MCD -> MLD (règles de Merise)
  // ============================================================

  function nomLibre(table, base, suffixe) {
    const pris = (n) => table.colonnes.some((c) => c.nom === n);
    if (!pris(base)) return base;
    if (suffixe && !pris(base + " " + suffixe)) return base + " " + suffixe;
    let k = 2;
    while (pris(base + " " + k)) k++;
    return base + " " + k;
  }

  function calculerMLD(modele) {
    const avertissements = [];
    const tables = [];
    const parId = {};

    // 1. Chaque entité devient une relation ; son identifiant, la clé primaire.
    modele.entites.forEach((e) => {
      const nom = String(e.nom || "").trim();
      if (!nom) { avertissements.push("Une entité n'a pas de nom : elle est ignorée."); return; }
      const t = { nom, colonnes: [], etrangeres: [], liens: [] };
      e.attributs.forEach((a) => {
        const n = String(a.nom || "").trim();
        if (!n) return;
        if (t.colonnes.some((c) => c.nom === n)) { avertissements.push(nom + " : l'attribut « " + n + " » apparaît deux fois."); return; }
        t.colonnes.push({ nom: n, type: typeEffectif(a.type, a.ident, n), pk: !!a.ident, fk: false, nonNul: false });
      });
      if (!t.colonnes.some((c) => c.pk)) avertissements.push("L'entité " + nom + " n'a pas d'identifiant : coche « identifiant » sur un de ses attributs.");
      // Identifiant en tête, ordre conservé sinon.
      t.colonnes = t.colonnes.filter((c) => c.pk).concat(t.colonnes.filter((c) => !c.pk));
      tables.push(t);
      parId[e.id] = t;
    });

    // Ajoute dans t la clé étrangère vers ref et renvoie ses colonnes.
    // opt.unique : clé étrangère UNIQUE (les deux pattes ont un maximum de 1).
    const ajouterEtrangere = (t, ref, opt) => {
      const pks = ref.colonnes.filter((c) => c.pk && !c.fk);
      if (!pks.length) {
        avertissements.push(opt.asso + " : " + ref.nom + " n'a pas d'identifiant, la clé étrangère vers " + ref.nom + " n'a pas pu être créée.");
        return [];
      }
      const cols = pks.map((pk) => {
        const base = opt.role ? pk.nom + " " + opt.role : pk.nom;
        const col = {
          nom: nomLibre(t, base, opt.suffixe),
          type: pk.type, pk: !!opt.pk, fk: true, nonNul: !!opt.nonNul
        };
        t.colonnes.push(col);
        return col;
      });
      if (opt.unique && cols.length === 1) cols[0].unique = true;
      t.etrangeres.push({ cols, ref, refCols: pks, gauche: opt.gauche, droite: opt.droite, unique: !!opt.unique });
      return cols;
    };

    const droitePour = (card) => ({ "0N": "o{", "1N": "|{", "01": "o|", "11": "||" }[card] || "o{");

    // 2. Les associations.
    modele.associations.forEach((as) => {
      const nom = String(as.nom || "").trim() || "?";
      if (!String(as.nom || "").trim()) avertissements.push("Une association n'a pas de nom.");
      const pattes = as.pattes.filter((p) => parId[p.entite]);
      if (pattes.length < 2) {
        avertissements.push("L'association " + nom + " doit relier au moins deux entités (deux pattes).");
        return;
      }
      pattes.forEach((p) => {
        if (!CARDS.includes(p.card)) avertissements.push(nom + " : choisis la cardinalité de la patte vers " + parId[p.entite].nom + " (comptée 0,N en attendant).");
      });
      const card = (p) => (CARDS.includes(p.card) ? p.card : "0N");
      const reflexive = new Set(pattes.map((p) => p.entite)).size < pattes.length;
      if (reflexive && pattes.some((p) => !String(p.role || "").trim())) {
        avertissements.push(nom + " est réflexive : donne un rôle à chaque patte (ex. parrain / filleul) pour nommer clairement les clés étrangères.");
      }
      const roleDe = (p) => (reflexive ? String(p.role || "").trim() : "");
      const fonct = pattes.filter((p) => estFonctionnelle(card(p)));

      if (fonct.length) {
        // Association fonctionnelle (une patte en 0,1 ou 1,1) : pas de nouvelle
        // relation ; la clé étrangère va du côté de cette patte.
        const avec11 = pattes.filter((p) => card(p) === "11");
        const porteur = avec11[0] || fonct[0];
        const tP = parId[porteur.entite];
        const ambigu = avec11.length >= 2 || (avec11.length === 0 && fonct.length >= 2);
        if (pattes.length > 2) {
          avertissements.push(nom + " relie " + pattes.length + " entités avec une patte en " + cardTexte(card(porteur)) + " : les clés étrangères vont toutes dans " + tP.nom + ". Cas rare, à vérifier.");
        }
        const creees = [];
        pattes.filter((p) => p !== porteur).forEach((p) => {
          // Les deux pattes ont un maximum de 1 : une occurrence d'en face ne
          // peut être référencée qu'une fois, d'où UNIQUE sur la clé étrangère.
          creees.push(...ajouterEtrangere(tP, parId[p.entite], {
            asso: nom, role: roleDe(p), suffixe: nom.toLowerCase(), pk: false,
            nonNul: card(porteur) === "11",
            unique: estFonctionnelle(card(p)),
            gauche: card(porteur) === "11" ? "||" : "|o",
            droite: droitePour(card(p))
          }));
        });
        // Deux pattes au même maximum de 1 (0,1 - 0,1 ou 1,1 - 1,1) : la clé
        // pouvait aller d'un côté ou de l'autre. Une réflexive n'a pas ce
        // choix (c'est la même table des deux côtés).
        if (ambigu && !reflexive) {
          const cles = creees.map((c) => "#" + c.nom).join(", ") || "clé étrangère";
          if (pattes.length === 2) {
            const autre = pattes.find((p) => p !== porteur);
            const nomAutre = parId[autre.entite].nom;
            avertissements.push(nom + " relie " + tP.nom + " (" + cardTexte(card(porteur)) + ") et " + nomAutre + " (" + cardTexte(card(autre)) +
              ") : la clé étrangère peut aller d'un côté ou de l'autre. Elle est placée dans " + tP.nom + " (" + cles + "). Pour la mettre dans " +
              nomAutre + ", ouvre " + nom + " et clique sur ↑ de la patte " + nomAutre + ".");
          } else {
            avertissements.push(nom + " : plusieurs pattes en " + cardTexte(card(porteur)) + ", la clé étrangère est placée dans " + tP.nom + " (" + cles +
              "). Pour choisir une autre entité, ouvre " + nom + " et monte sa patte en premier avec ↑.");
          }
        }
        as.attributs.forEach((a) => {
          const n = String(a.nom || "").trim();
          if (n) tP.colonnes.push({ nom: nomLibre(tP, n, nom.toLowerCase()), type: typeEffectif(a.type, false), pk: false, fk: false, nonNul: false });
        });
      } else {
        // Association « maillée » (toutes les pattes en x,N) : nouvelle relation,
        // clé primaire = ensemble des clés étrangères.
        const t = { nom, colonnes: [], etrangeres: [], deAssociation: true };
        pattes.forEach((p) => {
          ajouterEtrangere(t, parId[p.entite], {
            asso: nom, role: roleDe(p), suffixe: parId[p.entite].nom.toLowerCase(), pk: true, nonNul: true,
            gauche: "||", droite: card(p).charAt(0) === "1" ? "|{" : "o{"
          });
        });
        as.attributs.forEach((a) => {
          const n = String(a.nom || "").trim();
          if (n) t.colonnes.push({ nom: nomLibre(t, n, ""), type: typeEffectif(a.type, false), pk: false, fk: false, nonNul: false });
        });
        tables.push(t);
      }
    });

    // 3. Noms SQL uniques (tables, puis colonnes de chaque table).
    const tablesPrises = new Set();
    tables.forEach((t) => {
      let n = nomSQL(t.nom), k = 2;
      const base = n;
      while (tablesPrises.has(n.toUpperCase())) n = base + "_" + (k++);
      if (n !== base) avertissements.push("Deux éléments du MCD portent le nom " + t.nom + " : la table est renommée " + n + " dans le SQL.");
      tablesPrises.add(n.toUpperCase());
      t.nomSQL = n;
      const colsPrises = new Set();
      t.colonnes.forEach((c) => {
        let cn = nomSQL(c.nom), j = 2;
        const cb = cn;
        while (colsPrises.has(cn.toLowerCase())) cn = cb + "_" + (j++);
        colsPrises.add(cn.toLowerCase());
        c.nomSQL = cn;
      });
    });

    return { tables, avertissements };
  }

  // ============================================================
  //   SORTIES
  // ============================================================

  const STYLE_ENTITE = "background:rgb(207,224,247);padding:2px 8px;font-weight:bold;border-bottom:1px solid gray";
  const STYLE_ASSO = "background:rgb(251,227,192);padding:2px 8px;font-weight:bold";
  const STYLE_CORPS = "padding:3px 8px;text-align:left";

  // Une ligne = un <div>, jamais de <br> : Mermaid écrit <br> sans barre
  // oblique, ce qui rend le SVG invalide en XML et fait échouer sa conversion
  // en image à l'export .ipynb (importer.js).
  const lignesEnDivs = (lignes) => lignes.map((l) => "<div>" + l + "</div>").join("");

  function etiquetteEntite(e) {
    const nom = echapEtiquette(String(e.nom || "").trim() || "?");
    const attrs = e.attributs.filter((a) => String(a.nom || "").trim());
    const lignes = attrs.filter((a) => a.ident).concat(attrs.filter((a) => !a.ident))
      .map((a) => (a.ident ? "<u>" + echapEtiquette(a.nom.trim()) + "</u>" : echapEtiquette(a.nom.trim())));
    return "<div style='min-width:110px'><div style='" + STYLE_ENTITE + "'>" + nom + "</div>" +
      (lignes.length ? "<div style='" + STYLE_CORPS + "'>" + lignesEnDivs(lignes) + "</div>" : "") + "</div>";
  }

  function etiquetteAssociation(as) {
    const nom = echapEtiquette(String(as.nom || "").trim() || "?");
    const attrs = as.attributs.filter((a) => String(a.nom || "").trim()).map((a) => echapEtiquette(a.nom.trim()));
    const style = STYLE_ASSO + (attrs.length ? ";border-bottom:1px solid gray" : "");
    return "<div style='min-width:90px'><div style='" + style + "'>" + nom + "</div>" +
      (attrs.length ? "<div style='" + STYLE_CORPS + "'>" + lignesEnDivs(attrs) + "</div>" : "") + "</div>";
  }

  // Code Mermaid du MCD (sans les ``` autour).
  function mermaidMCD(modele) {
    const parId = {};
    modele.entites.forEach((e) => { parId[e.id] = e; });
    const L = ["---", "config:", "  flowchart:", "    padding: 4", "---", "graph " + (modele.sens === "TB" ? "TB" : "LR")];
    const ids = [];
    modele.entites.forEach((e) => {
      L.push("  E_" + e.id + '["' + etiquetteEntite(e) + '"]');
      ids.push("E_" + e.id);
    });
    modele.associations.forEach((as) => {
      L.push("  A_" + as.id + '("' + etiquetteAssociation(as) + '")');
      ids.push("A_" + as.id);
    });
    modele.associations.forEach((as) => {
      const reflexive = new Set(as.pattes.map((p) => p.entite)).size < as.pattes.length;
      as.pattes.filter((p) => parId[p.entite]).forEach((p, k) => {
        let texte = cardTexte(p.card);
        if (reflexive && String(p.role || "").trim()) texte += " " + String(p.role).trim();
        const etiquette = '|"' + echapEtiquette(texte).replace(/\|/g, "#124;") + '"|';
        // Première patte : entité -> association, les suivantes : association -> entité.
        // Ce sens alterné donne un tracé en chaîne, comme dans Mocodo.
        if (k === 0) L.push("  E_" + p.entite + " ---" + etiquette + " A_" + as.id);
        else L.push("  A_" + as.id + " ---" + etiquette + " E_" + p.entite);
      });
    });
    if (ids.length) {
      L.push("  classDef mcd fill:#fff,stroke:#333,stroke-width:1.5px;");
      L.push("  class " + ids.join(",") + " mcd;");
    }
    ecrireMocodo(modele).split("\n").filter((l) => l.trim()).forEach((l) => L.push("  %% mcd: " + l));
    return L.join("\n");
  }

  // MLD en texte markdown (liste à puces).
  function mldTexte(mld) {
    return mld.tables.map((t) => {
      const cols = t.colonnes.map((c) => {
        const s = echapMd((c.fk ? "#" : "") + c.nom);
        return c.pk ? "<u>" + s + "</u>" : s;
      });
      return "- **" + echapMd(t.nom) + "** (" + cols.join(", ") + ")";
    }).join("\n");
  }

  // Schéma du MLD (Mermaid erDiagram), sans les ``` autour.
  function mermaidMLD(mld) {
    const L = ["erDiagram"];
    mld.tables.forEach((t) => {
      if (!t.colonnes.length) { L.push("  " + t.nomSQL + " {", "  }"); return; }
      L.push("  " + t.nomSQL + " {");
      t.colonnes.forEach((c) => {
        const cles = [c.pk ? "PK" : "", c.fk ? "FK" : "", c.unique ? "UK" : ""].filter(Boolean).join(", ");
        L.push("    " + typeFr(c.type) + " " + c.nomSQL + (cles ? " " + cles : ""));
      });
      L.push("  }");
    });
    mld.tables.forEach((t) => {
      t.etrangeres.forEach((f) => {
        L.push("  " + f.ref.nomSQL + " " + f.gauche + "--" + f.droite + " " + t.nomSQL + ' : ""');
      });
    });
    return L.join("\n");
  }

  // Script SQL (SQLite) : tables référencées d'abord.
  function sqlCreate(mld) {
    const restantes = mld.tables.slice();
    const ordre = [];
    while (restantes.length) {
      let i = restantes.findIndex((t) => t.etrangeres.every((f) => f.ref === t || ordre.includes(f.ref) || !restantes.includes(f.ref)));
      if (i < 0) i = 0; // cycle : on garde l'ordre d'origine
      ordre.push(restantes.splice(i, 1)[0]);
    }
    const L = ["-- SQLite : active le contrôle des clés étrangères", "PRAGMA foreign_keys = ON;", ""];
    ordre.forEach((t) => {
      if (!t.colonnes.length) {
        L.push("-- " + t.nomSQL + " : aucune colonne, table non créée", "");
        return;
      }
      const pks = t.colonnes.filter((c) => c.pk);
      const lignes = t.colonnes.map((c) =>
        "  " + q(c.nomSQL) + " " + c.type +
        (pks.length === 1 && c.pk ? " PRIMARY KEY" : "") +
        (c.nonNul && !c.pk ? " NOT NULL" : "") +
        (c.unique ? " UNIQUE" : ""));
      if (pks.length > 1) lignes.push("  PRIMARY KEY (" + pks.map((c) => q(c.nomSQL)).join(", ") + ")");
      // Clé étrangère UNIQUE sur plusieurs colonnes (identifiant composé en face).
      t.etrangeres.filter((f) => f.unique && f.cols.length > 1).forEach((f) => {
        lignes.push("  UNIQUE (" + f.cols.map((c) => q(c.nomSQL)).join(", ") + ")");
      });
      t.etrangeres.forEach((f) => {
        lignes.push("  FOREIGN KEY (" + f.cols.map((c) => q(c.nomSQL)).join(", ") + ") REFERENCES " +
          q(f.ref.nomSQL) + " (" + f.refCols.map((c) => q(c.nomSQL)).join(", ") + ")");
      });
      L.push("CREATE TABLE " + q(t.nomSQL) + " (");
      L.push(lignes.join(",\n"));
      L.push(");", "");
    });
    return L.join("\n").trim() + "\n";
  }

  window.MoteurMCD = {
    CARDS, cardTexte, nouveauModele, nouvelId, typeAuto,
    lireMocodo, lireTexteColle, ecrireMocodo,
    calculerMLD, mermaidMCD, mldTexte, mermaidMLD, sqlCreate
  };
})();
