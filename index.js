require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
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

// Fonction IA via OpenRouter
async function getCardIdFromAI(imageUrl, title) {
    console.log("Analyse IA en cours pour :", title);
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "openai/gpt-4o",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": `Analyse cette carte Pokémon. Donne le nom de l'extension et le numéro au format JSON : {"set": "nom-extension", "number": "123"}. Si impossible, renvoie {"set": null}.` },
                    { "type": "image_url", "image_url": { "url": imageUrl } }
                ]
            }]
        }, { headers: { "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}` } });

        const result = JSON.parse(response.data.choices[0].message.content);
        if (!result.set) return null;

        const formattedSet = result.set.replace(/\s+/g, '-');
        const url = `https://www.cardmarket.com/fr/Pokemon/Products/Singles/${formattedSet}/${result.set}-${result.number}`;
        return { cardId: `${formattedSet}-${result.number}`, url };
    } catch (e) { console.error("Erreur IA :", e); return null; }
}

app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        
        if (!cardInfo) return res.json({ success: false, error: "IA n'a pas pu identifier la carte" });

        // Vérif MongoDB
        const cachedCard = await CardPrice.findOne({ cardId: cardInfo.cardId });
        if (cachedCard) return res.json({ success: true, data: { price: cachedCard.price, source: "cache" } });

        // Scraping Puppeteer
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(cardInfo.url, { waitUntil: 'domcontentloaded' });
        
        const price = await page.evaluate(() => {
            const el = document.querySelector('.price-container .price'); // Sélecteur Cardmarket à ajuster si besoin
            return el ? el.innerText.trim() : "Prix introuvable";
        });

        await browser.close();

        if (price !== "Prix introuvable") {
            await CardPrice.findOneAndUpdate({ cardId: cardInfo.cardId }, { price, lastUpdated: new Date() }, { upsert: true });
        }

        res.json({ success: true, data: { price, source: "scraping" } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur lors de l'analyse" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));