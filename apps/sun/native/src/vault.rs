//! Sun's credential vault: every codebase's secrets, encrypted for this Windows user.
//!
//! - `vault.key` is 32 random bytes protected with DPAPI (CryptProtectData, per user) - the same
//!   protection VS Code's own secret storage has. Nothing else can open the vault as another user.
//! - `secrets.json` is the map every codebase's host reads, sealed with AES-256-GCM under that key.
//!   Format shared with `apps/host/src/vaultCrypto.ts`; change both or neither.
//! - `credentials.json` lists the saved credentials - names, kinds, notes - and nothing secret; the
//!   values sit in the vault under `credential:<id>#<field>`. A setting that uses one stores a
//!   pointer to it, so replacing a credential here changes every place that uses it.
//!
//! Hosts get the key on stdin when Sun starts them (never in an environment variable, which every
//! command an agent runs would inherit). Values only ever travel page -> Rust, never back: the
//! Credentials page is write-only, like every secret field in Light Code.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::state::{now_millis, Paths};
use crate::system::{base64_decode, base64_encode};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub label: String,
    /// "secret" (one value) or "login" (username and password).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub updated: u64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CredentialsFile {
    #[serde(default)]
    credentials: Vec<Credential>,
    /// Words for the settings that point at credentials, where something told us (an import from
    /// VS Code). Others are described from their key.
    #[serde(default)]
    slot_labels: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    sun_vault: u8,
    iv: String,
    tag: String,
    data: String,
}

pub struct Vault {
    key: [u8; 32],
    secrets: PathBuf,
    credentials: PathBuf,
}

/// The fields each kind stores.
pub fn fields(kind: &str) -> &'static [&'static str] {
    if kind == "login" {
        &["username", "password"]
    } else {
        &["value"]
    }
}

fn pointer(id: &str, field: &str) -> String {
    format!("credential:{id}#{field}")
}

impl Vault {
    /// Opens the vault, creating its key on first use, and moves a plain secrets file (Sun 0.1.x)
    /// into it.
    pub fn open(paths: &Paths) -> Result<Vault, String> {
        let key_file = paths.root.join("vault.key");
        let key = match fs::read(&key_file) {
            Ok(sealed) => {
                let plain = dpapi_unprotect(&sealed).ok_or_else(|| {
                    format!(
                        "{} could not be opened - it belongs to another Windows user or machine. Move it aside \
                         to start a new vault; saved keys will need entering again.",
                        key_file.display()
                    )
                })?;
                <[u8; 32]>::try_from(plain.as_slice()).map_err(|_| format!("{} is damaged.", key_file.display()))?
            }
            Err(_) => {
                let key: [u8; 32] = Aes256Gcm::generate_key(&mut OsRng).into();
                let sealed = dpapi_protect(&key).ok_or("Windows refused to protect the vault key.")?;
                let _ = fs::create_dir_all(&paths.root);
                fs::write(&key_file, sealed).map_err(|e| format!("Could not save {}: {e}", key_file.display()))?;
                key
            }
        };
        let vault = Vault { key, secrets: paths.secrets_file(), credentials: paths.root.join("credentials.json") };
        // A plain file from an earlier Sun: sealed now, keys kept.
        if let Ok(text) = fs::read_to_string(&vault.secrets) {
            if serde_json::from_str::<Envelope>(&text).is_err() {
                if let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(text.trim_start_matches('\u{feff}')) {
                    vault.write_secrets(&map)?;
                }
            }
        }
        Ok(vault)
    }

    /// One field of a saved credential, for Sun's own environment. Never sent to the page.
    pub fn value(&self, id: &str, field: &str) -> Option<String> {
        self.read_secrets().ok()?.get(&pointer(id, field)).cloned()
    }

    pub fn key_hex(&self) -> String {
        self.key.iter().map(|b| format!("{b:02x}")).collect()
    }

    pub fn credentials_file(&self) -> &PathBuf {
        &self.credentials
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key))
    }

    fn read_secrets(&self) -> Result<BTreeMap<String, String>, String> {
        let text = match fs::read_to_string(&self.secrets) {
            Ok(text) => text,
            Err(_) => return Ok(BTreeMap::new()),
        };
        let envelope: Envelope = match serde_json::from_str(&text) {
            Ok(e) => e,
            Err(_) => {
                return serde_json::from_str(text.trim_start_matches('\u{feff}'))
                    .map_err(|_| format!("{} is damaged.", self.secrets.display()))
            }
        };
        let iv = base64_decode(&envelope.iv).ok_or("The vault is damaged (iv).")?;
        let mut sealed = base64_decode(&envelope.data).ok_or("The vault is damaged (data).")?;
        sealed.extend(base64_decode(&envelope.tag).ok_or("The vault is damaged (tag).")?);
        if iv.len() != 12 {
            return Err("The vault is damaged (iv length).".into());
        }
        let plain = self
            .cipher()
            .decrypt(Nonce::from_slice(&iv), sealed.as_slice())
            .map_err(|_| "The vault could not be opened with this machine's key.".to_string())?;
        serde_json::from_slice(&plain).map_err(|_| "The vault's contents are damaged.".to_string())
    }

    fn write_secrets(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let plain = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        let mut sealed = self.cipher().encrypt(&nonce, plain.as_slice()).map_err(|_| "Encryption failed.".to_string())?;
        let tag = sealed.split_off(sealed.len() - 16);
        let envelope = Envelope { sun_vault: 1, iv: base64_encode(&nonce), tag: base64_encode(&tag), data: base64_encode(&sealed) };
        write_atomic(&self.secrets, &serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?)
    }

    /// Read, change, write - re-reading first, because the hosts write this file too.
    fn update_secrets(&self, change: impl FnOnce(&mut BTreeMap<String, String>)) -> Result<(), String> {
        let mut map = self.read_secrets()?;
        change(&mut map);
        self.write_secrets(&map)
    }

    fn read_credentials(&self) -> CredentialsFile {
        fs::read_to_string(&self.credentials)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn write_credentials(&self, file: &CredentialsFile) -> Result<(), String> {
        write_atomic(&self.credentials, &serde_json::to_string_pretty(file).map_err(|e| e.to_string())?)
    }

    /// The saved credentials, each with the settings that use it - for the Credentials page.
    pub fn list(&self) -> Result<Vec<serde_json::Value>, String> {
        let file = self.read_credentials();
        let secrets = self.read_secrets()?;
        Ok(file
            .credentials
            .iter()
            .map(|c| {
                let prefix = format!("credential:{}#", c.id);
                let mut used: Vec<String> = secrets
                    .iter()
                    .filter(|(key, value)| value.starts_with(&prefix) && !key.starts_with("credential:"))
                    .map(|(key, _)| file.slot_labels.get(key).cloned().unwrap_or_else(|| describe_slot(key)))
                    .collect();
                used.sort();
                used.dedup();
                let complete = fields(&c.kind).iter().all(|f| secrets.contains_key(&pointer(&c.id, f)));
                serde_json::json!({
                    "id": c.id, "label": c.label, "kind": c.kind, "note": c.note,
                    "updated": c.updated, "usedBy": used, "complete": complete,
                })
            })
            .collect())
    }

    /// Adds or changes a credential. An empty value for a field means "keep what is stored".
    pub fn save(&self, id: Option<String>, label: &str, kind: &str, note: Option<String>, values: &BTreeMap<String, String>) -> Result<String, String> {
        let label = label.trim();
        if label.is_empty() {
            return Err("Give the credential a name.".into());
        }
        let kind = if kind == "login" { "login" } else { "secret" };
        let mut file = self.read_credentials();
        if file.credentials.iter().any(|c| c.label.eq_ignore_ascii_case(label) && Some(&c.id) != id.as_ref()) {
            return Err(format!("A credential called \"{label}\" already exists."));
        }
        let id = id.unwrap_or_else(|| new_credential_id(label));
        let existing = file.credentials.iter().position(|c| c.id == id);
        if existing.is_none() && fields(kind).iter().any(|f| values.get(*f).map(|v| v.is_empty()).unwrap_or(true)) {
            return Err(if kind == "login" { "Enter the username and the password.".into() } else { "Enter the value.".into() });
        }
        self.update_secrets(|map| {
            for field in fields(kind) {
                if let Some(value) = values.get(*field).filter(|v| !v.is_empty()) {
                    map.insert(pointer(&id, field), value.clone());
                }
            }
        })?;
        let entry = Credential {
            id: id.clone(),
            label: label.to_string(),
            kind: kind.to_string(),
            note: note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
            updated: now_millis(),
        };
        match existing {
            Some(at) => file.credentials[at] = entry,
            None => file.credentials.push(entry),
        }
        self.write_credentials(&file)?;
        Ok(id)
    }

    /// Removes a credential and its values. Settings still pointing at it then read as missing,
    /// with Light Code's ordinary "credential missing" message - the page lists them first.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let prefix = format!("credential:{id}#");
        self.update_secrets(|map| map.retain(|key, _| !key.starts_with(&prefix)))?;
        let mut file = self.read_credentials();
        file.credentials.retain(|c| c.id != id);
        self.write_credentials(&file)
    }

    /// Keys handed over by the VS Code extension: each becomes a saved credential named as VS Code
    /// names it, and the setting it belonged to points at it - so a codebase linked to that config
    /// works at once, and the key can be replaced here later for everything that uses it.
    pub fn import(&self, entries: &[(String, String, String)]) -> Result<Vec<String>, String> {
        let mut file = self.read_credentials();
        let mut labels = Vec::new();
        let mut assignments: Vec<(String, String, String)> = Vec::new();
        for (slot, label, value) in entries {
            if slot.is_empty() || value.is_empty() || slot.starts_with("credential:") {
                continue;
            }
            let id = match file.credentials.iter().find(|c| c.label.eq_ignore_ascii_case(label)) {
                Some(c) => c.id.clone(),
                None => {
                    let id = new_credential_id(label);
                    file.credentials.push(Credential {
                        id: id.clone(),
                        label: label.clone(),
                        kind: "secret".into(),
                        note: Some("Shared from VS Code".into()),
                        updated: now_millis(),
                    });
                    id
                }
            };
            if let Some(c) = file.credentials.iter_mut().find(|c| c.id == id) {
                c.updated = now_millis();
            }
            file.slot_labels.insert(slot.clone(), label.clone());
            assignments.push((slot.clone(), id, value.clone()));
            labels.push(label.clone());
        }
        self.update_secrets(|map| {
            for (slot, id, value) in &assignments {
                map.insert(pointer(id, "value"), value.clone());
                map.insert(slot.clone(), pointer(id, "value"));
            }
        })?;
        self.write_credentials(&file)?;
        Ok(labels)
    }
}

/// How many PBKDF2-SHA256 rounds turn an export passphrase into a key: OWASP's figure for that hash.
/// Slow on purpose - a stolen file is attacked offline, one guess per derivation.
const EXPORT_ROUNDS: u32 = 600_000;

/// A credential as it travels in an export file: everything needed to recreate it, values included.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Portable {
    pub label: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub values: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile {
    /// Names the format, so a wrong file is told apart from a wrong passphrase.
    sun_light_code_credentials: u8,
    kdf: String,
    rounds: u32,
    salt: String,
    iv: String,
    tag: String,
    data: String,
}

/// The minimum export passphrase. Twelve characters is where an offline guess at 600,000 rounds a
/// try stops being an afternoon's work for a laptop.
pub const MIN_PASSPHRASE: usize = 12;

fn passphrase_key(passphrase: &str, salt: &[u8], rounds: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, rounds, &mut key);
    key
}

impl Vault {
    /// Credentials sealed with a passphrase, for another machine or person. Not with this vault's
    /// key: that is bound to this Windows account and opens nowhere else, which is the point of it.
    pub fn export(&self, ids: &[String], passphrase: &str) -> Result<(String, usize), String> {
        if passphrase.chars().count() < MIN_PASSPHRASE {
            return Err(format!("Use a passphrase of at least {MIN_PASSPHRASE} characters."));
        }
        let file = self.read_credentials();
        let secrets = self.read_secrets()?;
        let items: Vec<Portable> = file
            .credentials
            .iter()
            .filter(|c| ids.contains(&c.id))
            .map(|c| Portable {
                label: c.label.clone(),
                kind: c.kind.clone(),
                note: c.note.clone(),
                values: fields(&c.kind)
                    .iter()
                    .filter_map(|f| secrets.get(&pointer(&c.id, f)).map(|v| (f.to_string(), v.clone())))
                    .collect(),
            })
            .collect();
        if items.is_empty() {
            return Err("Choose at least one credential to export.".into());
        }
        let mut salt = [0u8; 16];
        aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut OsRng, &mut salt);
        let key = passphrase_key(passphrase, &salt, EXPORT_ROUNDS);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let plain = serde_json::to_vec(&items).map_err(|e| e.to_string())?;
        let mut sealed = cipher.encrypt(&nonce, plain.as_slice()).map_err(|_| "Encryption failed.".to_string())?;
        let tag = sealed.split_off(sealed.len() - 16);
        let out = ExportFile {
            sun_light_code_credentials: 1,
            kdf: "pbkdf2-sha256".into(),
            rounds: EXPORT_ROUNDS,
            salt: base64_encode(&salt),
            iv: base64_encode(&nonce),
            tag: base64_encode(&tag),
            data: base64_encode(&sealed),
        };
        Ok((serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?, items.len()))
    }

    /// Opens an export file. Nothing is stored: the caller shows what is inside and asks first.
    pub fn open_export(text: &str, passphrase: &str) -> Result<Vec<Portable>, String> {
        let file: ExportFile = serde_json::from_str(text.trim_start_matches('﻿'))
            .map_err(|_| "This is not a Sun Code credentials file.".to_string())?;
        if file.sun_light_code_credentials != 1 || file.kdf != "pbkdf2-sha256" {
            return Err("This credentials file comes from a newer Sun Code; update this one first.".into());
        }
        if file.rounds < 100_000 {
            return Err("This credentials file is too weakly protected to trust.".into());
        }
        let salt = base64_decode(&file.salt).ok_or("The file is damaged.")?;
        let iv = base64_decode(&file.iv).filter(|v| v.len() == 12).ok_or("The file is damaged.")?;
        let mut sealed = base64_decode(&file.data).ok_or("The file is damaged.")?;
        sealed.extend(base64_decode(&file.tag).ok_or("The file is damaged.")?);
        let key = passphrase_key(passphrase, &salt, file.rounds);
        let plain = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
            .decrypt(Nonce::from_slice(&iv), sealed.as_slice())
            .map_err(|_| "Wrong passphrase - or the file was changed since it was exported.".to_string())?;
        serde_json::from_slice(&plain).map_err(|_| "The file's contents are damaged.".to_string())
    }

    /// Whether a credential with this name already exists here - an import replaces its value.
    pub fn has_label(&self, label: &str) -> bool {
        self.read_credentials().credentials.iter().any(|c| c.label.eq_ignore_ascii_case(label))
    }

    /// Stores imported credentials. One already here under the same name gets the imported value -
    /// the import preview said so, by name, before this ran.
    pub fn import_portable(&self, items: &[Portable]) -> Result<usize, String> {
        let mut count = 0;
        for item in items {
            let existing = self.read_credentials().credentials.into_iter().find(|c| c.label.eq_ignore_ascii_case(&item.label));
            let kind = existing.as_ref().map(|c| c.kind.clone()).unwrap_or_else(|| item.kind.clone());
            self.save(existing.map(|c| c.id), &item.label, &kind, item.note.clone(), &item.values)?;
            count += 1;
        }
        Ok(count)
    }
}

/// A short readable id: the name's letters and a few digits of time, unique on one machine.
fn new_credential_id(label: &str) -> String {
    let slug: String = label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("-");
    format!("{}-{:x}", if slug.is_empty() { "credential" } else { &slug }, now_millis() % 0xfffff)
}

/// Words for a secret-storage key nobody labelled: `profile:gw:apiKey` -> "Provider gw: API key".
pub fn describe_slot(key: &str) -> String {
    let parts: Vec<&str> = key.split(':').collect();
    match parts.as_slice() {
        ["profile", id, field] => format!("Provider {id}: {}", humanise(field)),
        ["search", id, field] => format!("Search connection {id}: {}", humanise(field)),
        ["python", "env", name] => format!("Python variable {name}"),
        ["s3", id, field] => format!("S3 {id}: {}", humanise(field)),
        [product, field] => format!("{}: {}", capitalise(product), humanise(field)),
        _ => key.to_string(),
    }
}

fn humanise(field: &str) -> String {
    match field {
        "apiKey" => "API key".into(),
        "clientSecret" => "client secret".into(),
        "passphrase" => "key passphrase".into(),
        other => other.replace('_', " ").to_lowercase(),
    }
}

fn capitalise(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

fn write_atomic(file: &PathBuf, text: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let temp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temp, text).map_err(|e| format!("Could not write {}: {e}", file.display()))?;
    for _ in 0..30 {
        if fs::rename(&temp, file).is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = fs::remove_file(&temp);
    Err(format!("{} is held open by another program; try again.", file.display()))
}

fn dpapi_protect(data: &[u8]) -> Option<Vec<u8>> {
    dpapi(data, true)
}

fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    dpapi(data, false)
}

fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if protect {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(name: &str) -> Paths {
        let root = std::env::temp_dir().join(format!("sun-vault-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        Paths { root }
    }

    #[test]
    fn a_saved_credential_is_sealed_and_listed_without_its_value() {
        let paths = temp_paths("save");
        let vault = Vault::open(&paths).unwrap();
        let mut values = BTreeMap::new();
        values.insert("username".to_string(), "alice".to_string());
        values.insert("password".to_string(), "hunter2".to_string());
        let id = vault.save(None, "Corp LDAP", "login", None, &values).unwrap();
        let raw = fs::read_to_string(paths.secrets_file()).unwrap();
        assert!(!raw.contains("hunter2") && !raw.contains("alice"));
        let listed = serde_json::to_string(&vault.list().unwrap()).unwrap();
        assert!(listed.contains("Corp LDAP") && !listed.contains("hunter2"));
        // Reopened from disk: the DPAPI-protected key opens what was sealed.
        let again = Vault::open(&paths).unwrap();
        assert_eq!(again.read_secrets().unwrap().get(&pointer(&id, "password")).map(String::as_str), Some("hunter2"));
    }

    #[test]
    fn an_import_points_the_setting_at_a_new_credential() {
        let paths = temp_paths("import");
        let vault = Vault::open(&paths).unwrap();
        let labels = vault
            .import(&[("profile:ds:apiKey".into(), "DeepSeek: API key".into(), "sk-1".into())])
            .unwrap();
        assert_eq!(labels, vec!["DeepSeek: API key".to_string()]);
        let secrets = vault.read_secrets().unwrap();
        let slot = secrets.get("profile:ds:apiKey").unwrap();
        assert!(slot.starts_with("credential:"));
        assert_eq!(secrets.get(slot).map(String::as_str), Some("sk-1"));
        let listed = serde_json::to_string(&vault.list().unwrap()).unwrap();
        assert!(listed.contains("\"usedBy\":[\"DeepSeek: API key\"]"));
    }

    #[test]
    fn a_plain_file_from_an_earlier_sun_is_sealed_with_its_keys_kept() {
        let paths = temp_paths("migrate");
        fs::create_dir_all(&paths.root).unwrap();
        fs::write(paths.secrets_file(), r#"{"profile:gw:apiKey":"sk-old"}"#).unwrap();
        let vault = Vault::open(&paths).unwrap();
        assert!(!fs::read_to_string(paths.secrets_file()).unwrap().contains("sk-old"));
        assert_eq!(vault.read_secrets().unwrap().get("profile:gw:apiKey").map(String::as_str), Some("sk-old"));
    }

    /// The same envelope the Node host writes: made by `apps/host/src/vaultCrypto.ts` with a fixed
    /// key and iv, so both sides are proven to agree on the format.
    #[test]
    fn opens_an_envelope_written_by_the_node_host() {
        let paths = temp_paths("compat");
        fs::create_dir_all(&paths.root).unwrap();
        let vault = Vault { key: [7u8; 32], secrets: paths.secrets_file(), credentials: paths.root.join("c.json") };
        fs::write(paths.secrets_file(), include_str!("../tests/node-envelope.json")).unwrap();
        assert_eq!(vault.read_secrets().unwrap().get("k").map(String::as_str), Some("from node"));
    }

    #[test]
    fn an_export_opens_only_with_its_passphrase_and_restores_the_values() {
        let paths = temp_paths("export");
        let vault = Vault::open(&paths).unwrap();
        let mut values = BTreeMap::new();
        values.insert("value".to_string(), "sk-exported".to_string());
        let id = vault.save(None, "DeepSeek", "secret", None, &values).unwrap();
        assert!(vault.export(&[id.clone()], "short").is_err());
        let (text, count) = vault.export(&[id], "correct horse battery").unwrap();
        assert_eq!(count, 1);
        assert!(!text.contains("sk-exported") && !text.contains("DeepSeek"));
        assert!(Vault::open_export(&text, "wrong passphrase!!").is_err());
        let items = Vault::open_export(&text, "correct horse battery").unwrap();
        // Into a different vault, as on another machine.
        let other = Vault::open(&temp_paths("export-other")).unwrap();
        assert_eq!(other.import_portable(&items).unwrap(), 1);
        assert!(serde_json::to_string(&other.list().unwrap()).unwrap().contains("DeepSeek"));
    }

    #[test]
    fn describes_settings_nobody_labelled() {
        assert_eq!(describe_slot("profile:gw:apiKey"), "Provider gw: API key");
        assert_eq!(describe_slot("python:env:DB_PASSWORD"), "Python variable DB_PASSWORD");
        assert_eq!(describe_slot("jira:token"), "Jira: token");
    }
}
