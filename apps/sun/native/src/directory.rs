//! Who a login name is, from the company directory: display name, email, department, title, office.
//!
//! For the usage dashboard (Settings → Usage), so people and authors show as names and teams rather
//! than logins. Windows' own LDAP client (wldap32) bound as the signed-in user - the same Kerberos
//! sign-in that already reaches the domain controller at logon - so there is no credential to store,
//! no Python and no HTTP. Read only: a search and nothing else.
//!
//! This is the second recorded exception to "all network traffic through the one HttpClient"
//! (CLAUDE.md §3): directory entries, from the machine's own domain, only while usage collection is on.
//! `usage/directory.ts` runs the same query through PowerShell when this helper is absent.

use serde_json::{json, Map, Value};

/// RFC 4515: a name inside a filter cannot end the clause or add a wildcard.
pub fn escape_filter(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\5c"),
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\0' => out.push_str("\\00"),
            other => out.push(other),
        }
    }
    out
}

/// `DOMAIN\user` and `user@domain` both mean `user` to the directory's account name.
fn account_part(name: &str) -> &str {
    name.rsplit('\\').next().unwrap_or(name)
}

/// One OR clause per name: account name, sign-in name, email or display name.
pub fn filter_for(names: &[String]) -> String {
    let mut clauses = String::new();
    for name in names {
        let account = escape_filter(account_part(name));
        let whole = escape_filter(name);
        clauses.push_str(&format!("(sAMAccountName={account})(userPrincipalName={whole})(mail={whole})(displayName={whole})"));
    }
    format!("(&(objectCategory=person)(objectClass=user)(|{clauses}))")
}

/// Which asked-for name an entry answers, compared without case.
pub fn matches(entry: &Map<String, Value>, name: &str) -> bool {
    let wanted = name.to_lowercase();
    let account = account_part(name).to_lowercase();
    let field = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_lowercase);
    field("sAMAccountName").map_or(false, |v| v == account)
        || field("userPrincipalName").map_or(false, |v| v == wanted || v.split('@').next() == Some(account.as_str()))
        || field("mail").map_or(false, |v| v == wanted)
        || field("displayName").map_or(false, |v| v == wanted)
}

/// The fields the dashboard uses, under its own names.
pub fn person(entry: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for (from, to) in [
        ("displayName", "displayName"),
        ("mail", "email"),
        ("department", "department"),
        ("title", "title"),
        ("physicalDeliveryOfficeName", "location"),
        ("company", "company"),
        ("sAMAccountName", "account"),
    ] {
        if let Some(value) = entry.get(from).and_then(Value::as_str).filter(|v| !v.is_empty()) {
            out.insert(to.into(), json!(value.chars().take(200).collect::<String>()));
        }
    }
    Value::Object(out)
}

pub const ATTRIBUTES: [&str; 8] = ["sAMAccountName", "userPrincipalName", "mail", "displayName", "department", "title", "physicalDeliveryOfficeName", "company"];

pub fn run(r: &Value) -> Result<Value, String> {
    let names: Vec<String> = r
        .get("names")
        .and_then(Value::as_array)
        .ok_or("`names` must be a list.")?
        .iter()
        .filter_map(|v| v.as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty() && n.len() <= 200)
        .map(str::to_string)
        .take(500)
        .collect();
    if names.is_empty() {
        return Ok(json!({ "ok": true, "available": true, "people": {}, "notFound": [] }));
    }
    match imp::search(&names) {
        Ok(entries) => {
            let mut people = Map::new();
            let mut not_found = Vec::new();
            for name in &names {
                match entries.iter().find(|entry| matches(entry, name)) {
                    Some(entry) => {
                        people.insert(name.clone(), person(entry));
                    }
                    None => not_found.push(json!(name)),
                }
            }
            Ok(json!({ "ok": true, "available": true, "people": people, "notFound": not_found }))
        }
        Err(reason) => Ok(json!({ "ok": true, "available": false, "reason": reason })),
    }
}

#[cfg(not(windows))]
mod imp {
    use serde_json::{Map, Value};
    pub fn search(_names: &[String]) -> Result<Vec<Map<String, Value>>, String> {
        Err("The company directory is read through Windows; this is not Windows.".into())
    }
}

#[cfg(windows)]
mod imp {
    use super::{filter_for, ATTRIBUTES};
    use serde_json::{json, Map, Value};
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Networking::Ldap::*;

    /// `LDAP_AUTH_NEGOTIATE`: Kerberos or NTLM as the signed-in user. Not exported by windows-sys.
    const AUTH_NEGOTIATE: u32 = 0x0486;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_wide(p: *const u16) -> String {
        let mut n = 0;
        while *p.add(n) != 0 {
            n += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
    }

    unsafe fn describe(code: u32) -> String {
        let text = ldap_err2stringW(code);
        if text.is_null() { format!("LDAP error {code}") } else { format!("{} (LDAP {code})", from_wide(text)) }
    }

    struct Connection(*mut LDAP);
    impl Drop for Connection {
        fn drop(&mut self) {
            unsafe {
                ldap_unbind(self.0);
            }
        }
    }

    struct Results(*mut LDAPMessage);
    impl Drop for Results {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    ldap_msgfree(self.0);
                }
            }
        }
    }

    unsafe fn first_value(ld: *mut LDAP, entry: *mut LDAPMessage, attribute: &str) -> Option<String> {
        let name = wide(attribute);
        let values = ldap_get_valuesW(ld, entry, name.as_ptr());
        if values.is_null() {
            return None;
        }
        let first = *values;
        let value = if first.is_null() { None } else { Some(from_wide(first)) };
        ldap_value_freeW(values as *const windows_sys::core::PCWSTR);
        value
    }

    unsafe fn query(ld: *mut LDAP, base: &str, scope: u32, filter: &str, attributes: &[&str], limit: u32) -> Result<Vec<Map<String, Value>>, String> {
        let base = wide(base);
        let filter = wide(filter);
        let names: Vec<Vec<u16>> = attributes.iter().map(|a| wide(a)).collect();
        let mut pointers: Vec<*const u16> = names.iter().map(|n| n.as_ptr()).collect();
        pointers.push(null());
        let mut timeout = LDAP_TIMEVAL { tv_sec: 15, tv_usec: 0 };
        let mut raw: *mut LDAPMessage = null_mut();
        let code = ldap_search_ext_sW(ld, base.as_ptr(), scope, filter.as_ptr(), pointers.as_ptr(), 0, null(), null(), &mut timeout, limit, &mut raw);
        let results = Results(raw);
        // 4 is "size limit exceeded": the entries that did arrive are still good.
        if code != 0 && code != 4 {
            return Err(describe(code));
        }
        let mut entries = Vec::new();
        let mut entry = ldap_first_entry(ld, results.0);
        while !entry.is_null() {
            let mut map = Map::new();
            for attribute in attributes {
                if let Some(value) = first_value(ld, entry, attribute) {
                    map.insert((*attribute).to_string(), json!(value));
                }
            }
            entries.push(map);
            entry = ldap_next_entry(ld, entry);
        }
        Ok(entries)
    }

    pub fn search(names: &[String]) -> Result<Vec<Map<String, Value>>, String> {
        unsafe {
            // No host: "serverless binding", the domain controller of the domain this machine is in.
            let ld = ldap_initW(null(), LDAP_PORT);
            if ld.is_null() {
                return Err("This machine has no directory to ask - it does not appear to be on a company domain.".into());
            }
            let connection = Connection(ld);
            let version: u32 = 3;
            ldap_set_optionW(connection.0, LDAP_OPT_PROTOCOL_VERSION as i32, &version as *const u32 as *const core::ffi::c_void);
            // LDAP_OPT_OFF is a null pointer: never chase a referral to some other server.
            ldap_set_optionW(connection.0, LDAP_OPT_REFERRALS as i32, null());
            let mut timeout = LDAP_TIMEVAL { tv_sec: 10, tv_usec: 0 };
            let code = ldap_connect(connection.0, &mut timeout);
            if code != 0 {
                return Err(format!("No domain controller answered - this machine may not be on a company domain, or is off the network: {}", describe(code)));
            }
            let code = ldap_bind_sW(connection.0, null(), null(), AUTH_NEGOTIATE);
            if code != 0 {
                return Err(format!("The directory refused the signed-in user: {}", describe(code)));
            }
            let root = query(connection.0, "", LDAP_SCOPE_BASE, "(objectClass=*)", &["defaultNamingContext"], 1)?;
            let base = root
                .first()
                .and_then(|entry| entry.get("defaultNamingContext"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or("The directory did not say where its people are (no defaultNamingContext).")?;
            let mut found = Vec::new();
            for chunk in names.chunks(20) {
                found.extend(query(connection.0, &base, LDAP_SCOPE_SUBTREE, &filter_for(chunk), &ATTRIBUTES, 200)?);
            }
            Ok(found)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_cannot_change_the_filter() {
        assert_eq!(escape_filter("a*)(objectClass=*"), "a\\2a\\29\\28objectClass=\\2a");
        let filter = filter_for(&["DOMAIN\\ann".to_string()]);
        assert!(filter.contains("(sAMAccountName=ann)"));
        assert!(filter.contains("(userPrincipalName=DOMAIN\\5cann)"));
    }

    #[test]
    fn matches_an_entry_by_account_sign_in_mail_or_name() {
        let entry: Map<String, Value> = serde_json::from_value(json!({ "sAMAccountName": "AEX1234", "userPrincipalName": "aex1234@corp.example", "mail": "ann@corp.example", "displayName": "Ann Example", "department": "Rates", "physicalDeliveryOfficeName": "London" })).unwrap();
        for name in ["aex1234", "CORP\\aex1234", "ann@corp.example", "Ann Example", "aex1234@corp.example"] {
            assert!(matches(&entry, name), "{name}");
        }
        assert!(!matches(&entry, "bob"));
        assert_eq!(person(&entry), json!({ "displayName": "Ann Example", "email": "ann@corp.example", "department": "Rates", "location": "London", "account": "AEX1234" }));
    }

    #[test]
    fn off_a_domain_it_says_so_instead_of_failing() {
        // This development machine is not on a domain: the answer must be "unavailable", with a reason.
        let answer = run(&json!({ "names": ["somebody"] })).unwrap();
        assert_eq!(answer["ok"], true);
        if answer["available"] == false {
            assert!(answer["reason"].as_str().unwrap().len() > 10);
        }
    }
}
