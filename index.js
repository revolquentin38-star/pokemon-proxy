require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Autorise ton extension Chrome (CORS)
app.use(cors({ origin: '*' }));
app.use(express.json());

// 1. Analyse IA avec modèle stable
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
    } catch (e) { 
        console.error("Erreur IA:", e.message);
        return null; 
    }
}

// 2. Route d'analyse sécurisée
app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        if (!cardInfo) return res.json({ success: false, error: "Analyse IA échouée" });

        // Recherche Google -> Cardmarket
        const query = `site:cardmarket.com Pokemon ${cardInfo.name} ${cardInfo.number}`;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const scraperUrl = `https://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(searchUrl)}&render=true&timeout=40000`;
        
        const response = await axios.get(scraperUrl);
        const $ = cheerio.load(response.data);
        const link = $('a[href*="cardmarket.com"]').first().attr('href');
        
        if (!link) return res.json({ success: false, error: "Carte non trouvée" });

        // Scraping prix
        const pResponse = await axios.get(`https://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(link)}&render=true&timeout=40000`);
        const $p = cheerio.load(pResponse.data);
        const price = $p('.price-container .price').first().text().trim();

        if (price) {
            res.json({ success: true, price: price });
        } else {
            res.json({ success: false, error: "Prix non affiché sur Cardmarket" });
        }
        
    } catch (error) {
        console.error("Erreur Serveur:", error.message);
        // On renvoie success: false au lieu d'une erreur 500 pour ne pas faire crasher l'extension
        res.json({ success: false, error: "Erreur serveur interne" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));