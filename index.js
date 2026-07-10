require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 1. Analyse IA avec OpenRouter
async function getCardIdFromAI(imageUrl, title) {
    console.log("Analyse IA (Gemini Flash) :", title);
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "~google/gemini-pro-latest",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": `Extrais le set et le numéro. JSON strict : {"set": "nom-set", "number": "123"}. Titre : ${title}` },
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

// 2. Scraping via ScraperAPI (Contourne Cloudflare/Blocages)
async function getPriceFromCardmarket(url) {
    const scraperUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true`;
    
    const response = await axios.get(scraperUrl);
    const $ = cheerio.load(response.data);
    
    // Sélecteur précis du prix sur Cardmarket
    const price = $('.price-container .price').first().text().trim();
    return price || null;
}

// 3. Point d'entrée
app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        
        if (!cardInfo) return res.status(400).json({ error: "Identification IA échouée" });

        const setUrl = cardInfo.set.replace(/\s+/g, '-').toLowerCase();
        const targetUrl = `https://www.cardmarket.com/fr/Pokemon/Products/Singles/${setUrl}/${cardInfo.set}-${cardInfo.number}`;

        console.log("Scraping via API de :", targetUrl);
        const price = await getPriceFromCardmarket(targetUrl);

        if (price) {
            res.json({ success: true, price });
        } else {
            res.status(404).json({ error: "Prix non trouvé" });
        }
    } catch (error) {
        console.error("Erreur critique :", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));