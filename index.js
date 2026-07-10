require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 1. Analyse IA pour extraire le nom et numéro
async function getCardIdFromAI(imageUrl, title) {
    console.log("Analyse IA pour :", title);
    try {
        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            "model": "~google/gemini-pro-latest",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": `Extrais le nom de la carte (ex: "Crabicoque") et le numéro (ex: "129"). Réponds en JSON strict : {"name": "Nom", "number": "123"}. Titre source : ${title}` },
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

// 2. Recherche et Scraping via ScraperAPI
async function getPriceFromCardmarket(name, number) {
    try {
        // Recherche
        const searchUrl = `https://www.cardmarket.com/fr/Pokemon/Products/Singles?searchString=${encodeURIComponent(name + ' ' + number)}`;
        const scraperUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(searchUrl)}&render=true`;
        
        const searchResponse = await axios.get(scraperUrl);
        const $s = cheerio.load(searchResponse.data);
        
        const firstResultLink = $s('.table-body .row .col-name a').first().attr('href');
        if (!firstResultLink) return null;

        // Scraping de la page produit trouvée
        const fullUrl = `https://www.cardmarket.com${firstResultLink}`;
        const productResponse = await axios.get(`http://api.scraperapi.com?api_key=${process.env.SCRAPER_API_KEY}&url=${encodeURIComponent(fullUrl)}&render=true`);
        const $p = cheerio.load(productResponse.data);
        
        return $p('.price-container .price').first().text().trim();
    } catch (error) {
        console.error("Erreur Scraping API :", error.message);
        return null;
    }
}

// 3. Point d'entrée
app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        const cardInfo = await getCardIdFromAI(imageUrl, title);
        
        if (!cardInfo) return res.status(400).json({ error: "Identification IA échouée" });

        console.log("Recherche lancée pour :", cardInfo.name, cardInfo.number);
        const price = await getPriceFromCardmarket(cardInfo.name, cardInfo.number);

        if (price) {
            res.json({ success: true, price });
        } else {
            res.status(404).json({ error: "Prix introuvable" });
        }
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));