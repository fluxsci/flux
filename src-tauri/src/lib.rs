// FigForge Tauri backend.
//
// The frontend assembles a complete, self-contained SVG string for a figure
// (assets embedded as data URIs, fonts referenced by family). The Rust side is
// responsible only for turning that SVG into raster (PNG) or vector (PDF)
// output and writing it to disk. Keeping all SVG generation in the frontend
// means the editing surface and the export share one source of truth.

/// Render an SVG string to a PNG file at the given pixel scale (e.g. scale 4.0
/// for ~300dpi from a 96dpi document) and write it to `path`.
#[tauri::command]
fn export_png(svg: String, path: String, scale: f32) -> Result<(), String> {
    use resvg::{tiny_skia, usvg};

    let mut opt = usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();

    let tree = usvg::Tree::from_str(&svg, &opt).map_err(|e| e.to_string())?;

    let size = tree.size();
    let w = (size.width() * scale).ceil().max(1.0) as u32;
    let h = (size.height() * scale).ceil().max(1.0) as u32;

    let mut pixmap = tiny_skia::Pixmap::new(w, h)
        .ok_or_else(|| "failed to allocate output pixmap".to_string())?;

    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );

    let png = pixmap.encode_png().map_err(|e| e.to_string())?;
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(())
}

/// Convert an SVG string to a vector PDF and write it to `path`.
#[tauri::command]
fn export_pdf(svg: String, path: String) -> Result<(), String> {
    use svg2pdf::usvg;

    let mut opt = usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();

    let tree = usvg::Tree::from_str(&svg, &opt).map_err(|e| e.to_string())?;

    let pdf = svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    )
    .map_err(|e| e.to_string())?;

    std::fs::write(&path, pdf).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![export_png, export_pdf])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
