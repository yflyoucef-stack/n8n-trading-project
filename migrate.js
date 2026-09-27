#!/usr/bin/env node
// Short migration script: reads workflow_01/02/03.json from the repo (uploaded as files,
// not pasted), creates the 3 Data Tables, seeds initial rows, creates the 3 workflows
// with correct table IDs wired in, links the error workflow, and activates all three.

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

  console.log("== Step 1: Creating data tables ==");

  const shariah = await api("POST", "/data-tables", {
    name: "shariah_assets",
    columns: [
      { name: "symbol", type: "string" },
      { name: "approved", type: "boolean" },
      { name: "reviewDate", type: "date" },
      { name: "reviewSource", type: "string" },
      { name: "expiresOn", type: "date" },
      { name: "notes", type: "string" }
    ]
  });
  console.log("Created shariah_assets:", shariah.id);

  const paperState = await api("POST", "/data-tables", {
    name: "paper_state",
    columns: [
      { name: "equity", type: "number" },
      { name: "peakEquity", type: "number" },
      { name: "inPosition", type: "boolean" },
      { name: "symbol", type: "string" },
      { name: "entryPrice", type: "number" },
      { name: "stopPrice", type: "number" },
      { name: "firstTarget", type: "number" },
      { name: "notionalFull", type: "number" },
      { name: "notionalRemaining", type: "number" },
      { name: "halfClosed", type: "boolean" },
      { name: "trailStop", type: "number" },
      { name: "highestSinceEntry", type: "number" },
      { name: "barsOpen", type: "number" },
      { name: "tradingLocked", type: "boolean" },
      { name: "lastUpdated", type: "date" }
    ]
  });
  console.log("Created paper_state:", paperState.id);

  const paperTrades = await api("POST", "/data-tables", {
    name: "paper_trades",
    columns: [
      { name: "closedAt", type: "date" },
      { name: "symbol", type: "string" },
      { name: "reason", type: "string" },
      { name: "entryPrice", type: "number" },
      { name: "exitPrice", type: "number" },
      { name: "notional", type: "number" },
      { name: "grossPnl", type: "number" },
      { name: "fees", type: "number" },
      { name: "netPnl", type: "number" },
      { name: "equityAfter", type: "number" }
    ]
  });
  console.log("Created paper_trades:", paperTrades.id);

  console.log("== Step 2: Seeding rows ==");

  const coins = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "ADA-USDT", "LINK-USDT", "POL-USDT"];
  await api("POST", `/data-tables/${shariah.id}/rows`, {
    data: coins.map(symbol => ({
      symbol,
      approved: true,
      reviewDate: "2026-09-20",
      reviewSource: "PENDING final human confirmation - technical backtest only, user-provided candidate list",
      expiresOn: "2026-12-20",
      notes: "From user's trusted source list, cross-checked technically only"
    })),
    returnType: "count"
  });
  console.log("Seeded", coins.length, "shariah_assets rows");

  await api("POST", `/data-tables/${paperState.id}/rows`, {
    data: [{
      equity: 100, peakEquity: 100, inPosition: false, symbol: "",
      entryPrice: 0, stopPrice: 0, firstTarget: 0, notionalFull: 0, notionalRemaining: 0,
      halfClosed: false, trailStop: 0, highestSinceEntry: 0, barsOpen: 0,
      tradingLocked: false, lastUpdated: "2026-09-20"
    }],
    returnType: "count"
  });
  console.log("Seeded initial paper_state row");

  console.log("== Step 3: Creating workflows ==");

  function loadAndFixIds(filename) {
    let s = fs.readFileSync(filename, "utf8");
    s = s.split("REPLACE_PAPER_STATE_ID").join(paperState.id);
    s = s.split("REPLACE_PAPER_TRADES_ID").join(paperTrades.id);
    s = s.split("REPLACE_SHARIAH_ASSETS_ID").join(shariah.id);
    return JSON.parse(s);
  }

  const WF1 = loadAndFixIds("workflow_01.json");
  const WF2 = loadAndFixIds("workflow_02.json");
  const WF3 = loadAndFixIds("workflow_03.json");

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
  await api("POST", `/workflows/${created1.id}/activate`, null);
  await api("POST", `/workflows/${created2.id}/activate`, null);
  await api("POST", `/workflows/${created3.id}/activate`, null);
  console.log("All 3 workflows activated");

  console.log("");
  console.log("=== DONE ===");
  console.log("Everything is created and active EXCEPT two things you must still do by hand in the n8n UI:");
  console.log("1. Open '02_Daily_Report_And_GoLive_Notice' and '03_Error_Alert_Handler', click each Gmail node, and connect your Gmail account (Sign in with Google).");
  console.log("2. Open '02_Daily_Report_And_GoLive_Notice', click 'Generate PDF Report', and connect a PDF.co account (free tier) or swap it for another PDF method.");
}

main().catch(e => { console.error(e); process.exit(1); });
