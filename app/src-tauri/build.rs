use std::path::PathBuf;

fn main() {
    assert_version_lockstep();
    tauri_build::build()
}

/// Lockstep versioning. One version, one tag, one number, written by hand in
/// exactly one file.
///
/// The repo root `package.json` is that file. `tauri.conf.json` already reads
/// it through `"version": "../../package.json"`, so the installer name, the
/// NSIS product version and the updater's comparison all come from it for free.
/// `Cargo.toml` is the one number nothing else reads at build time, and
/// cosmetic drift is still drift: a crate that claims a different version than
/// the product it builds is a lie waiting for whoever reads it.
///
/// This is that check, moved off CI and onto every build, because a mismatch
/// found by a contributor in two seconds is cheaper than one found by a release
/// tag. `cargo check`, `cargo build`, `tauri dev` and `tauri build` all run it.
fn assert_version_lockstep() {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR")
            .expect("cargo always sets CARGO_MANIFEST_DIR for a build script"),
    );
    // app/src-tauri -> app -> repo root
    let source = manifest_dir.join("..").join("..").join("package.json");
    let shown = source.display().to_string();

    println!("cargo:rerun-if-changed={shown}");

    let raw = match std::fs::read_to_string(&source) {
        Ok(raw) => raw,
        // A crate built outside this repo (vendored, or extracted from a
        // .crate) has no root manifest to compare against. That is a missing
        // source, not a mismatch, so say so and let the build through.
        Err(err) => {
            println!("cargo:warning=version lockstep unchecked: could not read {shown} ({err})");
            return;
        }
    };

    let root: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("the repo root package.json is not valid JSON: {err}"));

    let published = root
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| {
            panic!(
                "the repo root package.json has no string \"version\" field, \
                 and it is the source of truth for this app's version"
            )
        });

    let crate_version = std::env::var("CARGO_PKG_VERSION")
        .expect("cargo always sets CARGO_PKG_VERSION for a build script");

    if published != crate_version {
        panic!(
            "\n\
             version lockstep is broken.\n\
             \n  package.json (the source of truth) says  {published}\
             \n  app/src-tauri/Cargo.toml says            {crate_version}\
             \n\
             \nLockstep versioning: one version number, written by hand in package.json only.\
             \nFix: set [package] version in app/src-tauri/Cargo.toml to {published}.\
             \nDo not fix it the other way round unless you also meant to change what npm publishes.\n"
        );
    }
}
