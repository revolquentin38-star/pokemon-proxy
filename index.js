require('dotenv').config();
const express = require('express');
const cors = require('cors'); // Corrigé pour éviter l'erreur CORS
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

// SI ta fonction est dans un autre fichier, décommente la ligne suivante :
// const { getCardIdFromAI } = require('./aiHelper'); 

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration CORS indispensable pour ton extension
app.use(cors());
app.use(express.json());

// Connexion à MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connecté à MongoDB Atlas"))
    .catch(err => console.error("Erreur connexion MongoDB :", err));

// Schéma de la base de données
const CardPriceSchema = new mongoose.Schema({
    cardId: { type: String, required: true, unique: true },
    price: String,
    lastUpdated: { type: Date, default: Date.now }
});
const CardPrice = mongoose.model('CardPrice', CardPriceSchema);

// Configuration IA
const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

// Route principale
app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    try {
        // Appelle ta fonction d'IA (Vérifie qu'elle est bien définie/importée)
        const foundCard = await getCardIdFromAI(imageUrl, title); 
        const cardId = `${foundCard.set}-${foundCard.number}`;

        // Vérification Cache (MongoDB)
        const cachedCard = await CardPrice.findOne({ cardId: cardId });
        const oneDayInMs = 24 * 60 * 60 * 1000;
        
        if (cachedCard && (Date.now() - cachedCard.lastUpdated < oneDayInMs)) {
            console.log("Donnée trouvée en base (Cache) :", cardId);
            return res.json({ success: true, data: { prix: cachedCard.price, source: "db_cache" } });
        }

        // Scraping si pas de cache
        console.log("Cache absent, scraping pour :", cardId);
        const { data: html } = await axios.get(foundCard.url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        const $ = cheerio.load(html);
        const scrapedPrice = $('.table-body .row .col-offer').first().text().trim();

        // Sauvegarde dans MongoDB
        await CardPrice.findOneAndUpdate(
            { cardId: cardId },
            { price: scrapedPrice, lastUpdated: new Date() },
            { upsert: true, new: true }
        );

        res.json({ success: true, data: { prix: scrapedPrice, source: "scraping" } });

    } catch (error) {
        console.error("Erreur serveur :", error); // C'est ici qu'on voit l'erreur 500
        res.status(500).json({ error: "Erreur lors de l'analyse" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));