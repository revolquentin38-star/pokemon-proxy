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
        // 1. Analyse Visuelle : On force l'extraction de l'ID du Set et du numéro
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `Tu es un expert visuel Pokémon. Analyse l'image pour trouver :
                    1. Le numéro de la carte (ex: 179).
                    2. Le symbole de l'extension (ex: pour 151, c'est 'sv3'). 
                    Si tu n'es pas sûr de l'ID du set, donne juste le nom du set.
                    Retourne uniquement un JSON : {"numero": "...", "set_id": "...", "set_name": "..."}`
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Analyse cette carte.` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("IA a identifié (Clés uniques) :", dataIA);

        // 2. Requête ultra-précise par Set ID et Numéro
        // On essaie d'abord par set.id + number (La méthode des pros)
        let responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q: `set.id:${dataIA.set_id} number:${dataIA.numero}` }
        });

        // Fallback : Si ça échoue, on cherche juste par numéro + nom partiel
        if (responseAPI.data.data.length === 0) {
             responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
                params: { q: `number:${dataIA.numero} name:"${dataIA.set_name || ''}"` }
            });
        }

        const foundCard = responseAPI.data.data[0];

        if (foundCard) {
            res.json({
                success: true,
                data: {
                    nom: foundCard.name,
                    numero: foundCard.number,
                    prix: foundCard.cardmarket?.prices?.averageSellPrice || "N/A"
                }
            });
        } else {
            res.status(404).json({ success: false, error: "Carte non trouvée via Set ID." });
        }

    } catch (error) {
        console.error("Erreur serveur :", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur le port ${PORT}`);
});