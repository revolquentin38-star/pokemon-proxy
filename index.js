require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// 1. Analyse IA (Gemini Flash)
async function getCardIdFromAI(imageUrl, title) {
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "~google/gemini-pro-latest",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": `Extrais le nom et le numéro de cette carte. JSON strict : {"name": "Nom", "number": "123"}. Titre : ${title}` },
                    { "type": "image_url", "image_url": { "url": imageUrl } }
                ]
            }]
        }, { headers: { "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`, "HTTP-Referer": "https://render.com" } });
        return JSON.parse(response.data.choices[0].message.content.replace(/```json|```/g, "").trim());
    } catch (e) { return null; }
}

// 2. Scraping optimisé (Recherche Google + Parsing direct)
app.post('/api/analyser', async (req, res) => {
    req.socket.setTimeout(60000); // Protection contre timeout 499
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        if (!cardInfo) return res.status(400).json({ error: "IA échec" });

        // Recherche Google vers Cardmarket
        const query = `site:cardmarket.com Pokemon ${cardInfo.name} ${cardInfo.number}`;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const scraperUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(searchUrl)}&render=true`;
        
        const response = await axios.get(scraperUrl);
        const $ = cheerio.load(response.data);
        
        // Récupérer le lien Cardmarket
        const link = $('a[href*="cardmarket.com"]').first().attr('href');
        if (!link) return res.status(404).json({ error: "Non trouvé sur Google" });

        // Scraper le prix depuis le lien
        const pResponse = await axios.get(`http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(link)}&render=true`);
        const $p = cheerio.load(pResponse.data);
        const price = $p('.price-container .price').first().text().trim();

        res.json({ success: true, price: price || "Prix indisponible" });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors du scraping" });
    }
});

app.listen(PORT, () => console.log(`Serveur prêt sur port ${PORT}`));