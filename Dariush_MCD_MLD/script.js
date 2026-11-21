/*
  script.js — Dariush-MCD-MLD
  Interface de construction du MCD (liste, fiches entité / association),
  aperçu Mermaid et zones de code à copier. Les calculs sont dans moteur.js.
*/
(function () {
  "use strict";

  const M = window.MoteurMCD;
  let modele = M.nouveauModele();
  let selection = null;   // { type: "entite" | "asso", id }
  let onglet = "mcd";     // aperçu affiché : "mcd" ou "mld"

  const TYPES = [["", "type auto"], ["INTEGER", "entier"], ["TEXT", "texte"], ["REAL", "réel"], ["DATE", "date"]];

  // ---------- helpers DOM ----------
  const $ = (s) => document.querySelector(s);
  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach((c) => e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return e;
  }
  const entiteParId = (id) => modele.entites.find((e) => e.id === id);
  const assoParId = (id) => modele.associations.find((a) => a.id === id);
  const nomOu = (s, defaut) => (String(s || "").trim() || defaut);
  const estReflexive = (as) => {
    const ids = as.pattes.map((p) => p.entite).filter(Boolean);
    return new Set(ids).size < ids.length;
  };

  function selectType(attr) {
    const s = el("select", { title: "Type de la colonne dans le SQL (auto : entier pour un identifiant, texte sinon)" });
    const liste = TYPES.slice();
    if (attr.type && !liste.some(([v]) => v === attr.type)) liste.push([attr.type, attr.type]);
    liste.forEach(([v, t]) => {
      const o = el("option", { value: v, text: t });
      if ((attr.type || "") === v) o.selected = true;
      s.appendChild(o);
    });
    s.addEventListener("change", () => { attr.type = s.value; planifier(); });
    return s;
  }

  // ---------- actions ----------
  function ajouterEntite() {
    const e = { id: M.nouvelId("e"), nom: "", attributs: [{ nom: "", ident: true, type: "" }] };
    modele.entites.push(e);
    selection = { type: "entite", id: e.id };
    renderEditor(); planifier();
    const champ = $("#detailView input[type=text]");
    if (champ) champ.focus();
  }
  function ajouterAsso() {
    if (!modele.entites.length) { alert("Crée d'abord au moins une entité."); return; }
    const as = {
      id: M.nouvelId("a"), nom: "",
      pattes: [{ entite: "", card: "", role: "" }, { entite: "", card: "", role: "" }],
      attributs: []
    };
    modele.associations.push(as);
    selection = { type: "asso", id: as.id };
    renderEditor(); planifier();
    const champ = $("#detailView input[type=text]");
    if (champ) champ.focus();
  }
  function supprimerEntite(id) {
    modele.entites = modele.entites.filter((e) => e.id !== id);
    modele.associations.forEach((as) => { as.pattes = as.pattes.filter((p) => p.entite !== id); });
    if (selection && selection.id === id) selection = null;
    renderEditor(); planifier();
  }
  function supprimerAsso(id) {
    modele.associations = modele.associations.filter((a) => a.id !== id);
    if (selection && selection.id === id) selection = null;
    renderEditor(); planifier();
  }
  function ouvrir(type, id) { selection = { type, id }; renderEditor(); }
  function fermer() { selection = null; renderEditor(); }

  // ---------- rendu de l'éditeur ----------
  function renderEditor() {
    if (selection && selection.type === "entite" && entiteParId(selection.id)) renderEntite(entiteParId(selection.id));
    else if (selection && selection.type === "asso" && assoParId(selection.id)) renderAsso(assoParId(selection.id));
    else { selection = null; renderList(); }
  }

  function renderList() {
    $("#detailView").style.display = "none";
    $("#listView").style.display = "";

    const le = $("#entitesList");
    le.innerHTML = "";
    if (!modele.entites.length) le.appendChild(el("p", { class: "empty-list", text: "Aucune entité." }));
    modele.entites.forEach((e) => {
      const idents = e.attributs.filter((a) => a.ident && a.nom.trim()).map((a) => a.nom.trim()).join(", ");
      const open = el("button", { class: "item-open", title: "Modifier cette entité", onclick: () => ouvrir("entite", e.id) }, [
        el("span", { class: "glyph entite" }),
        e.nom.trim() ? el("span", { class: "name", text: e.nom.trim() }) : el("span", { class: "name empty", text: "nom ?" }),
        el("span", { class: "resume", text: idents ? "identifiant : " + idents : "pas d'identifiant" })
      ]);
      const del = el("button", { class: "danger", text: "Supprimer", onclick: () => supprimerEntite(e.id) });
      le.appendChild(el("div", { class: "item-row" }, [open, del]));
    });

    const la = $("#assosList");
    la.innerHTML = "";
    if (!modele.associations.length) la.appendChild(el("p", { class: "empty-list", text: "Aucune association." }));
    modele.associations.forEach((as) => {
      const resume = as.pattes.map((p) => {
        const e = entiteParId(p.entite);
        return (e ? nomOu(e.nom, "?") : "?") + " " + M.cardTexte(p.card);
      }).join(" – ");
      const open = el("button", { class: "item-open", title: "Modifier cette association", onclick: () => ouvrir("asso", as.id) }, [
        el("span", { class: "glyph asso" }),
        as.nom.trim() ? el("span", { class: "name", text: as.nom.trim() }) : el("span", { class: "name empty", text: "nom ?" }),
        el("span", { class: "resume", text: resume })
      ]);
      const del = el("button", { class: "danger", text: "Supprimer", onclick: () => supprimerAsso(as.id) });
      la.appendChild(el("div", { class: "item-row" }, [open, del]));
    });

    $("#emptyHint").style.display = modele.entites.length ? "none" : "";
  }

  function enteteDetail(v, type, objet, placeholder) {
    v.appendChild(el("button", { class: "back", text: "← Retour à la liste", onclick: fermer }));
    v.appendChild(el("span", { class: "kind " + type, text: type === "entite" ? "Entité" : "Association" }));
    const nom = el("input", { type: "text", placeholder });
    nom.value = objet.nom;
    nom.addEventListener("input", () => { objet.nom = nom.value; planifier(); });
    v.appendChild(el("label", { class: "field" }, ["Nom", nom]));
  }

  function renderEntite(e) {
    $("#listView").style.display = "none";
    const v = $("#detailView");
    v.style.display = ""; v.className = "detail"; v.innerHTML = "";
    enteteDetail(v, "entite", e, "Nom de l'entité (ex. CLIENT)");

    const fs = el("fieldset");
    fs.appendChild(el("legend", { text: "Attributs" }));
    fs.appendChild(el("p", { class: "aide", text: "Coche « identifiant » pour l'attribut (ou les attributs) qui distingue chaque occurrence : il est souligné et devient la clé primaire. Entrée ajoute un attribut." }));
    if (!e.attributs.length) fs.appendChild(el("p", { class: "row-empty", text: "Aucun attribut." }));
    e.attributs.forEach((a, i) => {
      const nom = el("input", { type: "text", placeholder: "attribut" });
      nom.value = a.nom;
      nom.addEventListener("input", () => { a.nom = nom.value; planifier(); });
      nom.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        e.attributs.splice(i + 1, 0, { nom: "", ident: false, type: "" });
        renderEntite(e); planifier();
        const champs = v.querySelectorAll("fieldset input[type=text]");
        if (champs[i + 1]) champs[i + 1].focus();
      });
      const coche = el("input", { type: "checkbox" });
      coche.checked = !!a.ident;
      const lab = el("label", { class: "ident" + (a.ident ? " on" : ""), title: "Fait partie de l'identifiant (clé primaire)" }, [coche, "identifiant"]);
      coche.addEventListener("change", () => {
        a.ident = coche.checked;
        lab.classList.toggle("on", coche.checked);
        planifier();
      });
      const del = el("button", { class: "danger del", text: "✕", title: "Supprimer cet attribut", onclick: () => {
        e.attributs.splice(i, 1); renderEntite(e); planifier();
      } });
      fs.appendChild(el("div", { class: "row" }, [nom, lab, selectType(a), del]));
    });
    fs.appendChild(el("button", { class: "ghost", text: "+ Ajouter un attribut", onclick: () => {
      e.attributs.push({ nom: "", ident: !e.attributs.some((x) => x.ident), type: "" });
      renderEntite(e); planifier();
      const champs = v.querySelectorAll("fieldset input[type=text]");
      if (champs.length) champs[champs.length - 1].focus();
    } }));
    v.appendChild(fs);

    v.appendChild(el("div", { class: "item-action" }, [
      el("button", { class: "danger", text: "Supprimer cette entité", onclick: () => supprimerEntite(e.id) })
    ]));
  }

  function renderAsso(as) {
    $("#listView").style.display = "none";
    const v = $("#detailView");
    v.style.display = ""; v.className = "detail"; v.innerHTML = "";
    enteteDetail(v, "asso", as, "Nom de l'association (ex. PASSER)");

    // -- pattes --
    const reflexive = estReflexive(as);
    const fs = el("fieldset");
    fs.appendChild(el("legend", { text: "Pattes (entités reliées)" }));
    fs.appendChild(el("p", { class: "aide", text: "La cardinalité se lit côté entité : pour UNE occurrence de l'entité, combien de fois au minimum et au maximum elle participe à l'association." }));
    as.pattes.forEach((p, i) => {
      const sel = el("select", { title: "Entité reliée par cette patte" });
      if (!entiteParId(p.entite)) sel.appendChild(el("option", { value: "", text: "— choisir l'entité —" }));
      modele.entites.forEach((e) => {
        const o = el("option", { value: e.id, text: nomOu(e.nom, "(sans nom)") });
        if (p.entite === e.id) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => { p.entite = sel.value; renderAsso(as); planifier(); });

      const cartes = el("div", { class: "cards" });
      M.CARDS.forEach((c) => {
        const b = el("button", { type: "button", class: p.card === c ? "on" : "", text: M.cardTexte(c), title: "Cardinalité " + M.cardTexte(c) });
        b.addEventListener("click", () => {
          p.card = c;
          cartes.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          planifier();
        });
        cartes.appendChild(b);
      });

      const boutons = [];
      if (i > 0) boutons.push(el("button", { class: "ghost del", text: "↑", title: "Monter cette patte (l'ordre décide du côté de la clé étrangère dans les cas ambigus)", onclick: () => {
        as.pattes.splice(i - 1, 0, as.pattes.splice(i, 1)[0]); renderAsso(as); planifier();
      } }));
      boutons.push(el("button", { class: "danger del", text: "✕", title: "Supprimer cette patte", onclick: () => {
        as.pattes.splice(i, 1); renderAsso(as); planifier();
      } }));

      const bloc = el("div", { class: "patte" }, [el("div", { class: "row" }, [sel, cartes].concat(boutons))]);
      if (reflexive && p.entite) {
        const role = el("input", { type: "text", placeholder: "ex. parrain" });
        role.value = p.role || "";
        role.addEventListener("input", () => { p.role = role.value; planifier(); });
        bloc.appendChild(el("div", { class: "row" }, [el("label", { class: "role" }, ["rôle", role])]));
      }
      fs.appendChild(bloc);
    });
    fs.appendChild(el("button", { class: "ghost", text: "+ Ajouter une patte", onclick: () => {
      as.pattes.push({ entite: "", card: "", role: "" }); renderAsso(as); planifier();
    } }));
    v.appendChild(fs);

    // -- attributs portés par l'association --
    const fa = el("fieldset");
    fa.appendChild(el("legend", { text: "Attributs de l'association (facultatif)" }));
    if (!as.attributs.length) fa.appendChild(el("p", { class: "row-empty", text: "Aucun attribut." }));
    as.attributs.forEach((a, i) => {
      const nom = el("input", { type: "text", placeholder: "attribut (ex. quantité)" });
      nom.value = a.nom;
      nom.addEventListener("input", () => { a.nom = nom.value; planifier(); });
      const del = el("button", { class: "danger del", text: "✕", title: "Supprimer cet attribut", onclick: () => {
        as.attributs.splice(i, 1); renderAsso(as); planifier();
      } });
      fa.appendChild(el("div", { class: "row" }, [nom, selectType(a), del]));
    });
    fa.appendChild(el("button", { class: "ghost", text: "+ Ajouter un attribut", onclick: () => {
      as.attributs.push({ nom: "", type: "" }); renderAsso(as); planifier();
      const champs = fa.querySelectorAll("input[type=text]");
      if (champs.length) champs[champs.length - 1].focus();
    } }));
    v.appendChild(fa);

    v.appendChild(el("div", { class: "item-action" }, [
      el("button", { class: "danger", text: "Supprimer cette association", onclick: () => supprimerAsso(as.id) })
    ]));
  }

  // ---------- aperçu + sorties ----------
  let mermaidPret = false;
  function ensureMermaid() {
    if (mermaidPret) return true;
    if (typeof window.mermaid === "undefined") return false;
    // Mêmes réglages que le markdown de Dariush : l'aperçu montre ce que l'élève obtiendra.
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    mermaidPret = true;
    return true;
  }

  let minuterie = null;
  function planifier() {
    clearTimeout(minuterie);
    minuterie = setTimeout(majSorties, 250);
  }

  let derniers = { mcd: "", mldTexte: "" };
  let numeroRendu = 0;

  function majSorties() {
    const vide = !modele.entites.length && !modele.associations.length;
    const mld = M.calculerMLD(modele);
    const codeMcd = M.mermaidMCD(modele);
    const codeMld = M.mermaidMLD(mld);
    const texteMld = M.mldTexte(mld);
    derniers = { mcd: vide ? "" : codeMcd, mldTexte: texteMld };

    $("#codeMcd").value = vide ? "" : "```mermaid\n" + codeMcd + "\n```";
    $("#codeMld").value = texteMld;
    $("#codeMldSchema").value = mld.tables.length ? "```mermaid\n" + codeMld + "\n```" : "";
    $("#codeSql").value = mld.tables.length ? M.sqlCreate(mld) : "";
    $("#codeMocodo").value = M.ecrireMocodo(modele);

    const ul = $("#warnings");
    ul.innerHTML = "";
    const avert = Array.from(new Set(mld.avertissements));
    avert.forEach((a) => ul.appendChild(el("li", { text: a })));
    ul.hidden = !avert.length;

    const prev = $("#preview");
    if (!modele.entites.length) {
      prev.innerHTML = '<div class="preview-msg">Ajoute une entité pour voir le MCD.</div>';
      return;
    }
    if (onglet === "mld" && !mld.tables.length) {
      prev.innerHTML = '<div class="preview-msg">Donne un nom à une entité pour voir le schéma du MLD.</div>';
      return;
    }
    if (!ensureMermaid()) {
      prev.innerHTML = '<div class="preview-msg">Chargement de Mermaid…</div>';
      setTimeout(majSorties, 400);
      return;
    }
    const code = onglet === "mcd" ? codeMcd : codeMld;
    const num = ++numeroRendu;
    const id = "mmd-" + Date.now() + "-" + num;
    let p;
    try { p = window.mermaid.render(id, code); }
    catch (err) { afficherErreur(prev, id); return; }
    Promise.resolve(p)
      .then((res) => {
        if (num !== numeroRendu) return; // un rendu plus récent est en cours
        if (res && res.svg) { prev.innerHTML = res.svg; appliquerTaille(); }
        else afficherErreur(prev, id);
      })
      .catch(() => { if (num === numeroRendu) afficherErreur(prev, id); });
  }
  // « Taille réelle » : Mermaid met width="100%" sur le SVG, on impose donc
  // la largeur naturelle du dessin (celle de son viewBox) et on fait défiler.
  let tailleReelle = false;
  function appliquerTaille() {
    $("#preview").classList.toggle("reel", tailleReelle);
    const svg = $("#preview svg");
    if (!svg) return;
    if (svg.dataset.styleOrigine === undefined) svg.dataset.styleOrigine = svg.getAttribute("style") || "";
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (tailleReelle && vb && vb.width) {
      svg.setAttribute("style", svg.dataset.styleOrigine + ";max-width:none;width:" + Math.ceil(vb.width) + "px");
    } else {
      svg.setAttribute("style", svg.dataset.styleOrigine);
    }
  }

  function afficherErreur(prev, id) {
    const o1 = document.getElementById(id); if (o1) o1.remove();
    const o2 = document.getElementById("d" + id); if (o2) o2.remove();
    prev.innerHTML = '<div class="preview-msg err">Dessin impossible pour l\'instant : vérifie les noms et les pattes.</div>';
  }

  function choisirOnglet(o) {
    onglet = o;
    $("#tabMCD").classList.toggle("on", o === "mcd");
    $("#tabMLD").classList.toggle("on", o === "mld");
    majSorties();
  }

  // ---------- copie ----------
  async function copierTexte(texte) {
    try { await navigator.clipboard.writeText(texte); return; }
    catch (_) { /* repli ci-dessous */ }
    const ta = el("textarea");
    ta.value = texte;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) { /* rien de plus à tenter */ }
    ta.remove();
  }
  function signaler(id) {
    const c = $(id);
    c.hidden = false;
    setTimeout(() => { c.hidden = true; }, 1600);
  }
  function brancherCopie(btn, zone, ok) {
    $(btn).addEventListener("click", async () => { await copierTexte($(zone).value); signaler(ok); });
  }
  brancherCopie("#copyMcdBtn", "#codeMcd", "#copiedMcd");
  brancherCopie("#copyMldBtn", "#codeMld", "#copiedMld");
  brancherCopie("#copyMldSchemaBtn", "#codeMldSchema", "#copiedMldSchema");
  brancherCopie("#copySqlBtn", "#codeSql", "#copiedSql");
  brancherCopie("#copyMocodoBtn", "#codeMocodo", "#copiedMocodo");

  $("#copyAllBtn").addEventListener("click", async () => {
    majSorties();
    if (!derniers.mcd) return;
    const texte = "**MCD**\n\n```mermaid\n" + derniers.mcd + "\n```\n\n**Schéma relationnel (MLD)**\n\n" + derniers.mldTexte + "\n";
    await copierTexte(texte);
    signaler("#copiedAll");
  });

  // ---------- import / remise à zéro ----------
  function messageImport(texte, classe, details) {
    const m = $("#importMsg");
    m.className = "import-msg " + (classe || "");
    m.innerHTML = "";
    m.appendChild(el("div", { text: texte }));
    if (details && details.length) {
      const ul = el("ul");
      details.forEach((d) => ul.appendChild(el("li", { text: d })));
      m.appendChild(ul);
    }
  }

  $("#importBtn").addEventListener("click", () => {
    const texte = $("#importText").value;
    if (!texte.trim()) { messageImport("Rien à importer : colle d'abord un code dans la zone.", "err"); return; }
    const res = M.lireTexteColle(texte);
    const nE = res.modele.entites.length, nA = res.modele.associations.length;
    if (!nE && !nA) { messageImport("Aucune entité ni association reconnue dans ce texte.", "err"); return; }
    if ((modele.entites.length || modele.associations.length) &&
        !confirm("Remplacer le MCD actuel par celui importé ?")) return;
    if (!/%%\s*mcd:/.test(texte)) res.modele.sens = modele.sens;
    modele = res.modele;
    $("#sens").value = modele.sens;
    selection = null;
    renderEditor(); planifier();
    messageImport("MCD chargé : " + nE + " entité" + (nE > 1 ? "s" : "") + ", " + nA + " association" + (nA > 1 ? "s" : "") + ".", "ok", res.avertissements);
  });

  $("#resetBtn").addEventListener("click", () => {
    if (!modele.entites.length && !modele.associations.length) return;
    if (!confirm("Effacer tout le MCD ?")) return;
    const sens = modele.sens;
    modele = M.nouveauModele();
    modele.sens = sens;
    selection = null;
    renderEditor(); planifier();
    messageImport("");
  });

  // ---------- branchements ----------
  $("#addEntite").addEventListener("click", ajouterEntite);
  $("#addAsso").addEventListener("click", ajouterAsso);
  $("#sens").addEventListener("change", () => { modele.sens = $("#sens").value; planifier(); });
  $("#tabMCD").addEventListener("click", () => choisirOnglet("mcd"));
  $("#tabMLD").addEventListener("click", () => choisirOnglet("mld"));
  $("#zoomBtn").addEventListener("click", () => {
    tailleReelle = !tailleReelle;
    $("#zoomBtn").textContent = tailleReelle ? "Ajuster" : "Taille réelle";
    appliquerTaille();
  });

  renderEditor();
  majSorties();
})();
