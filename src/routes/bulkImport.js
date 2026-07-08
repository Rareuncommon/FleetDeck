'use strict';
const express = require('express');
const { createClient } = require('../services/clientOps');
const { normalizeMac } = require('../services/mac');

// Deliberately simple: splits on newlines then commas. Tolerates an optional
// header row ("name,mac"), blank lines, and surrounding whitespace/quotes on
// each field. This app's fleets are small (home/café scale), not enterprise
// data imports, so a full RFC-4180 CSV parser would be overkill here.
function parseCsv(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    if (cols.length < 2) continue;
    const [name, mac] = cols;
    if (/^name$/i.test(name) && /^mac$/i.test(mac)) continue; // skip header row
    rows.push({ name, mac });
  }
  return rows;
}

function createBulkImportRouter(ctx) {
  const router = express.Router();

  router.post('/api/clients/bulk-import', async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.csv !== 'string' || !body.csv.trim()) {
        return res.status(400).json({ error: 'csv (string) is required' });
      }
      const rows = parseCsv(body.csv);
      if (rows.length === 0) {
        return res.status(400).json({ error: 'No valid rows found (expected "name,mac" per line)' });
      }
      if (rows.length > 500) {
        return res.status(400).json({ error: 'Too many rows in one import (max 500)' });
      }

      const results = [];
      // Sequential, not parallel — matches this project's existing pattern (see
      // scheduler.js's nightly reset loop) for avoiding concurrent TrueNAS mutations.
      for (let i = 0; i < rows.length; i += 1) {
        const { name, mac: rawMac } = rows[i];
        const rowNum = i + 1;
        if (!name) {
          results.push({ row: rowNum, name, mac: rawMac, ok: false, error: 'name is required' });
          continue;
        }
        let mac;
        try {
          mac = normalizeMac(rawMac);
        } catch (err) {
          results.push({ row: rowNum, name, mac: rawMac, ok: false, error: err.message });
          continue;
        }
        try {
          const client = await createClient(ctx, { name, mac });
          results.push({ row: rowNum, name, mac, ok: true, id: client.id });
        } catch (err) {
          results.push({ row: rowNum, name, mac, ok: false, error: err.message });
        }
      }
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createBulkImportRouter, parseCsv };
