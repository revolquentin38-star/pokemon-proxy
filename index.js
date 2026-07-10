const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
});

app.post('/api/analyser', async (req, res) => {
    const { imageUrl, title } = req.body;

    try {
        // 1. Analyse par l'IA
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o",
            max_tokens: 150,
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert. Retourne un JSON : {'nom': 'nom du pokémon', 'numero': 'juste le numéro sans le total'}"
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Analyse cette carte. Titre Vinted : ${title}.` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("IA a trouvé :", dataIA);

        // 2. Recherche large par nom uniquement
        // On ne met pas le numéro dans la requête pour éviter les 404
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: `name:"${dataIA.nom}"` }
        });

        // 3. Filtrage intelligent
        const results = responseAPI.data.data;
        if (!results || results.length === 0) {
            return res.status(404).json({ success: false, error: "Carte non trouvée" });
        }

        // On cherche le numéro dans les résultats reçus
        const card = results.find(c => c.number === dataIA.numero) || results[0];
        const prix = card.cardmarket?.prices?.averageSellPrice || "N/A";

        res.json({
            success: true,
            data: {
                nom: card.name,
                numero: card.number,
                prix: prix
            }
        });

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Le serveur écoute sur le port ${PORT}`);
});