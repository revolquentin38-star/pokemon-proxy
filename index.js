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
        // 1. Analyse IA
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            max_tokens: 150,
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon TCG et traducteur. Analyse l'image et le titre. Retourne un JSON pur : {'nom_anglais': 'nom exact', 'numero': 'chiffres', 'set_nom': 'extension'}. Exemples : Ptitard=Poliwag, Têtarte=Poliwhirl."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Titre Vinted : ${title}. Traduis le nom en anglais. Isole le numéro (ex: 'MEW 176' devient '176').` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        const cleanNumber = dataIA.numero ? dataIA.numero.toString().replace(/\D/g, '') : '';

        // 2. Recherche API Pokémon
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: `name:"${dataIA.nom_anglais}" number:${cleanNumber}` }
        });

        const results = responseAPI.data.data;
        if (!results || results.length === 0) {
            return res.status(404).json({ success: false, error: `Introuvable. L'IA a cherché: ${dataIA.nom_anglais} ${cleanNumber}` });
        }

        let foundCard = results.find(c => dataIA.set_nom && c.set.name.toLowerCase().includes(dataIA.set_nom.toLowerCase()));
        if (!foundCard) foundCard = results.sort((a, b) => (b.cardmarket?.prices?.averageSellPrice || 0) - (a.cardmarket?.prices?.averageSellPrice || 0))[0];

        if (!foundCard || !foundCard.cardmarket?.url) {
            return res.status(404).json({ success: false, error: "Lien Cardmarket introuvable" });
        }

        // On prépare le prix de base (Global) au cas où le scraping échoue
        let defaultPrice = foundCard.cardmarket?.prices?.averageSellPrice ? foundCard.cardmarket.prices.averageSellPrice + " €" : "N/A";
        let finalPrice = defaultPrice;
        let source = "API (Prix Moyen Global)";

        // 3. TENTATIVE DE SCRAPING CARDMARKET (Dans un try/catch séparé !)
        const cmUrl = `${foundCard.cardmarket.url}?language=2`;

        try {
            console.log("Tentative de scraping sur :", cmUrl);
            const { data: html } = await axios.get(cmUrl, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
                },
                timeout: 5000 // On n'attend pas plus de 5 secondes
            });

            const $ = cheerio.load(html);
            let scrapedPrice = $('.table-body .row .col-offer').first().text().trim();
            scrapedPrice = scrapedPrice.replace(/[^\d,.-]/g, '').replace(',', '.');

            if (scrapedPrice) {
                finalPrice = scrapedPrice + " €";
                source = "Scraping FR Direct";
                console.log("Scraping réussi !");
            }
        } catch (scrapeError) {
            console.log("Cardmarket a bloqué le bot. Utilisation du prix moyen global.");
            // On ne fait rien d'autre, le code va naturellement utiliser finalPrice (le prix par défaut)
        }

        // On renvoie le résultat (soit le scraping FR réussi, soit le prix Global)
        res.json({
            success: true,
            data: {
                nom: foundCard.name,
                numero: foundCard.number,
                prix: finalPrice,
                source: source
            }
        });

    } catch (error) {
        console.error("Erreur générale serveur :", error.message);
        res.status(500).json({ success: false, error: "Erreur serveur critique" });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});