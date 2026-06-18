use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use once_cell::sync::Lazy;
use regex::Regex;

// [[wikilink]] and [[wikilink|alias]] and [[note#heading]]
static WIKILINK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[\[([^\]\|#]+)(?:#[^\]\|]+)?(?:\|[^\]]+)?\]\]").unwrap());
// #tag (not inside code, simplistic but effective)
static TAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|\s)#([A-Za-z0-9_\-/]+)").unwrap());
// YAML frontmatter tags: line "tags: [a, b]" or "- tag"
static FRONTMATTER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)^---\n(.*?)\n---").unwrap());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,          // vault-relative path without extension
    pub title: String,       // basename
    pub folder: String,      // top-level district
    pub folder_path: String, // full folder path
    pub word_count: usize,
    pub out_links: usize,
    pub in_links: usize,
    pub degree: usize,       // total connections, drives building height
    pub tags: Vec<String>,
    pub created: u64,        // mtime-ish for "age" coloring
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub districts: Vec<String>, // distinct top-level folders
    pub all_tags: Vec<String>,
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn rel_id(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let s = rel.with_extension("");
    s.to_string_lossy().replace('\\', "/")
}

fn extract_tags(content: &str) -> Vec<String> {
    let mut tags = HashSet::new();
    if let Some(fm) = FRONTMATTER.captures(content) {
        let block = &fm[1];
        for line in block.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("tags:") {
                for t in rest.replace(['[', ']'], "").split(',') {
                    let t = t.trim().trim_matches('"').trim_matches('\'');
                    if !t.is_empty() {
                        tags.insert(t.to_string());
                    }
                }
            } else if line.starts_with("- ") && block.contains("tags:") {
                let t = line[2..].trim();
                if !t.is_empty() && !t.contains(':') {
                    tags.insert(t.to_string());
                }
            }
        }
    }
    for cap in TAG.captures_iter(content) {
        tags.insert(cap[1].to_string());
    }
    let mut v: Vec<String> = tags.into_iter().collect();
    v.sort();
    v
}

/// Build the full graph from a vault root.
pub fn build_graph(root_str: &str) -> Result<Graph, String> {
    let root = PathBuf::from(root_str);
    if !root.is_dir() {
        return Err(format!("Not a directory: {root_str}"));
    }

    // First pass: collect notes + map title/id -> id for link resolution.
    let mut raw: Vec<(String, String, PathBuf, u64, u64)> = Vec::new(); // id, content, path, created, modified
    let mut by_title: HashMap<String, String> = HashMap::new();
    let mut by_id: HashSet<String> = HashSet::new();

    for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // skip .obsidian and other dotfolders
        if path.components().any(|c| {
            c.as_os_str()
                .to_str()
                .map(|s| s.starts_with('.'))
                .unwrap_or(false)
        }) {
            continue;
        }
        let content = fs::read_to_string(path).unwrap_or_default();
        let id = rel_id(&root, path);
        let meta = fs::metadata(path).ok();
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let created = meta
            .as_ref()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(modified);

        by_title.insert(stem(path).to_lowercase(), id.clone());
        by_id.insert(id.clone());
        raw.push((id, content, path.to_path_buf(), created, modified));
    }

    // Second pass: resolve links, compute metrics.
    let mut nodes: HashMap<String, Node> = HashMap::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut in_count: HashMap<String, usize> = HashMap::new();
    let mut districts: HashSet<String> = HashSet::new();
    let mut all_tags: HashSet<String> = HashSet::new();

    for (id, content, path, created, modified) in &raw {
        let rel = path.strip_prefix(&root).unwrap_or(path);
        let folder_path = rel
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let district = folder_path
            .split('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("root")
            .to_string();
        districts.insert(district.clone());

        let tags = extract_tags(content);
        for t in &tags {
            all_tags.insert(t.clone());
        }

        let mut out = 0usize;
        for cap in WIKILINK.captures_iter(content) {
            let target_raw = cap[1].trim().to_lowercase();
            if let Some(target_id) = by_title.get(&target_raw) {
                if target_id != id {
                    edges.push(Edge {
                        source: id.clone(),
                        target: target_id.clone(),
                    });
                    *in_count.entry(target_id.clone()).or_insert(0) += 1;
                    out += 1;
                }
            }
        }

        let word_count = content.split_whitespace().count();

        nodes.insert(
            id.clone(),
            Node {
                id: id.clone(),
                title: stem(path),
                folder: district,
                folder_path,
                word_count,
                out_links: out,
                in_links: 0,
                degree: out,
                tags,
                created: *created,
                modified: *modified,
            },
        );
    }

    for (id, c) in in_count {
        if let Some(n) = nodes.get_mut(&id) {
            n.in_links = c;
            n.degree += c;
        }
    }

    let mut node_vec: Vec<Node> = nodes.into_values().collect();
    node_vec.sort_by(|a, b| b.degree.cmp(&a.degree));

    let mut district_vec: Vec<String> = districts.into_iter().collect();
    district_vec.sort();
    let mut tag_vec: Vec<String> = all_tags.into_iter().collect();
    tag_vec.sort();

    Ok(Graph {
        nodes: node_vec,
        edges,
        districts: district_vec,
        all_tags: tag_vec,
    })
}
