const express = require('express');
const cors = require('cors'); // Obligatoire
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION CORS : C'est ce qui débloque ton extension
app.use(cors()); 

app.use(express.json());

// Connexion MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connecté à MongoDB Atlas"))
    .catch(err => console.error("Erreur connexion MongoDB :", err));

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
        // Identification IA (Ton logic existant)
        const foundCard = await getCardIdFromAI(imageUrl, title); 
        const cardId = `${foundCard.set}-${foundCard.number}`;

        // CACHE-FIRST : Vérification DB
        const cachedCard = await CardPrice.findOne({ cardId: cardId });
        const oneDayInMs = 24 * 60 * 60 * 1000;
        
        if (cachedCard && (Date.now() - cachedCard.lastUpdated < oneDayInMs)) {
            console.log("Donnée trouvée en base (Cache) :", cardId);
            return res.json({ success: true, data: { prix: cachedCard.price, source: "db_cache" } });
        }

        // Scraping
        console.log("Cache absent, scraping pour :", cardId);
        const { data: html } = await axios.get(foundCard.url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        const $ = cheerio.load(html);
        const scrapedPrice = $('.table-body .row .col-offer').first().text().trim();

        // Sauvegarde DB
        await CardPrice.findOneAndUpdate(
            { cardId: cardId },
            { price: scrapedPrice, lastUpdated: new Date() },
            { upsert: true, new: true }
        );

        res.json({ success: true, data: { prix: scrapedPrice, source: "scraping" } });

    } catch (error) {
        console.error("Erreur serveur :", error);
        res.status(500).json({ error: "Erreur lors de l'analyse" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));