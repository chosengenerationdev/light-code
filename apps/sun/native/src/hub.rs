//! A codebase that is folders on a JupyterHub server.
//!
//! Fire Code keeps the settings (hub address, user, folders, kernel) on the codebase and the token in
//! the vault as an ordinary saved credential. At launch it writes the settings the host reads
//! (`--jupyter-hub`), with the token named only by its secret-store slot - never the value - and points
//! that slot at the credential, so replacing the token in Credentials applies at the next call.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HubSettings {
    pub url: String,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    pub folders: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    /// The vault credential holding the token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// What the page sends: the settings, plus a typed token or a chosen credential.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HubInput {
    pub url: String,
    pub user: String,
    #[serde(default)]
    pub server: Option<String>,
    pub folders: Vec<String>,
    #[serde(default)]
    pub kernel: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// `/a/b/` and `a\b` both mean `a/b`; `""` is the top folder. `..` is refused.
pub fn clean_folder(folder: &str) -> Result<String, String> {
    let parts: Vec<&str> = folder.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.contains(&"..") {
        return Err(format!("\"{folder}\" climbs out of the server's folders."));
    }
    Ok(parts.join("/"))
}

/// Checks and tidies what was typed. Folders that contain one another are refused: their files would
/// be copied twice, and an edit to one copy overwritten by the other's next save.
pub fn validate(input: &HubInput) -> Result<HubSettings, String> {
    let url = input.url.trim().trim_end_matches('/').to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() < 10 {
        return Err("Enter the hub's address, starting with https:// (e.g. https://jupyter.example.com).".into());
    }
    let user = input.user.trim().to_string();
    if user.is_empty() {
        return Err("Enter your JupyterHub user name.".into());
    }
    let mut folders = Vec::new();
    for line in &input.folders {
        if line.trim().is_empty() {
            continue;
        }
        let folder = clean_folder(line.trim())?;
        if folders.contains(&folder) {
            continue;
        }
        folders.push(folder);
    }
    if folders.is_empty() {
        return Err("List at least one folder on the hub (one per line; leave a line as / for the top folder).".into());
    }
    for a in &folders {
        for b in &folders {
            if a != b && (a.is_empty() || b.starts_with(&format!("{a}/"))) {
                return Err(format!("\"{b}\" is inside \"{}\", so its files would be copied twice. List only one of them.", if a.is_empty() { "/" } else { a }));
            }
        }
    }
    let tidy = |v: &Option<String>| v.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(HubSettings { url, user, server: tidy(&input.server), folders, kernel: tidy(&input.kernel), credential: None })
}

/// The secret-store slot the host reads the token from, for one codebase.
pub fn token_slot(project_id: &str) -> String {
    format!("jupyterhub:{project_id}:token")
}

/// "JupyterHub ann@hub.example.com": the credential a typed token is saved as.
pub fn credential_label(settings: &HubSettings) -> String {
    let host = settings.url.split("://").nth(1).unwrap_or(&settings.url).split('/').next().unwrap_or("");
    format!("JupyterHub {}@{}", settings.user, host)
}

/// Writes the settings the host reads, beside the codebase's other data.
pub fn write_spec(file: &Path, settings: &HubSettings, project_id: &str) -> Result<(), String> {
    let mut spec = serde_json::json!({
        "url": settings.url,
        "user": settings.user,
        "folders": settings.folders,
        "tokenRef": token_slot(project_id),
    });
    if let Some(server) = &settings.server {
        spec["server"] = serde_json::json!(server);
    }
    if let Some(kernel) = &settings.kernel {
        spec["kernel"] = serde_json::json!(kernel);
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(file, serde_json::to_string_pretty(&spec).unwrap_or_default()).map_err(|e| format!("Could not write {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(folders: &[&str]) -> HubInput {
        HubInput {
            url: "https://hub.example.com/".into(),
            user: " ann ".into(),
            server: Some(" ".into()),
            folders: folders.iter().map(|s| s.to_string()).collect(),
            kernel: None,
            token: None,
            credential: None,
        }
    }

    #[test]
    fn tidies_what_was_typed() {
        let s = validate(&input(&["/projects/risk/", "data\\shared", "", "projects/risk"])).unwrap();
        assert_eq!(s.url, "https://hub.example.com");
        assert_eq!(s.user, "ann");
        assert_eq!(s.server, None);
        assert_eq!(s.folders, vec!["projects/risk", "data/shared"]);
        assert_eq!(credential_label(&s), "JupyterHub ann@hub.example.com");
    }

    #[test]
    fn refuses_overlap_and_climbing_out() {
        assert!(validate(&input(&["/", "projects"])).unwrap_err().contains("copied twice"));
        assert!(validate(&input(&["a", "a/b"])).unwrap_err().contains("copied twice"));
        assert!(validate(&input(&["../etc"])).unwrap_err().contains("climbs out"));
        assert!(validate(&input(&[])).is_err());
    }
}
