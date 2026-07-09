const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    next();
});

app.get('/api/prix', async (req, res) => {
    const cardName = req.query.name;
    const cardNum = req.query.number;

    try {
        const url = `https://api.pokemontcg.io/v2/cards?q=name:"${cardName}" number:${cardNum}`;
        const response = await axios.get(url);

        if (response.data.data.length > 0) {
            res.json(response.data.data[0]);
        } else {
            res.status(404).json({ error: "Carte non trouvée" });
        }
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));