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

async function getCardIdFromAI(imageUrl, title) {
    console.log("Analyse IA (Gemini 1.5 Pro) en cours...");
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "google/gemini-pro-1.5", 
            "messages": [{
                "role": "user",
                "content": [
                    { 
                        "type": "text", 
                        "text": `Expert Pokémon. Analyse cette carte : "${title}". 
                        Extrais le nom de l'extension et le numéro de la carte.
                        Réponds UNIQUEMENT par un JSON pur : {"set": "nom-extension", "number": "123"}.` 
                    },
                    { "type": "image_url", "image_url": { "url": imageUrl } }
                ]
            }]
        }, { 
            headers: { 
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "HTTP-Referer": "https://render.com", // Requis par OpenRouter
                "X-Title": "PokemonScanner"
            } 
        });

        const content = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
        const result = JSON.parse(content);
        
        if (!result.set || !result.number) return null;

        const formattedSet = result.set.toLowerCase().replace(/\s+/g, '-');
        const url = `https://www.cardmarket.com/fr/Pokemon/Products/Singles/${formattedSet}/${result.set}-${result.number}`;
        return { cardId: `${formattedSet}-${result.number}`, url };
    } catch (e) { 
        console.error("Erreur détaillée IA :", e.response ? e.response.data : e.message); 
        return null; 
    }
}

app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        
        if (!cardInfo) return res.json({ success: false, error: "Identification échouée" });

        const cachedCard = await CardPrice.findOne({ cardId: cardInfo.cardId });
        if (cachedCard) return res.json({ success: true, data: { price: cachedCard.price, source: "cache" } });

        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.goto(cardInfo.url, { waitUntil: 'domcontentloaded' });
        
        const price = await page.evaluate(() => {
            const el = document.querySelector('.price-container .price');
            return el ? el.innerText.trim() : null;
        });

        await browser.close();

        if (price) {
            await CardPrice.findOneAndUpdate({ cardId: cardInfo.cardId }, { price, lastUpdated: new Date() }, { upsert: true });
            res.json({ success: true, data: { price, source: "scraping" } });
        } else {
            res.json({ success: false, error: "Prix non trouvé" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));