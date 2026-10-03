// The exe's icon and manifest. The manifest declares per-monitor DPI awareness (a blurry window on
// a laptop at 150% looks broken, not merely soft) and Windows 10/11 compatibility.
fn main() {
    println!("cargo:rerun-if-changed=app.rc");
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-changed=assets/sun.ico");
    embed_resource::compile("app.rc", embed_resource::NONE)
        .manifest_optional()
        .expect("embedding the icon and manifest failed");
}
