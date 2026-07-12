#!/usr/bin/env bash
# Script de build Render — nécessaire pour que Puppeteer trouve bien Chrome
# au démarrage (un simple "npm install" ne suffit pas sur Render).
set -o errexit
 
# Installation des dépendances npm
npm install
 
# Corrige un souci de permissions fréquent sur Render quand node_modules
# est repris depuis le cache de build (les binaires perdent leur droit d'exécution)
chmod +x node_modules/.bin/* 2>/dev/null || true
 
# IMPORTANT : Render sépare l'environnement de build et le runtime, et ne
# transporte que le dossier du projet (/opt/render/project/src/) entre les deux.
# On installe donc Chrome À L'INTÉRIEUR du projet, pas dans /opt/render/.cache
# (qui existe pendant le build mais disparaît au déploiement).
# Cette variable doit AUSSI être définie dans Render > Environment, avec la
# même valeur, pour que le processus runtime (node index.js) cherche au même endroit.
: "${PUPPETEER_CACHE_DIR:=/opt/render/project/src/.cache/puppeteer}"
export PUPPETEER_CACHE_DIR
mkdir -p "$PUPPETEER_CACHE_DIR"
 
# Télécharge Chrome au bon endroit
npx puppeteer browsers install chrome
 
# Vérification visible dans les logs de build : Chrome est-il bien là où il faut ?
echo "=== Contenu de $PUPPETEER_CACHE_DIR après installation ==="
find "$PUPPETEER_CACHE_DIR" -maxdepth 4 2>/dev/null || echo "⚠️ Dossier introuvable ou vide !"
 