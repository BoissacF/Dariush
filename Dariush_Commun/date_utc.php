<?php
header("Content-Type: application/json");

// Forcer le fuseau UTC
date_default_timezone_set("UTC");

echo json_encode([
    "utc_iso"   => gmdate("Y-m-d\TH:i:s\Z"),
    "date"      => gmdate("Y-m-d"),
    "heure"     => gmdate("H:i:s"),
    "timestamp" => time()
]);