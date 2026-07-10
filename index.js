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
        // 1. Identification via l'IA Vision
        const completion = await openai.chat.completions.create({
            model: "openai/gpt-4o",
            max_tokens: 150,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: `Identifie cette carte Pokémon. Titre Vinted : ${title}. Retourne UNIQUEMENT un objet JSON avec ce format exact : {"nom": "nom exact du pokemon en anglais (ex: Mr. Mime)", "numero": "numéro de la carte SEUL, sans le total et sans slash (ex: 179)"}` },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        });

        const dataIA = JSON.parse(completion.choices[0].message.content);
        console.log("Données de l'IA reçues :", dataIA);

        // 2. Recherche du prix sur l'API Pokémon TCG
        // Utilisation des "params" d'Axios pour encoder proprement les espaces et caractères spéciaux
        const responseAPI = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: {
                q: `name:"${dataIA.nom}" number:${dataIA.numero}`
            }
        });

        if (responseAPI.data.data && responseAPI.data.data.length > 0) {
            const card = responseAPI.data.data[0];
            
            const prix = card.cardmarket && card.cardmarket.prices ? card.cardmarket.prices.averageSellPrice : "N/A";

            res.json({
                success: true,
                data: {
                    nom: card.name,
                    numero: dataIA.numero,
                    prix: prix
                }
            });
        } else {
            res.status(404).json({
                success: false,
                error: `Carte ${dataIA.nom} (${dataIA.numero}) introuvable sur la base de données.`
            });
        }

    } catch (error) {
        // Ajout d'un log plus précis si c'est Axios qui plante
        const errorMessage = error.response?.data?.error?.message || error.message || "Erreur interne.";
        console.error("Erreur serveur :", errorMessage);
        
        res.status(500).json({ 
            success: false, 
            error: errorMessage
        });
    }
});

app.listen(PORT, () => {
    console.log(`Le serveur écoute sur le port ${PORT}`);
});