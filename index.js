const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Configuration OpenAI / OpenRouter
const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    if (!imageUrl) {
        return res.status(400).json({ success: false, error: "Image manquante" });
    }

    try {
        // 1. Analyse IA (Optimisée : gpt-4o-mini + tokens limités)
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o-mini",
            max_tokens: 150, 
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon TCG. Analyse l'image. Retourne UN UNIQUE JSON : {'nom': 'nom exact', 'numero': 'numéro', 'set_id': 'code de set si visible, sinon null'}. Ne réponds qu'avec le JSON."
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Analyse cette carte. Titre Vinted : ${title}` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("Analyse IA :", dataIA);

        // 2. Recherche API (Tentative avec Set ID pour une précision maximale)
        let responseAPI;
        if (dataIA.set_id) {
            try {
                responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
                    params: { q: `set.id:${dataIA.set_id} number:${dataIA.numero}` }
                });
            } catch (e) {
                console.log("Recherche par Set ID échouée, passage au fallback.");
            }
        }

        // 3. Fallback : Si aucune carte trouvée, on cherche par Nom + Numéro
        if (!responseAPI || responseAPI.data.data.length === 0) {
            responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
                params: { q: `name:"${dataIA.nom}" number:${dataIA.numero}` }
            });
        }

        const foundCard = responseAPI.data.data[0];

        if (foundCard) {
            res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    set: foundCard.set.name,
                    prix: foundCard.cardmarket?.prices?.averageSellPrice || "N/A"
                }
            });
        } else {
            res.status(404).json({ success: false, error: "Carte introuvable dans la base officielle" });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: "Erreur serveur interne" });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt et optimisé sur le port ${PORT}`);
});