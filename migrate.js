#!/usr/bin/env node
// Final simplified migration: tables are created separately via Supabase SQL Editor
// (no password needed there). This script only talks to the n8n REST API - creates
// the 3 workflows, links error handling, and activates them.

const fs = require("fs");

const N8N_API_KEY = process.env.N8N_API_KEY || "PASTE_YOUR_API_KEY_HERE";
const BASE = (process.env.N8N_BASE_URL || "https://n8n-trading-project.onrender.com") + "/api/v1";

async function api(method, path, body, attempt) {
  attempt = attempt || 1;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        "X-N8N-API-KEY": N8N_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    if (attempt < 5) {
      console.log("Network error on " + method + " " + path + " (attempt " + attempt + "/5): " + e.message + ", retrying in 8s...");
      await new Promise(r => setTimeout(r, 8000));
      return api(method, path, body, attempt + 1);
    }
    throw e;
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!res.ok) {
    console.error("FAILED", method, path, res.status, json);
    throw new Error("API call failed: " + method + " " + path);
  }
  return json;
}

async function waitForServer(maxAttempts) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(BASE.replace("/api/v1", "/healthz"));
      if (res.ok || res.status === 401 || res.status === 404) {
        console.log("Server is awake (attempt " + i + ")");
        return;
      }
    } catch (e) {
      console.log("Attempt " + i + "/" + maxAttempts + ": server not reachable yet (" + e.message + "), waiting 10s...");
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log("Proceeding anyway after " + maxAttempts + " attempts...");
}

async function main() {
  console.log("== Step 0: Waking up the free Render instance (can take up to 2 minutes) ==");
  await waitForServer(15);

  console.log("== Step 1: Creating workflows via n8n API ==");
  const WF1 = JSON.parse(fs.readFileSync("workflow_01.json", "utf8"));
  const WF2 = JSON.parse(fs.readFileSync("workflow_02.json", "utf8"));
  const WF3 = JSON.parse(fs.readFileSync("workflow_03.json", "utf8"));

  const created1 = await api("POST", "/workflows", { name: WF1.name, nodes: WF1.nodes, connections: WF1.connections, settings: WF1.settings });
  console.log("Created workflow:", created1.name, created1.id);

  const created2 = await api("POST", "/workflows", { name: WF2.name, nodes: WF2.nodes, connections: WF2.connections, settings: WF2.settings });
  console.log("Created workflow:", created2.name, created2.id);

  const created3 = await api("POST", "/workflows", { name: WF3.name, nodes: WF3.nodes, connections: WF3.connections, settings: WF3.settings });
  console.log("Created workflow:", created3.name, created3.id);

  console.log("== Step 2: Linking error workflow ==");
  await api("PATCH", `/workflows/${created1.id}`, { settings: Object.assign({}, WF1.settings, { errorWorkflow: created3.id }) });
  await api("PATCH", `/workflows/${created2.id}`, { settings: Object.assign({}, WF2.settings, { errorWorkflow: created3.id }) });
  console.log("Linked 03_Error_Alert_Handler as error workflow for 01 and 02");

  console.log("");
  console.log("=== DONE ===");
  console.log("Workflows created: " + created1.id + ", " + created2.id + ", " + created3.id);
  console.log("Remaining manual steps in the n8n UI (cannot be done via script - OAuth/passwords need your browser):");
  console.log("1. Settings > Credentials > Add > Postgres: host=" + "aws-1-eu-west-1.pooler.supabase.com" + ", port=5432, database=postgres, user=postgres.fnxknbgrfocewvhmgnfl, password=<your Supabase DB password>, SSL=require. Name it 'Supabase Postgres'.");
  console.log("2. In each workflow, open every Postgres node and select the 'Supabase Postgres' credential.");
  console.log("3. Connect Gmail (Send Daily Report / Send Go-Live Notification / Send Error Alert nodes) and PDF.co (Generate PDF Report node).");
  console.log("4. Toggle each workflow's Active switch ON (top right of each workflow).");
}

main().catch(e => { console.error(e); process.exit(1); });
