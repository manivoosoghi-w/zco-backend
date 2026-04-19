import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import cheerio from 'cheerio';

const app = express();
app.use(cors());

/* ===============================
   🔎 AUTOCOMPLETE (SEARCH)
================================ */
app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Query manquante" });

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=5`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'ZCO-App' }
    });

    const data = await response.json();
    res.json(data);

  } catch (error) {
    res.status(500).json({ error: "Erreur serveur proxy" });
  }
});

/* ===============================
   📍 REVERSE GEOCODING
================================ */
app.get('/reverse', async (req, res) => {
  try {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ error: "Latitude ou longitude manquante" });
    }

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'ZCO-App' }
    });

    const data = await response.json();
    res.json(data);

  } catch (error) {
    res.status(500).json({ error: "Erreur serveur reverse" });
  }
});

/* ===============================
   🛣️ PÉAGES MULTI-SOURCES
================================ */

// Convertit "32,50 €" → 32.50
function parseEuro(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d,.-]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ⭐ Fallback intelligent
function fallbackEstimate(distanceKm) {
  if (!distanceKm || isNaN(distanceKm)) {
    return { toll: 0, source: "fallback_invalid_distance" };
  }

  const baseRate = 0.105; // coût moyen autoroute France
  const longTripFactor = distanceKm > 200 ? 1.12 : 1;

  const toll = Math.round(distanceKm * baseRate * longTripFactor * 100) / 100;

  return {
    toll,
    source: "fallback_estimation"
  };
}

// ⭐ TON PROXY CLOUDFLARE
const PROXY = "https://sweet-sunset-2827.manivoosoghi.workers.dev/?url=";

// VIA MICHELIN
async function fetchViaMichelin(from, to) {
  try {
    const url = `https://www.viamichelin.fr/web/Itineraires?departure=${encodeURIComponent(from)}&arrival=${encodeURIComponent(to)}&type=1`;

    const html = await (await fetch(PROXY + encodeURIComponent(url))).text();
    const $ = cheerio.load(html);

    const tollText =
      $('div[class*="summary"] span:contains("péage")').first().text().trim() ||
      $('span.toll').first().text().trim();

    const toll = parseEuro(tollText);
    if (toll !== null) return { toll, source: "ViaMichelin" };

    return null;
  } catch (err) {
    console.error("ViaMichelin error:", err);
    return null;
  }
}

// MAPPY
async function fetchMappy(from, to) {
  try {
    const url = `https://fr.mappy.com/itineraire#/voiture/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;

    const html = await (await fetch(PROXY + encodeURIComponent(url))).text();
    const $ = cheerio.load(html);

    const tollText =
      $('span:contains("Péages")').next().text().trim() ||
      $('div:contains("Péages")').find('span').last().text().trim();

    const toll = parseEuro(tollText);
    if (toll !== null) return { toll, source: "Mappy" };

    return null;
  } catch (err) {
    console.error("Mappy error:", err);
    return null;
  }
}

// ROUTE PÉAGE
app.get('/api/toll', async (req, res) => {
  try {
    const { from, to, distance } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: "Missing from or to" });
    }

    // 1) ViaMichelin
    const via = await fetchViaMichelin(from, to);
    if (via) return res.json(via);

    // 2) Mappy
    const mappy = await fetchMappy(from, to);
    if (mappy) return res.json(mappy);

    // 3) Fallback intelligent
    if (distance) {
      return res.json(fallbackEstimate(parseFloat(distance)));
    }

    return res.json({ toll: 0, source: "no_data" });

  } catch (err) {
    console.error("Toll API fatal error:", err);
    return res.status(500).json({ toll: 0, source: "error" });
  }
});

export default app;
