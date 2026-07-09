require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    try {
        // 1. Identification via l'IA (Vision)
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: `Identifie cette carte Pokémon. Titre Vinted: ${title}. Retourne UNIQUEMENT un JSON: {"nom": "nom exact", "numero": "ex: 179/165"}.` },
                    { type: "image_url", image_url: { url: imageUrl } }
                ]
            }],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);

        // 2. Recherche du prix via l'API Pokémon (celle que tu utilisais déjà)
        const url = `https://api.pokemontcg.io/v2/cards?q=name:"${dataIA.nom}" number:${dataIA.numero}`;
        const responseAPI = await axios.get(url);

        if (responseAPI.data.data.length > 0) {
            const card = responseAPI.data.data[0];
            // On renvoie les infos propres à ton extension
            res.json({
                success: true,
                data: {
                    nom: card.name,
                    prix: card.cardmarket?.prices?.averageSellPrice || "Non dispo",
                    marketPrice: card.cardmarket?.prices?.averageSellPrice || 0,
                    url: card.cardmarket?.url
                }
            });
        } else {
            res.status(404).json({ success: false, error: "Carte identifiée mais introuvable dans l'API de prix" });
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Erreur lors de l'analyse." });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));