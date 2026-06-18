// app.js — orchestrates Tauri backend + City renderer + HUD
// Combined best of VaultGraph4D + VaultCity: auto-discover, districts, search, inspector, markdown

import { City } from "./city.js";
import { marked } from "marked";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

const $ = (s) => document.querySelector(s);
const city = new City($("#city"));

let graph = null;
let currentVault = null;
let liveOn = false;

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 2200);
}

// ── Auto-discover vaults ──────────────────────────────
async function discoverVaults() {
  if (!invoke) return {};
  try {
    return await invoke("discover_vaults");
  } catch (e) {
    console.error("discover_vaults error:", e);
    return {};
  }
}

// ── Load vault ────────────────────────────────────────
async function openVault() {
  const dir = await open({ directory: true, title: "Select your Obsidian vault" });
  if (!dir) return;
  await loadPath(dir);
}

async function loadPath(dir) {
  toast("Surveying the city…");
  try {
    graph = await invoke("load_vault", { path: dir });
  } catch (e) {
    toast("Error: " + e);
    return;
  }
  currentVault = dir;
  renderCity();
  const name = dir.split(/[\\/]/).pop();
  $("#vaultName").textContent = name;
  $("#refreshBtn").disabled = false;
  updateStats();

  // Start live sync
  try {
    await invoke("watch_vault", { path: dir });
    liveOn = true;
    $("#liveDot").classList.add("on");
    $("#liveDot").title = "Live sync on";
  } catch (e) {
    console.warn("watch_vault error:", e);
  }
}

function renderCity() {
  city.build(graph);
  buildDistrictList();
}

function updateStats() {
  if (!graph) return;
  const totalWords = graph.nodes.reduce((s, n) => s + (n.word_count || 0), 0);
  const kWords = (totalWords / 1000).toFixed(1);
  $("#cityMeta").textContent =
    `${graph.nodes.length} buildings · ${graph.edges.length} links · ${graph.districts.length} districts · ${kWords}k words`;
}

// ── District panel ────────────────────────────────────
function buildDistrictList() {
  const el = $("#districts");
  el.innerHTML = "";
  const counts = {};
  graph.nodes.forEach((n) => (counts[n.folder] = (counts[n.folder] || 0) + 1));

  graph.districts.forEach((d) => {
    const hue = hashHue(d);
    const row = document.createElement("div");
    row.className = "district";
    row.innerHTML =
      `<span class="swatch" style="background:hsl(${hue} 55% 55%)"></span>` +
      `<span class="district-name">${d}</span><span class="count">${counts[d] || 0}</span>`;
    row.onclick = () => {
      row.classList.toggle("off");
      const hidden = row.classList.contains("off");
      city.toggleDistrict(d, !hidden);
    };
    el.appendChild(row);
  });
}

// ── Inspector ─────────────────────────────────────────
async function showInspector(node) {
  $("#inspector").hidden = false;
  $("#insTitle").textContent = node.title;
  $("#insFolder").textContent = node.folder_path || node.folder || "root";
  $("#sIn").textContent = node.in_links ?? node.degree ?? 0;
  $("#sOut").textContent = node.out_links ?? 0;
  $("#sWords").textContent = (node.word_count ?? 0).toLocaleString();

  const tagsEl = $("#insTags");
  tagsEl.innerHTML = (node.tags || []).map((t) => `<span class="tag">#${t}</span>`).join("");

  $("#insPreview").innerHTML = "<p>Loading…</p>";

  try {
    const txt = await invoke("read_note", { relId: node.id });
    $("#insPreview").innerHTML = marked.parse(txt);
  } catch {
    $("#insPreview").innerHTML = "<p>(could not read note)</p>";
  }
}

// ── Search ────────────────────────────────────────────
let searchTimeout;
const search = $("#search");

search.oninput = () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (!graph) return;
    const q = search.value.trim().toLowerCase();
    if (!q) {
      city.buildings.forEach((m) => (m.visible = true));
      return;
    }
    let firstHit = null;
    city.buildings.forEach((m) => {
      const n = m.userData.node;
      const hit =
        n.title.toLowerCase().includes(q) ||
        (n.tags && n.tags.some((t) => t.toLowerCase().includes(q)));
      m.visible = hit;
      if (hit && !firstHit) firstHit = n.id;
    });
    if (firstHit) city.highlight(firstHit);
  }, 250);
};

// ── Keyboard shortcuts ────────────────────────────────
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    search.focus();
  }
  if (e.key === "Escape") {
    $("#inspector").hidden = true;
    search.blur();
  }
});

// ── Wire up HUD ──────────────────────────────────────
city.onSelect = (node) => showInspector(node);

$("#openBtn").onclick = openVault;
$("#closeInspector").onclick = () => ($("#inspector").hidden = true);

$("#refreshBtn").onclick = async () => {
  if (!currentVault) return;
  toast("Rebuilding…");
  try {
    graph = await invoke("refresh_graph");
    renderCity();
    updateStats();
    toast("City rebuilt");
  } catch (e) {
    toast("Error: " + e);
  }
};

// Day/night slider
$("#time").oninput = (e) => city.setTimeOfDay(e.target.value / 100);

// ── Live sync ────────────────────────────────────────
if (listen) {
  let pending;
  listen("vault-changed", () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      try {
        graph = await invoke("refresh_graph");
        renderCity();
        updateStats();
        toast("Vault updated — city redrawn");
      } catch (e) {
        console.warn("live sync rebuild error:", e);
      }
    }, 400);
  });
}

// ── Auto-discover and load on startup ────────────────
async function init() {
  const vaults = await discoverVaults();
  const names = Object.keys(vaults);

  if (names.length === 0) {
    toast("No vaults found — click Open vault");
    return;
  }

  // Populate vault selector
  const sel = $("#vaultSelector");
  sel.innerHTML = "";
  for (const [name, info] of Object.entries(vaults)) {
    const opt = document.createElement("option");
    opt.value = info.path;
    opt.textContent = name + (info.exists ? "" : " (N/A)");
    if (!info.exists) opt.disabled = true;
    sel.appendChild(opt);
  }

  // Switch vault on selection change
  sel.onchange = (e) => {
    if (e.target.value) loadPath(e.target.value);
  };

  // Auto-load first available vault
  const first = Object.entries(vaults).find(([, i]) => i.exists);
  if (first) {
    sel.value = first[1].path;
    await loadPath(first[1].path);
  }
}

init();
