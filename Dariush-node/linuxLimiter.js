/* linuxLimiter.js — Limiteur de conteneurs Linux + record de fréquentation */

const fs = require("fs");
const path = require("path");

const LINUX_MAX_CONTAINERS = 300;
const RECORD_FILE = path.join(__dirname, "linux_record.txt");

let linuxActiveCount = 0;
let linuxRecord = 0;
let ioRef = null;

function init(io) {
  ioRef = io;
  
  try {
    const out = require("child_process")
      .execSync('docker ps --filter "ancestor=dariush-linux" -q')
      .toString()
      .trim();
    linuxActiveCount = out ? out.split("\n").length : 0;
    console.log("[linux-limiter] Compteur initial :", linuxActiveCount, "conteneurs actifs");
  } catch (err) {
    console.warn("[linux-limiter] Impossible de compter les conteneurs au démarrage :", err.message);
    linuxActiveCount = 0;
  }

  // Charger le record depuis le fichier (persistant entre redémarrages)
  try {
    if (fs.existsSync(RECORD_FILE)) {
      const val = parseInt(fs.readFileSync(RECORD_FILE, "utf8").trim(), 10);
      if (!isNaN(val) && val >= 0) {
        linuxRecord = val;
      }
    }
    console.log("[linux-limiter] Record chargé :", linuxRecord);
  } catch (err) {
    console.warn("[linux-limiter] Impossible de lire le record :", err.message);
    linuxRecord = 0;
  }
  // Vérification automatique toutes les heures
  // 1. Tue les conteneurs orphelins (qui tournent depuis plus de 4 heures)
  // 2. Recompte les conteneurs réels et corrige le compteur si dérive
  setInterval(() => {
    try {
      // Étape 1 : tuer les conteneurs orphelins de plus de 4 heures
      // Format de --format : ID en première colonne, durée de création humaine en seconde
      const allContainers = require("child_process")
        .execSync('docker ps --filter "ancestor=dariush-linux" --format "{{.ID}} {{.CreatedAt}}"')
        .toString()
        .trim();
      
      if (allContainers) {
        const lines = allContainers.split("\n");
        const now = Date.now();
        const SEUIL_MS = 4 * 60 * 60 * 1000; // 4 heures en ms
        
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const id = parts[0];
          // CreatedAt format Docker : "2026-05-10 11:23:01 +0200 CEST"
          // On reconstitue la date depuis les parts 1, 2 et 3
          const dateStr = parts[1] + " " + parts[2] + " " + parts[3];
          const createdMs = Date.parse(dateStr);
          
          if (!isNaN(createdMs) && (now - createdMs) > SEUIL_MS) {
            try {
              require("child_process").execSync(`docker stop ${id}`, { timeout: 10000 });
              console.log("[linux-limiter] 🧹 Conteneur orphelin tué (>4h) :", id);
            } catch (errStop) {
              console.warn("[linux-limiter] Impossible de tuer", id, ":", errStop.message);
            }
          }
        }
      }
      
      // Étape 2 : recompter et corriger le compteur logique
      const out = require("child_process")
        .execSync('docker ps --filter "ancestor=dariush-linux" -q')
        .toString()
        .trim();
      const vraiCount = out ? out.split("\n").length : 0;
      
      if (vraiCount !== linuxActiveCount) {
        console.log("[linux-limiter] Correction automatique : compteur logique =", linuxActiveCount, "→ réel =", vraiCount);
        linuxActiveCount = vraiCount;
        broadcast();
      } else {
        console.log("[linux-limiter] Vérification 1h OK : compteur =", vraiCount);
      }
    } catch (err) {
      console.warn("[linux-limiter] Vérification 1h échouée :", err.message);
    }
  }, 60 * 60 * 1000);  // 1 heure en millisecondes
  
}

function broadcast() {
  try {
    if (ioRef && typeof ioRef.emit === "function") {
      ioRef.emit("linux_count_update", {
        count: linuxActiveCount,
        max: LINUX_MAX_CONTAINERS,
        record: linuxRecord
      });
    }
  } catch (err) {
    console.warn("[linux-limiter] broadcast failed :", err.message);
  }
}

function isFull() {
  return linuxActiveCount >= LINUX_MAX_CONTAINERS;
}

function increment() {
  linuxActiveCount++;
  
  // Mettre à jour le record si dépassé
  if (linuxActiveCount > linuxRecord) {
    linuxRecord = linuxActiveCount;
    // Sauvegarder le record (asynchrone pour ne pas bloquer)
    fs.writeFile(RECORD_FILE, String(linuxRecord), (err) => {
      if (err) console.warn("[linux-limiter] Impossible de sauver le record :", err.message);
    });
    console.log("[linux-limiter] 🏆 Nouveau record :", linuxRecord);
  }
  
  broadcast();
  console.log("[linux-limiter] +1 → count =", linuxActiveCount);
}

function decrement() {
  linuxActiveCount = Math.max(0, linuxActiveCount - 1);
  broadcast();
  console.log("[linux-limiter] -1 → count =", linuxActiveCount);
}

function getCount() {
  return linuxActiveCount;
}

function getMax() {
  return LINUX_MAX_CONTAINERS;
}

function getRecord() {
  return linuxRecord;
}

module.exports = {
  init,
  isFull,
  increment,
  decrement,
  broadcast,
  getCount,
  getMax,
  getRecord
};