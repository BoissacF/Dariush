/* =========================================================
   terminal.js — Dariush Linux
   - Initialise xterm.js dans #terminalContainer
   - Connexion WebSocket via window._dariushSocket
   - Envoie linux_connect avec codeClasse + pseudo
   - Reçoit linux_output et affiche dans le terminal
   - Envoie linux_input à chaque frappe
   - Gère le redimensionnement automatique
   ========================================================= */

/* ================================
   ATTENTE DU DOM + SCRIPTS
================================ */
document.addEventListener("DOMContentLoaded", () => {

  /* --------------------------------
     VÉRIFICATION xterm.js
  -------------------------------- */
  if (typeof Terminal === "undefined" || typeof FitAddon === "undefined") {
    console.error("[terminal.js] xterm.js ou FitAddon non chargé.");
    return;
  }

  /* ================================
     CRÉATION DU TERMINAL
  ================================ */
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor:     "#ffffff",
      black:      "#000000",
      red:        "#cd3131",
      green:      "#0dbc79",
      yellow:     "#e5e510",
      blue:       "#2472c8",
      magenta:    "#bc3fbc",
      cyan:       "#11a8cd",
      white:      "#e5e5e5",
    },
    scrollback: 1000,
    convertEol: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.getElementById("terminalContainer");
  if (!container) {
    console.error("[terminal.js] #terminalContainer introuvable.");
    return;
  }

  

  term.open(container);


// Ajouter une marge visuelle de 80px sous le terminal
  // (= environ 4 lignes vides, pour que la ligne active ne soit pas collée au bas de l'écran)
  container.style.marginBottom = "80px";



  
  // Laisser passer tous les raccourcis clavier au terminal
term.attachCustomKeyEventHandler((e) => {
  return true;
});

  fitAddon.fit();

  /* ================================
     THÈMES DISPONIBLES
  ================================ */
  const themes = [
    {
      name: "Sombre",
      background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#ffffff"
    },
    {
      name: "Clair",
      background: "#ffffff", foreground: "#1e1e1e", cursor: "#000000"
    },
    {
      name: "Monokai",
      background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0"
    },
    {
      name: "Solarisé",
      background: "#002b36", foreground: "#839496", cursor: "#93a1a1"
    },
  ];
 

 // Restaurer le thème sauvegardé
  const TERMINAL_THEME_STORAGE_KEY = "dariush_linux_terminal_theme_v1";
  let themeIndex = 2;
  try {
    const saved = parseInt(localStorage.getItem(TERMINAL_THEME_STORAGE_KEY), 10);
    if (!isNaN(saved) && saved >= 0 && saved < themes.length) {
      themeIndex = saved;
    }
  } catch (err) {
    console.warn("Impossible de lire le thème terminal sauvegardé :", err);
  }

  // Appliquer le thème initial (au démarrage)
 // Appliquer le thème initial (au démarrage)
  function applyTerminalTheme(idx) {
    const t = themes[idx];
    term.options.theme = { background: t.background, foreground: t.foreground, cursor: t.cursor };
    container.style.background = t.background;
    // Mode sombre global : actif uniquement pour le thème "Sombre"
    document.body.classList.toggle("dariush-dark", t.name === "Sombre");
  }
 
  applyTerminalTheme(themeIndex);

  const themeBtn = document.getElementById("themeButton");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      themeIndex = (themeIndex + 1) % themes.length;
      applyTerminalTheme(themeIndex);
      // Sauvegarder le choix
      try {
        localStorage.setItem(TERMINAL_THEME_STORAGE_KEY, String(themeIndex));
      } catch (err) {
        console.warn("Impossible de sauvegarder le thème terminal :", err);
      }
    });
  }

 
  /* ================================
     ZOOM
  ================================ */
  const zoomRange = document.getElementById("zoomRange");
  if (zoomRange) {
    zoomRange.addEventListener("input", () => {
      term.options.fontSize = parseInt(zoomRange.value);
      fitAddon.fit();
      sendResize();
    });
  }

  /* ================================
     REDIMENSIONNEMENT AUTOMATIQUE
  ================================ */
  function sendResize() {
    const socket = window._dariushSocket;
    if (socket && socket.connected && window._linuxConnected) {
      socket.emit("linux_resize", { cols: term.cols, rows: term.rows });
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    sendResize();
  });
  resizeObserver.observe(container);

  window.addEventListener("resize", () => {
    fitAddon.fit();
    sendResize();
  });

  /* ================================
     ÉTAT DE CONNEXION
  ================================ */
  window._linuxConnected = false;

  /* ================================
     MESSAGE D'ACCUEIL
  ================================ */
  term.writeln("\x1b[1;32mDariush Linux — Terminal en ligne\x1b[0m");
  term.writeln("\x1b[90mConnectez-vous via le formulaire ci-dessus pour démarrer.\x1b[0m");
  term.writeln("");

  /* ================================
     FORMULAIRE DE CONNEXION
     Affiché sous le terminal
  ================================ */
  const formHtml = `
    <div id="linuxLoginForm" style="
      margin-top: 12px;
      padding: 12px;
      background: var(--surface, #f5f5f5);
      border-radius: 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    ">
      <input type="text" id="linuxCodeClasse"
        placeholder="Code classe (ex: 1234)"
        style="flex:1; min-width:120px; padding:6px 10px; border-radius:4px; border:1px solid #90caf9; background:#e3f2fd;"
        autocomplete="off" />
      <input type="text" id="linuxPseudo"
        placeholder="Ton prénom (ex: toto)"
        style="flex:1; min-width:120px; padding:6px 10px; border-radius:4px; border:1px solid #90caf9; background:#e3f2fd;"
        autocomplete="off" />
      <input type="password" id="linuxMotDePasse"
        placeholder="Mot de passe (4 car. min)"
        style="flex:1; min-width:140px; padding:6px 10px; border-radius:4px; border:1px solid #90caf9; background:#e3f2fd;"
        autocomplete="off" />
      <button id="linuxConnectBtn" type="button"
        style="padding:6px 16px; border-radius:4px; cursor:pointer;">
        Se connecter
      </button>
      <button id="linuxDisconnectBtn" type="button"
        style="padding:6px 16px; border-radius:4px; cursor:pointer; display:none;">
        Se déconnecter
      </button>
      <span id="linuxStatus" style="font-size:0.85em; color:#666;"></span>
      <div style="flex-basis:100%; font-size:0.8em; color:#888; margin-top:4px;">
        💡 Au premier login, choisis ton mot de passe (à mémoriser !). Aux connexions suivantes, retape le même.
      </div>
    </div>
  `;

  // Insérer le formulaire AVANT la zone Linux (qui contient le markdown et le terminal)
  // pour qu'il soit en haut de la page, bien visible
  // Insérer le formulaire JUSTE AVANT le terminal (entre le markdown et le terminal)
  if (container && container.parentNode) {
    container.parentNode.insertBefore(
      new DOMParser().parseFromString(formHtml, "text/html").body.firstElementChild,
      container
    );
  } else {
    // Fallback
    container.insertAdjacentHTML("afterend", formHtml);
  }
  /*
  const zoneLinux = document.getElementById("zoneLinux");
  if (zoneLinux && zoneLinux.parentNode) {
    zoneLinux.parentNode.insertBefore(
      new DOMParser().parseFromString(formHtml, "text/html").body.firstElementChild,
      zoneLinux
    );
  } else {
    // Fallback : ancienne position si #zoneLinux est absent
    container.insertAdjacentHTML("afterend", formHtml);
  }
  */
  const inputCodeClasse    = document.getElementById("linuxCodeClasse");
  const inputPseudo        = document.getElementById("linuxPseudo");
  const btnConnect         = document.getElementById("linuxConnectBtn");
  const btnDisconnect      = document.getElementById("linuxDisconnectBtn");
  const statusEl           = document.getElementById("linuxStatus");
  const inputMotDePasse    = document.getElementById("linuxMotDePasse");
  const loginForm = document.getElementById("linuxLoginForm");

  function setStatus(msg, color = "#666") {
    statusEl.textContent = msg;
    statusEl.style.color = color;
  }
 /* ================================
     BOUTON EFFACER
  ================================ */
  const clearBtn = document.getElementById("clearButtonCode");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      // Si on est connecté : déconnecte d'abord (ferme le conteneur Docker)
      if (window._linuxConnected && btnDisconnect && btnDisconnect.style.display !== "none") {
        btnDisconnect.click();
      }

      // Vide le terminal xterm
      term.clear();

      // Réinitialise les champs
      const loginForm2 = document.getElementById("linuxLoginForm");
      if (inputCodeClasse) {
        inputCodeClasse.value = "";
        inputCodeClasse.disabled = false;
      }
      if (inputPseudo) {
        inputPseudo.value = "";
        inputPseudo.disabled = false;
        inputMotDePasse.disabled    = false;
      }

      if (inputMotDePasse) {
        inputMotDePasse.value = "";
        inputMotDePasse.disabled = false;
      }

      // Réaffiche le formulaire et restaure les boutons
      if (loginForm2) loginForm2.style.display = "flex";
      if (btnConnect) {
        btnConnect.style.display = "inline-block";
        btnConnect.disabled = false;
      }
      if (btnDisconnect) {
        btnDisconnect.style.display = "none";
      }
      if (statusEl) {
        statusEl.textContent = "";
      }

      // Focus sur le premier champ pour faciliter la saisie
      if (inputCodeClasse) inputCodeClasse.focus();
    });
  }

  /* ================================
     CONNEXION AU TERMINAL
  ================================ */
  function connecterTerminal() {
    const socket = window._dariushSocket;
    if (!socket) {
      setStatus("WebSocket non disponible.", "red");
      return;
    }

    const codeClasse  = inputCodeClasse.value.trim();
    const pseudo      = inputPseudo.value.trim();
    const motDePasse  = inputMotDePasse.value;

    if (motDePasse.length < 4) {
      alert("Le mot de passe doit contenir au moins 4 caractères.");
      return;
    }
    if (!codeClasse || !pseudo) {
      setStatus("Remplis le code classe et ton prénom.", "orange");
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(codeClasse) || !/^[a-zA-Z0-9_-]+$/.test(pseudo)) {
      setStatus("Caractères invalides — lettres, chiffres, - et _ uniquement.", "red");
      return;
    }

    setStatus("Connexion en cours…", "#888");
    btnConnect.disabled = true;

    socket.emit("linux_connect", { codeClasse, pseudo, motDePasse });
  }

  btnConnect.addEventListener("click", connecterTerminal);

  inputPseudo.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connecterTerminal();
  });

  /* ================================
     DÉCONNEXION
  ================================ */
  function deconnecterTerminal() {
    const socket = window._dariushSocket;
    window._linuxConnected = false;

    term.writeln("\r\n\x1b[33mDéconnexion…\x1b[0m");

    // Envoyer exit au bash
    if (socket && socket.connected) {
      socket.emit("linux_input", "exit\n");
    }

    btnConnect.style.display    = "inline-block";
    btnDisconnect.style.display = "none";
    btnConnect.disabled         = false;
    inputCodeClasse.disabled    = false;
    inputPseudo.disabled        = false;
    inputMotDePasse.disabled    = false;
    
    setStatus("Déconnecté.", "#888");
  }

  btnDisconnect.addEventListener("click", deconnecterTerminal);

  /* ================================
     EVENTS WEBSOCKET — LINUX
  ================================ */
  function attacherSocketLinux() {
    const socket = window._dariushSocket;
    if (!socket) return;

    /* Terminal prêt — Docker lancé */
    socket.on("linux_ready", () => {
      window._linuxConnected = true;
      term.clear();
      term.writeln("\x1b[1;32m✓ Terminal Linux connecté\x1b[0m");
      term.writeln("\x1b[90mTu es dans ton dossier personnel. Tape tes commandes.\x1b[0m");
      term.writeln("");

      btnConnect.style.display    = "none";
      btnDisconnect.style.display = "inline-block";
      btnConnect.disabled         = false;
      inputCodeClasse.disabled    = true;
      inputPseudo.disabled        = true;
      inputMotDePasse.disabled = true;
      inputMotDePasse.value    = "";
      // Cacher le formulaire entier une fois connecté
      if (loginForm) loginForm.style.display = "none";
      setStatus("Connecté ✓", "green");

      // Envoyer la taille initiale
      fitAddon.fit();
      sendResize();

      // Focus sur le terminal
      term.focus();
    });

    /* Sortie du terminal Docker → navigateur */
    socket.on("linux_output", (data) => {
      term.write(data);
    });

    /* Container Docker terminé */
    socket.on("linux_exit", () => {
      window._linuxConnected = false;
      term.writeln("\r\n\x1b[33mSession terminée.\x1b[0m");
      btnConnect.style.display    = "inline-block";
    btnDisconnect.style.display = "none";
    btnConnect.disabled         = false;
    inputCodeClasse.disabled    = false;
    inputPseudo.disabled        = false;
    inputMotDePasse.disabled    = false;
    // Réafficher le formulaire
    if (loginForm) loginForm.style.display = "flex";
      setStatus("Session terminée.", "#888");
    });

    /* Erreur serveur */
    socket.on("linux_error", ({ message }) => {
      term.writeln(`\r\n\x1b[31mErreur : ${message}\x1b[0m`);
      btnConnect.disabled      = false;
      inputCodeClasse.disabled = false;
      inputPseudo.disabled     = false;
      inputMotDePasse.disabled    = false;
      setStatus("Erreur : " + message, "red");
    });
  }

  /* ================================
     ENTRÉE CLAVIER → SERVEUR
  ================================ */
  term.onData((data) => {
    const socket = window._dariushSocket;
    if (socket && socket.connected && window._linuxConnected) {
      socket.emit("linux_input", data);
    }
  });

  /* ================================
     ATTENDRE QUE LE SOCKET SOIT PRÊT
     _dariushSocket est initialisé par SOCKET_connexion.js
     qui est chargé en type="module" — peut arriver après DOMContentLoaded
  ================================ */
  function waitForSocket(attempts) {
    if (attempts <= 0) {
      setStatus("WebSocket non disponible.", "red");
      return;
    }
    if (window._dariushSocket) {
      attacherSocketLinux();
      return;
    }
    setTimeout(() => waitForSocket(attempts - 1), 200);
  }

  waitForSocket(25); // attend jusqu'à 5 secondes

});