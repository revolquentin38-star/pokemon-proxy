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
        // 1. Analyse visuelle par l'IA
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o",
            max_tokens: 300,
            messages: [
                {
                    role: "system",
                    content: "Tu es un expert Pokémon. Analyse l'image. Retourne UN JSON pur. Format: {'nom': 'nom exact', 'numero': 'numéro seul sans slash (ex: 179)', 'serie': 'nom série'}"
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Analyse cette carte. Titre Vinted: ${title}.` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("Données IA extraites :", dataIA);

        // 2. Recherche plus souple : on cherche juste par nom d'abord
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: `name:"${dataIA.nom}"` } // Recherche large par nom
        });

        // 3. Filtrage intelligent dans les résultats reçus
        const results = responseAPI.data.data;
        const foundCard = results.find(c => c.number === dataIA.numero) || results[0];

        if (foundCard) {
            const prix = foundCard.cardmarket?.prices?.averageSellPrice || "N/A";
            res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    serie: dataIA.serie,
                    prix: prix
                }
            });
        } else {
            res.status(404).json({ success: false, error: "Carte non trouvée dans la base de données." });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});