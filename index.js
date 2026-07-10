const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

const priceCache = {};
const CACHE_DURATION = 24 * 60 * 60 * 1000;

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    if (!imageUrl) return res.status(400).json({ error: "Image manquante" });

    try {
        // 1. Analyse IA avec instructions renforcées
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            max_tokens: 150,
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon TCG. Analyse l'image et le titre. Retourne un JSON pur : {'nom_anglais': 'nom EN ANGLAIS (ex: Poliwhirl)', 'numero': 'uniquement les chiffres', 'set_nom': 'nom de l\'extension'}."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Titre Vinted : ${title}. Traduis le nom en anglais. Isole le numéro (ex: pour 'MEW 176', le numero est '176').` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        
        // SÉCURITÉ : On nettoie la réponse de l'IA pour s'assurer qu'il n'y a QUE des chiffres (enlève le "MEW")
        const cleanNumber = dataIA.numero ? dataIA.numero.toString().replace(/\D/g, '') : '';

        // 2. Recherche API
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: `name:"${dataIA.nom_anglais}" number:${cleanNumber}` }
        });

        const results = responseAPI.data.data;
        if (!results || results.length === 0) {
            // DEBUG MAGIQUE : L'erreur affiche maintenant ce que l'IA a essayé de chercher !
            return res.status(404).json({ 
                success: false, 
                error: `Introuvable. L'IA a cherché : Nom=${dataIA.nom_anglais}, Num=${cleanNumber}` 
            });
        }

        let foundCard = results.find(c => dataIA.set_nom && c.set.name.toLowerCase().includes(dataIA.set_nom.toLowerCase()));
        if (!foundCard) foundCard = results.sort((a, b) => (b.cardmarket?.prices?.averageSellPrice || 0) - (a.cardmarket?.prices?.averageSellPrice || 0))[0];

        if (!foundCard || !foundCard.cardmarket?.url) {
            return res.status(404).json({ success: false, error: "Lien Cardmarket introuvable" });
        }

        // 3. Scraping Cardmarket
        const cmUrl = `${foundCard.cardmarket.url}?language=2`;

        if (priceCache[cmUrl] && (Date.now() - priceCache[cmUrl].timestamp < CACHE_DURATION)) {
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

        const { data: html } = await axios.get(cmUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });

        const $ = cheerio.load(html);
        let scrapedPrice = $('.table-body .row .col-offer').first().text().trim();
        scrapedPrice = scrapedPrice.replace(/[^\d,.-]/g, '').replace(',', '.');

        if (scrapedPrice) {
            priceCache[cmUrl] = { price: scrapedPrice, timestamp: Date.now() };
            res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    prix: scrapedPrice + " €",
                    source: "scraping"
                }
            });
        } else {
             res.json({ success: true, data: { nom: foundCard.name, prix: "Prix FR non dispo", source: "fallback" } });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: "Erreur serveur / Blocage antibot" });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});