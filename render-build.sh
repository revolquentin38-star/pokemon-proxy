#!/usr/bin/env bash
# Script de build Render — nécessaire pour que Puppeteer trouve bien Chrome
# au démarrage (un simple "npm install" ne suffit pas sur Render).
set -o errexit

# Installation des dépendances npm
npm install

# S'assure que le dossier de cache Puppeteer existe
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

# Télécharge Chrome au bon endroit
npx puppeteer browsers install chrome

# Persiste le cache Chrome entre les builds (déploiements plus rapides ensuite)
if [[ ! -d $PUPPETEER_CACHE_DIR/chrome ]]; then
  echo "...Copie du cache Puppeteer depuis le cache de build"
  cp -R /opt/render/project/src/.cache/puppeteer/chrome/ $PUPPETEER_CACHE_DIR 2>/dev/null || true
else
  echo "...Sauvegarde du cache Puppeteer dans le cache de build"
  cp -R $PUPPETEER_CACHE_DIR/chrome/ /opt/render/project/src/.cache/puppeteer/ 2>/dev/null || true
fi
