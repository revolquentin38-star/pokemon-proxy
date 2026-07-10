require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Fonction IA (Place ton code ici ou importe-le)
async function getCardIdFromAI(imageUrl, title) {
    // Remplacer par ta vraie logique OpenAI / OpenRouter
    return { set: "base-set", number: "1", url: "https://www.cardmarket.com/" }; 
}

app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const foundCard = await getCardIdFromAI(imageUrl, title); 
        const cardId = `${foundCard.set}-${foundCard.number}`;

        // Cache
        const cachedCard = await CardPrice.findOne({ cardId: cardId });
        
        if (cachedCard) {
            console.log("Donnée trouvée en base (Cache) :", cardId);
            return res.json({ success: true, data: { price: cachedCard.price, source: "db_cache" } });
        }

        // Scraping
        console.log("Cache absent, scraping pour :", cardId);
        const { data: html } = await axios.get(foundCard.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(html);
        const scrapedPrice = $('.table-body .row .col-offer').first().text().trim();

        // Sauvegarde
        await CardPrice.findOneAndUpdate(
            { cardId: cardId },
            { price: scrapedPrice, lastUpdated: new Date() },
            { upsert: true, new: true }
        );

        // Réponse unifiée avec la clé "price"
        res.json({ success: true, data: { price: scrapedPrice, source: "scraping" } });

    } catch (error) {
        console.error("Erreur serveur :", error);
        res.status(500).json({ error: "Erreur lors de l'analyse" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));