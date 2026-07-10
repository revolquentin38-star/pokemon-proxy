const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio'); // <-- Le nouvel outil de scraping

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

// === NOTRE SYSTÈME DE CACHE (Dure 24h) ===
const priceCache = {};
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 heures en millisecondes

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    if (!imageUrl) return res.status(400).json({ error: "Image manquante" });

    try {
        // 1. Analyse IA
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            max_tokens: 150,
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon TCG. Analyse l'image. Retourne un JSON pur : {'nom_anglais': 'nom EN ANGLAIS', 'numero': 'juste le chiffre', 'set_nom': 'nom de l\'extension'}."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Titre Vinted : ${title}. Donne le nom anglais.` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("IA :", dataIA);

        // 2. Trouver la carte officielle via l'API
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: `name:"${dataIA.nom_anglais}" number:${dataIA.numero}` }
        });

        const results = responseAPI.data.data;
        if (!results || results.length === 0) return res.status(404).json({ success: false, error: "Carte introuvable dans la base" });

        // Filtrage intelligent
        let foundCard = results.find(c => dataIA.set_nom && c.set.name.toLowerCase().includes(dataIA.set_nom.toLowerCase()));
        if (!foundCard) foundCard = results.sort((a, b) => (b.cardmarket?.prices?.averageSellPrice || 0) - (a.cardmarket?.prices?.averageSellPrice || 0))[0];

        if (!foundCard || !foundCard.cardmarket?.url) {
            return res.status(404).json({ success: false, error: "Lien Cardmarket introuvable" });
        }

        // 3. LE SCRAPING DU PRIX FRANÇAIS
        // On récupère l'URL Cardmarket fournie par l'API et on ajoute le filtre FR (language=2)
        const cmUrl = `${foundCard.cardmarket.url}?language=2`;
        console.log("URL à scraper :", cmUrl);

        // A. Vérification du Cache
        if (priceCache[cmUrl] && (Date.now() - priceCache[cmUrl].timestamp < CACHE_DURATION)) {
            console.log("Prix récupéré depuis le CACHE !");
            return res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    prix: priceCache[cmUrl].price + " €",
                    source: "cache"
                }
            });
        }

        // B. Scraping si pas en cache (ou périmé)
        console.log("Scraping en cours sur Cardmarket...");
        
        // On utilise un faux User-Agent pour ne pas se faire bloquer par Cardmarket
        const { data: html } = await axios.get(cmUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });

        const $ = cheerio.load(html);
        
        // On cherche le premier prix dans la liste des offres (colonne 'col-offer')
        let scrapedPrice = $('.table-body .row .col-offer').first().text().trim();
        
        // Nettoyage du prix (enlever le symbole €, les espaces, etc.)
        scrapedPrice = scrapedPrice.replace(/[^\d,.-]/g, '').replace(',', '.');

        if (scrapedPrice) {
            // Sauvegarde dans le cache
            priceCache[cmUrl] = { price: scrapedPrice, timestamp: Date.now() };

            res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    prix: scrapedPrice + " €",
                    source: "scraping_direct"
                }
            });
        } else {
             // Sécurité : si Cardmarket change son design et que le bot ne trouve pas le texte
             res.json({ success: true, data: { nom: foundCard.name, prix: "Prix FR non dispo (Erreur structure)", source: "fallback" } });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: "Erreur serveur / Blocage antibot" });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});