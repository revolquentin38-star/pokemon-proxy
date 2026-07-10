require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function getCardIdFromAI(imageUrl, title) {
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "~google/gemini-pro-latest",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": `Extrais le nom et le numéro. JSON : {"name": "Nom", "number": "123"}. Titre : ${title}` },
                    { "type": "image_url", "image_url": { "url": imageUrl } }
                ]
            }]
        }, { headers: { "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`, "HTTP-Referer": "https://render.com", "X-Title": "PokemonScanner" } });
        return JSON.parse(response.data.choices[0].message.content.replace(/```json|```/g, "").trim());
    } catch (e) { return null; }
}

app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        if (!cardInfo) return res.status(400).json({ error: "IA échec" });

        // On utilise Google pour trouver la page Cardmarket exacte
        const googleSearch = `https://www.google.com/search?q=site:cardmarket.com+Pokemon+${encodeURIComponent(cardInfo.name)}+${cardInfo.number}`;
        const scraperUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(googleSearch)}&render=true`;
        
        const response = await axios.get(scraperUrl);
        const $ = cheerio.load(response.data);
        
        // On récupère le 1er lien vers cardmarket.com
        const cardmarketLink = $('a[href*="cardmarket.com"]').first().attr('href');
        if (!cardmarketLink) return res.status(404).json({ error: "Carte non trouvée" });

        // On scrape cette page précise
        const pageResponse = await axios.get(`http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(cardmarketLink)}&render=true`);
        const $p = cheerio.load(pageResponse.data);
        const price = $p('.price-container .price').first().text().trim();

        res.json({ success: true, price: price || "Non trouvé" });
    } catch (error) {
        console.error("Erreur:", error.message);
        res.status(500).json({ error: "Erreur lors du scraping" });
    }
});

app.listen(PORT, () => console.log(`Serveur prêt sur ${PORT}`));