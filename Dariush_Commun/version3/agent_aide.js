/* =========================================================
   agent_aide.js — Agent "Aide IA"
   Requête 1 : page active. Si le serveur signale un contexte
   insuffisant, requête 2 avec les 3 pages précédentes.
   ========================================================= */
(function () {
  const API_URL = "https://physalgo.fr/Dariush_Commun/api/ia.php";
  const NB_PAGES_PRECEDENTES = 3;

  function ouvrirPanneauIA() {
    const panel = document.getElementById("iaPanel");
    if (panel) panel.classList.add("ia-open");
  }

  function getSource() {
    return (typeof getDariushSource === "function") ? getDariushSource() : "python";
  }

  function collecterContexte() {
    let markdownPage = "", codeEleve = "";
    try {
      const PM = window.PagesMultiples;
      if (PM && typeof PM.getAllPages === "function") {
        const pages = PM.getAllPages();
        const idx = (typeof PM.getActivePageIndex === "function") ? PM.getActivePageIndex() : 0;
        const page = pages[idx] || pages[0] || {};
        const blocs = (Array.isArray(page.markdowns) && page.markdowns.length)
          ? page.markdowns : [String(page.comment || "")];
        markdownPage = blocs.join("\n\n");
        codeEleve = String(page.code || "");
      }
    } catch (e) { console.warn("[aide] contexte :", e); }
    return { markdownPage, codeEleve };
  }

  function collecterPagesPrecedentes(n) {
    let txt = "";
    try {
      const PM = window.PagesMultiples;
      if (PM && typeof PM.getAllPages === "function") {
        const pages = PM.getAllPages();
        const idx = (typeof PM.getActivePageIndex === "function") ? PM.getActivePageIndex() : 0;
        const debut = Math.max(0, idx - n);
        const morceaux = [];
        for (let i = debut; i < idx; i++) {
          const page = pages[i] || {};
          const blocs = (Array.isArray(page.markdowns) && page.markdowns.length)
            ? page.markdowns : [String(page.comment || "")];
          let bloc = "--- Page " + (i + 1) + " ---\n" + blocs.join("\n\n");
          if (page.code && String(page.code).trim() !== "") {
            bloc += "\n[CODE DE LA PAGE]\n" + String(page.code);
          }
          morceaux.push(bloc);
        }
        txt = morceaux.join("\n\n");
      }
    } catch (e) { console.warn("[aide] pages précédentes :", e); }
    return txt;
  }

  async function envoyer(payload) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const raw = await res.text();
    try { return JSON.parse(raw); }
    catch (e) { throw new Error("Réponse serveur invalide"); }
  }

  async function demarrer(code, btn) {
    ouvrirPanneauIA();

    const IA = window.IAHelper;
    if (IA && typeof IA.ajouterHistorique === "function") {
      IA.ajouterHistorique("Q : Aide sur la question « " + code + " »");
      if (typeof IA.setStatus === "function") IA.setStatus("Recherche d'une aide...", "info");
    }

    const ctx = collecterContexte();
    const basePayload = {
      action: "agent_aide",
      marqueur: code,
      markdown_page: ctx.markdownPage,
      code_eleve: (getSource() === "linux") ? "" : ctx.codeEleve,
      exercice_lien_court: (window.__exerciceCourant && window.__exerciceCourant.lien_court) || "",
      source: getSource(),
      provider: (IA && IA.state && IA.state.provider) || "",
      apiKey:   (IA && IA.state && IA.state.apiKey)   || ""
    };

    try {
      let data = await envoyer(basePayload);

      // Élargissement à la demande
      if (data && data.contexte_insuffisant) {
        if (IA && typeof IA.setStatus === "function") {
          IA.setStatus("Recherche d'un contexte plus large...", "info");
        }
        data = await envoyer(Object.assign({}, basePayload, {
          elargi: true,
          pages_precedentes: collecterPagesPrecedentes(NB_PAGES_PRECEDENTES)
        }));
      }

      if (data && data.error === "limite_atteinte") {
        if (IA) {
          IA.ajouterHistorique("R : Le service gratuit est momentanément saturé (limite atteinte). Réessaie dans quelques minutes.");
          IA.setStatus("Service indisponible.", "error");
        }
        return;
      }
      if (data && data.error) throw new Error(data.error);

      if (IA) {
        IA.ajouterHistorique("R : " + ((data && data.result) || ""));
        IA.setStatus("", "info");
      }
    } catch (err) {
      if (IA) {
        IA.ajouterHistorique("R : Erreur — " + err.message);
        IA.setStatus(err.message, "error");
      }
    }
  }

  window.AgentAide = { demarrer };
})();