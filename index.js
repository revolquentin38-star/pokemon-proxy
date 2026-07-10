require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// 1. Analyse IA
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

// 2. Scraping avec gestion d'erreurs améliorée
app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        if (!cardInfo) return res.status(400).json({ error: "IA échec" });

        const query = `site:cardmarket.com Pokemon ${cardInfo.name} ${cardInfo.number}`;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        // Ajout du timeout dans l'URL ScraperAPI
        const scraperUrl = `https://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(searchUrl)}&render=true&timeout=30000`;
        
        const response = await axios.get(scraperUrl);
        const $ = cheerio.load(response.data);
        const link = $('a[href*="cardmarket.com"]').first().attr('href');
        
        if (!link) return res.status(404).json({ error: "Non trouvé sur Google" });

        const pResponse = await axios.get(`https://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(link)}&render=true&timeout=30000`);
        const $p = cheerio.load(pResponse.data);
        const price = $p('.price-container .price').first().text().trim();

        res.json({ success: true, price: price || "Prix indisponible" });
    } catch (error) {
        console.error("Erreur Scraping:", error.message);
        res.status(502).json({ error: "Erreur de communication API" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif`));