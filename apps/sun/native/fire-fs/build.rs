// The icon and manifest fire-fs.exe had while it was a second binary of Fire Code's package: the
// manifest sets the UTF-8 code page, which the C libraries inside (SQLite, the LDAP client) rely on for
// non-ASCII names. Same icon and manifest files as the window, named from here.
fn main() {
    println!("cargo:rerun-if-changed=app.rc");
    println!("cargo:rerun-if-changed=../app.manifest");
    println!("cargo:rerun-if-changed=../assets/sun.ico");
    embed_resource::compile("app.rc", embed_resource::NONE)
        .manifest_optional()
        .expect("embedding the icon and manifest failed");
}
