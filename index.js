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
        // ... logique IA ...
        
        // --- LOGIQUE SCRAPING SÉCURISÉE ---
        const price = await getPriceFromCardmarket(cardInfo.name, cardInfo.number);
        
        if (price) {
            // Réponse de succès
            res.json({ success: true, price: price });
        } else {
            // Réponse propre si on ne trouve rien (pas d'erreur serveur)
            res.json({ success: false, error: "Prix introuvable" });
        }
    } catch (error) {
        // En cas de bug API, on renvoie un JSON au lieu de faire planter le serveur
        res.json({ success: false, error: "Erreur technique lors de l'analyse" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif`));