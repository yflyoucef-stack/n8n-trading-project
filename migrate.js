#!/usr/bin/env node
// Migration script v2: creates the 3 Postgres tables directly in Supabase (rock-solid,
// version-independent), seeds initial rows, then creates the 3 n8n workflows (which use
// Postgres nodes instead of Data Table nodes) via the n8n REST API, links error handling,
// and activates everything.

const fs = require("fs");
const { Client } = require("pg");

const N8N_API_KEY = process.env.N8N_API_KEY || "PASTE_YOUR_API_KEY_HERE";
const BASE = (process.env.N8N_BASE_URL || "https://n8n-trading-project.onrender.com") + "/api/v1";

const PG_HOST = process.env.SUPABASE_DB_HOST || "aws-1-eu-west-1.pooler.supabase.com";
const PG_PORT = process.env.SUPABASE_DB_PORT || 5432;
const PG_DATABASE = process.env.SUPABASE_DB_NAME || "postgres";
const PG_USER = process.env.SUPABASE_DB_USER || "postgres.fnxknbgrfocewvhmgnfl";
const PG_PASSWORD = process.env.SUPABASE_DB_PASSWORD;

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
  if (!PG_PASSWORD) {
    throw new Error("Missing SUPABASE_DB_PASSWORD secret - add it in GitHub repo secrets before running.");
  }

  console.log("== Step 0: Waking up the free Render instance (can take up to 2 minutes) ==");
  await waitForServer(15);

  console.log("== Step 1: Creating Postgres tables directly in Supabase ==");
  const pg = new Client({
    host: PG_HOST, port: PG_PORT, database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD,
    ssl: { rejectUnauthorized: false }
  });
  await pg.connect();

  await pg.query(`
    CREATE TABLE IF NOT EXISTS shariah_assets (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      approved BOOLEAN,
      reviewdate DATE,
      reviewsource TEXT,
      expireson DATE,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS paper_state (
      id SERIAL PRIMARY KEY,
      equity NUMERIC,
      peakequity NUMERIC,
      inposition BOOLEAN,
      symbol TEXT,
      entryprice NUMERIC,
      stopprice NUMERIC,
      firsttarget NUMERIC,
      notionalfull NUMERIC,
      notionalremaining NUMERIC,
      halfclosed BOOLEAN,
      trailstop NUMERIC,
      highestsinceentry NUMERIC,
      barsopen INTEGER,
      tradinglocked BOOLEAN,
      lastupdated TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      id SERIAL PRIMARY KEY,
      closedat TIMESTAMPTZ,
      symbol TEXT,
      reason TEXT,
      entryprice NUMERIC,
      exitprice NUMERIC,
      notional NUMERIC,
      grosspnl NUMERIC,
      fees NUMERIC,
      netpnl NUMERIC,
      equityafter NUMERIC
    );
  `);
  console.log("Tables created (or already existed).");

  console.log("== Step 2: Seeding rows ==");
  const coins = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "ADA-USDT", "LINK-USDT", "POL-USDT"];
  const existingShariah = await pg.query("SELECT COUNT(*) FROM shariah_assets");
  if (parseInt(existingShariah.rows[0].count) === 0) {
    for (const symbol of coins) {
      await pg.query(
        `INSERT INTO shariah_assets (symbol, approved, reviewdate, reviewsource, expireson, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [symbol, true, "2026-09-20",
         "PENDING final human confirmation - technical backtest only, user-provided candidate list",
         "2026-12-20", "From user's trusted source list, cross-checked technically only"]
      );
    }
    console.log("Seeded", coins.length, "shariah_assets rows");
  } else {
    console.log("shariah_assets already has rows, skipping seed");
  }

  const existingState = await pg.query("SELECT COUNT(*) FROM paper_state");
  if (parseInt(existingState.rows[0].count) === 0) {
    await pg.query(
      `INSERT INTO paper_state (equity, peakequity, inposition, symbol, entryprice, stopprice,
        firsttarget, notionalfull, notionalremaining, halfclosed, trailstop, highestsinceentry,
        barsopen, tradinglocked, lastupdated)
       VALUES (100, 100, false, '', 0, 0, 0, 0, 0, false, 0, 0, 0, false, now())`
    );
    console.log("Seeded initial paper_state row");
  } else {
    console.log("paper_state already has a row, skipping seed");
  }

  await pg.end();

  console.log("== Step 2b: Creating Postgres credential in n8n (password comes from GitHub secret) ==");
  let pgCredId = null;
  try {
    const cred = await api("POST", "/credentials", {
      name: "Supabase Postgres",
      type: "postgres",
      data: {
        host: PG_HOST, port: parseInt(PG_PORT), database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD,
        ssl: "require", allowUnauthorizedCerts: true, sshTunnel: false, maxConnections: 10
      }
    });
    pgCredId = cred.id;
    console.log("Created credential 'Supabase Postgres':", pgCredId);
  } catch (e) {
    console.log("Could not create credential automatically - you will link it by hand. (" + e.message + ")");
  }
  function injectCreds(wf) {
    if (!pgCredId) return wf;
    wf.nodes.forEach(function (n) {
      if (n.type === "n8n-nodes-base.postgres") n.credentials = { postgres: { id: pgCredId, name: "Supabase Postgres" } };
    });
    return wf;
  }

  console.log("== Step 3: Creating workflows via n8n API ==");
  const WF1 = injectCreds(JSON.parse(fs.readFileSync("workflow_01.json", "utf8")));
  const WF2 = injectCreds(JSON.parse(fs.readFileSync("workflow_02.json", "utf8")));
  const WF3 = JSON.parse(fs.readFileSync("workflow_03.json", "utf8"));

  const created1 = await api("POST", "/workflows", { name: WF1.name, nodes: WF1.nodes, connections: WF1.connections, settings: WF1.settings });
  console.log("Created workflow:", created1.name, created1.id);

  const created2 = await api("POST", "/workflows", { name: WF2.name, nodes: WF2.nodes, connections: WF2.connections, settings: WF2.settings });
  console.log("Created workflow:", created2.name, created2.id);

  const created3 = await api("POST", "/workflows", { name: WF3.name, nodes: WF3.nodes, connections: WF3.connections, settings: WF3.settings });
  console.log("Created workflow:", created3.name, created3.id);

  console.log("== Step 4: Linking error workflow ==");
  await api("PATCH", `/workflows/${created1.id}`, { settings: Object.assign({}, WF1.settings, { errorWorkflow: created3.id }) });
  await api("PATCH", `/workflows/${created2.id}`, { settings: Object.assign({}, WF2.settings, { errorWorkflow: created3.id }) });
  console.log("Linked 03_Error_Alert_Handler as error workflow for 01 and 02");

  console.log("== Step 5: Activating workflows ==");
  try { await api("POST", `/workflows/${created1.id}/activate`, null); } catch (e) { console.log("Could not activate workflow 1 yet (link Gmail first, then toggle Active in UI)"); }
  try { await api("POST", `/workflows/${created2.id}/activate`, null); } catch (e) { console.log("Could not activate workflow 2 yet (link Gmail first, then toggle Active in UI)"); }
  try { await api("POST", `/workflows/${created3.id}/activate`, null); } catch (e) { console.log("Could not activate workflow 3 yet (link Gmail first, then toggle Active in UI)"); }
  console.log("Activation step finished");

  console.log("");
  console.log("=== DONE ===");
  console.log("Remaining manual steps in the n8n UI: connect Gmail (Send Daily Report, Send Go-Live Notification, Send Error Alert) and PDF.co (Generate PDF Report), then make sure each workflow's Active toggle is ON.");
}

main().catch(e => { console.error(e); process.exit(1); });
