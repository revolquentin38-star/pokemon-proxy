require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
// Nouveaux imports pour le scraping furtif
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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
    // Remplacer par ta vraie logique
    return { set: "base-set", number: "1", url: "https://www.cardmarket.com/" }; 
}

app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const foundCard = await getCardIdFromAI(imageUrl, title); 
        const cardId = `${foundCard.set}-${foundCard.number}`;

        // 1. VÉRIFICATION MONGODB (Le Bouclier)
        const cachedCard = await CardPrice.findOne({ cardId: cardId });
        if (cachedCard) {
            console.log("Donnée trouvée dans MongoDB :", cardId);
            return res.json({ success: true, data: { price: cachedCard.price, source: "db_cache" } });
        }

        // 2. SCRAPING FURTIF (Le Bélier)
        console.log("Prix absent de MongoDB, lancement de Puppeteer pour :", cardId);
        
        // Configuration optimisée pour consommer très peu de RAM sur Render
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // Évite les crashs de mémoire sur serveur Linux
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        // Bloquer les images et polices pour charger la page beaucoup plus vite
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Aller sur Cardmarket
        await page.goto(foundCard.url, { waitUntil: 'domcontentloaded' });
        
        // Extraire le prix
        const scrapedPrice = await page.evaluate(() => {
            const priceElement = document.querySelector('.table-body .row .col-offer');
            return priceElement ? priceElement.innerText.trim() : "Prix introuvable";
        });

        await browser.close();
        console.log("Prix récupéré par Puppeteer :", scrapedPrice);

        if (scrapedPrice !== "Prix introuvable") {
            // 3. SAUVEGARDE MONGODB
            await CardPrice.findOneAndUpdate(
                { cardId: cardId },
                { price: scrapedPrice, lastUpdated: new Date() },
                { upsert: true, new: true }
            );
        }

        res.json({ success: true, data: { price: scrapedPrice, source: "scraping" } });

    } catch (error) {
        console.error("Erreur serveur :", error);
        res.status(500).json({ error: "Erreur lors du scraping" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));