const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 1. Connexion MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connecté à MongoDB Atlas"))
    .catch(err => console.error("Erreur connexion MongoDB :", err));

// Définition du modèle de données
const CardPriceSchema = new mongoose.Schema({
    cardId: { type: String, required: true, unique: true },
    price: String,
    lastUpdated: { type: Date, default: Date.now }
});
const CardPrice = mongoose.model('CardPrice', CardPriceSchema);

const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    try {
        // --- ÉTAPE A : Identification (Ton code IA existant) ---
        // (Supposons que tu récupères l'ID ici)
        const foundCard = await getCardIdFromAI(imageUrl, title); 
        const cardId = `${foundCard.set}-${foundCard.number}`;

        // --- ÉTAPE B : CACHE-FIRST (On cherche en DB) ---
        const cachedCard = await CardPrice.findOne({ cardId: cardId });
        const oneDayInMs = 24 * 60 * 60 * 1000;
        
        if (cachedCard && (Date.now() - cachedCard.lastUpdated < oneDayInMs)) {
            console.log("Donnée trouvée en base (Cache) :", cardId);
            return res.json({ success: true, data: { prix: cachedCard.price, source: "db_cache" } });
        }

        // --- ÉTAPE C : Scraping (Seulement si nécessaire) ---
        console.log("Cache absent ou périmé, scraping nécessaire pour :", cardId);
        const cmUrl = foundCard.url; // URL Cardmarket
        
        const { data: html } = await axios.get(cmUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        const $ = cheerio.load(html);
        const scrapedPrice = $('.table-body .row .col-offer').first().text().trim();

        // --- ÉTAPE D : Mise à jour de la base ---
        await CardPrice.findOneAndUpdate(
            { cardId: cardId },
            { price: scrapedPrice, lastUpdated: new Date() },
            { upsert: true, new: true }
        );

        res.json({ success: true, data: { prix: scrapedPrice, source: "scraping" } });

    } catch (error) {
        console.error("Erreur globale :", error);
        
        // Sécurité : Si le scraping échoue, on renvoie quand même l'ancien prix du cache s'il existe
        if (cachedCard) {
            return res.json({ success: true, data: { prix: cachedCard.price, source: "cache_expire_fallback" } });
        }
        res.status(500).json({ error: "Erreur serveur / Scraping impossible" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));