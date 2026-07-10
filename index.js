require('dotenv').config();
const express = require('express');
const cors = require('cors'); // Importation de la bibliothèque CORS
const { OpenAI } = require('openai');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION IMPORTANTE
app.use(cors()); // Autorise ton extension à communiquer avec le serveur
app.use(express.json());

// Connexion MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connecté à MongoDB Atlas"))
    .catch(err => console.error("Erreur connexion MongoDB :", err));

// Définition de ta fonction IA (si elle est dans un autre fichier, remplace ceci par un require)
async function getCardIdFromAI(imageUrl, title) {
    // Insère ici ta logique OpenAI / OpenRouter
    // Retourne un objet formaté comme : { set: "...", number: "...", url: "..." }
    return { set: "placeholder", number: "1", url: "https://example.com" };
}

// Route principale
app.post('/api/analyser', async (req, res) => {
    try {
        const { imageUrl, title } = req.body;
        
        // La fonction est maintenant définie dans le fichier
        const foundCard = await getCardIdFromAI(imageUrl, title); 
        
        res.json({ success: true, data: foundCard });
    } catch (error) {
        console.error("Erreur serveur :", error);
        res.status(500).json({ error: "Erreur lors de l'analyse" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));