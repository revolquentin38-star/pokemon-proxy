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
    console.log("Analyse IA (Gemini) en cours pour :", title);
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "~google/gemini-pro-1.5", 
            "messages": [{
                "role": "user",
                "content": [
                    { 
                        "type": "text", 
                        "text": `Expert Pokémon. Analyse cette carte : "${title}". 
                        Extrais le nom de l'extension en ANGLAIS (ex: "Twilight Masquerade", "Paldea Evolved", "151") et le numéro de la carte (ex: "129").
                        Réponds UNIQUEMENT par un JSON pur sans markdown : {"set": "nom-extension", "number": "123"}.` 
                    },
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
        const result = JSON.parse(content);
        
        if (!result.set || !result.number) return null;

        // Formatage pour Cardmarket
        const formattedSet = result.set.replace(/\s+/g, '-');
        const url = `https://www.cardmarket.com/fr/Pokemon/Products/Singles/${formattedSet}/${formattedSet}-${result.number}`;
        
        console.log("--> URL Cardmarket générée par l'IA :", url);
        return { cardId: `${formattedSet}-${result.number}`, url };
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
        
        if (!cardInfo) return res.json({ success: false, error: "L'IA n'a pas pu identifier la carte" });

        // Vérification du Cache MongoDB
        const cachedCard = await CardPrice.findOne({ cardId: cardInfo.cardId });
        if (cachedCard) {
            console.log("Prix trouvé dans le cache :", cachedCard.price);
            return res.json({ success: true, data: { price: cachedCard.price, source: "cache" } });
        }

        console.log("Lancement du scraping sur :", cardInfo.url);
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const page = await browser.newPage();
        
        // Bloquer les images/css pour aller beaucoup plus vite
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // Aller sur la page de la carte
        await page.goto(cardInfo.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        // Attendre que la boîte de prix soit visible (on essaie plusieurs sélecteurs connus de Cardmarket)
        const price = await page.evaluate(() => {
            // Essaye le sélecteur classique, ou la liste d'informations à droite
            const el1 = document.querySelector('.price-container .price');
            if (el1) return el1.innerText.trim();
            
            const el2 = document.querySelector('dt:contains("À partir de") + dd');
            if (el2) return el2.innerText.trim();

            // Recherche textuelle de secours dans les statistiques du produit
            const cells = Array.from(document.querySelectorAll('.dt-horizontal dt'));
            for (let cell of cells) {
                if (cell.textContent.includes('À partir de') || cell.textContent.includes('From')) {
                    return cell.nextElementSibling ? cell.nextElementSibling.textContent.trim() : null;
                }
            }
            return null;
        });

        await browser.close();
        console.log("Prix scrapé sur Cardmarket :", price);

        if (price && price !== "Prix introuvable") {
            await CardPrice.findOneAndUpdate(
                { cardId: cardInfo.cardId }, 
                { price, lastUpdated: new Date() }, 
                { upsert: true }
            );
            return res.json({ success: true, data: { price, source: "scraping" } });
        } else {
            return res.json({ success: false, error: "Prix introuvable sur Cardmarket. Vérifie l'URL." });
        }

    } catch (error) {
        if (browser) await browser.close();
        console.error("Erreur scraping :", error);
        res.status(500).json({ error: "Erreur lors du scraping du prix" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));