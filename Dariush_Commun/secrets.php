<?php
/* =============================================================================
   secrets.php  —  Chargement des identifiants depuis un fichier .env
   -----------------------------------------------------------------------------
   Ce fichier ne contient AUCUN secret : il est versionne sans risque.
   Les vraies valeurs vivent dans un fichier .env qui, lui, n'est jamais
   versionne et doit etre place EN DEHORS du dossier servi par le serveur web.

   Emplacements testes, dans l'ordre (le premier trouve gagne) :
     1. deux niveaux au-dessus de Dariush_Commun  <- EMPLACEMENT RECOMMANDE
        (hors racine web : le fichier n'est jamais servi en HTTP)
     2. un niveau au-dessus (racine web)          <- deconseille
     3. dans Dariush_Commun                       <- a n'utiliser qu'en local

   Usage :
     require_once __DIR__ . "/secrets.php";
     $cle = secret("DEEPSEEK_KEY");
   ============================================================================= */

if (!function_exists("secret")) {

    /**
     * Lit le fichier .env une seule fois et met le resultat en cache.
     * Format accepte :  CLE=valeur   (guillemets optionnels, # = commentaire)
     */
    function dariush_charger_env(): array
    {
        static $valeurs = null;
        if ($valeurs !== null) return $valeurs;

        $valeurs   = [];
        $candidats = [
            __DIR__ . "/../../.env",   // hors racine web  (recommande)
            __DIR__ . "/../.env",      // racine web
            __DIR__ . "/.env",         // Dariush_Commun   (local uniquement)
        ];

        $fichier = null;
        foreach ($candidats as $chemin) {
            if (is_readable($chemin)) { $fichier = $chemin; break; }
        }
        if ($fichier === null) return $valeurs;

        foreach (file($fichier, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $ligne) {
            $ligne = trim($ligne);
            if ($ligne === "" || $ligne[0] === "#") continue;

            $pos = strpos($ligne, "=");
            if ($pos === false) continue;

            $cle    = trim(substr($ligne, 0, $pos));
            $valeur = trim(substr($ligne, $pos + 1));

            // Retire une eventuelle paire de guillemets englobants.
            $n = strlen($valeur);
            if ($n >= 2
                && (($valeur[0] === '"' && $valeur[$n - 1] === '"')
                 || ($valeur[0] === "'" && $valeur[$n - 1] === "'"))) {
                $valeur = substr($valeur, 1, -1);
            }

            if ($cle !== "") $valeurs[$cle] = $valeur;
        }

        return $valeurs;
    }

    /**
     * Renvoie la valeur d'une cle du .env, ou $defaut si elle est absente.
     */
    function secret(string $cle, ?string $defaut = null): ?string
    {
        $valeurs = dariush_charger_env();
        return array_key_exists($cle, $valeurs) ? $valeurs[$cle] : $defaut;
    }
}
