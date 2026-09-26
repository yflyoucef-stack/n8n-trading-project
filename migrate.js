#!/usr/bin/env node
// One-shot migration script: creates the 3 Data Tables, seeds initial rows,
// creates the 3 workflows (with correct table IDs wired in), and activates them.
// Run this via GitHub Actions (workflow_dispatch) - it calls your n8n instance over its public HTTPS URL.

const N8N_API_KEY = process.env.N8N_API_KEY || "PASTE_YOUR_API_KEY_HERE";
const BASE = (process.env.N8N_BASE_URL || "https://n8n-trading-project.onrender.com") + "/api/v1";

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!res.ok) {
    console.error("FAILED", method, path, res.status, json);
    throw new Error("API call failed: " + method + " " + path);
  }
  return json;
}

async function main() {
  console.log("== Step 1: Creating data tables ==");
  
