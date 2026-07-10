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
    console.log("Analyse IA (Gemini Flash) :", title);
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "~google/gemini-pro-latest",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": `Extrais le set et le numéro de cette carte Pokémon. Format JSON strict : {"set": "nom-extension", "number": "123"}. Titre : ${title}` },
                    { "type": "image_url", "image_url": { "url": imageUrl } }
                ]
            }]
        }, { 
            headers: { 
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "HTTP-Referer": "https://render.com",
                "X-Title": "PokemonScanner"
            } 
        });

        const content = response.data.choices[0].message.content.replace(/```json|```/g, "").trim();
        return JSON.parse(content);
    } catch (e) { 
        console.error("Erreur IA :", e.message); 
        return null; 
    }
}

app.post('/api/analyser', async (req, res) => {
    let browser;
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        
        if (!cardInfo) return res.status(400).json({ error: "Identification IA échouée" });

        const cachedCard = await CardPrice.findOne({ cardId: `${cardInfo.set}-${cardInfo.number}` });
        if (cachedCard) return res.json({ success: true, price: cachedCard.price });

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        });

        const page = await browser.newPage();
        const setUrl = cardInfo.set.replace(/\s+/g, '-').toLowerCase();
        const url = `https://www.cardmarket.com/fr/Pokemon/Products/Singles/${setUrl}/${cardInfo.set}-${cardInfo.number}`;

        console.log("Scraping URL :", url);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const price = await page.evaluate(() => {
            const el = document.querySelector('.price-container .price') || document.querySelector('.product-price');
            return el ? el.innerText.trim() : null;
        });

        await browser.close();

        if (price) {
            await CardPrice.findOneAndUpdate({ cardId: `${cardInfo.set}-${cardInfo.number}` }, { price }, { upsert: true });
            res.json({ success: true, price });
        } else {
            res.status(404).json({ error: "Prix non trouvé" });
        }
    } catch (error) {
        if (browser) await browser.close();
        console.error("Erreur scraping :", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.listen(PORT, () => console.log(`Serveur prêt sur port ${PORT}`));