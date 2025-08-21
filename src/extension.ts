import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";

type TargetFormat = "webp" | "jpg" | "png";

const INPUT_FORMATS = [
  "png", "jpg", "jpeg", "webp", "gif", "tiff", "bmp", "avif", "heic", "heif", "svg"
];

let lastSelection: vscode.Uri[] = [];

export function activate(context: vscode.ExtensionContext) {
  const runSimple = (target: TargetFormat) => async (uri: vscode.Uri, uris: vscode.Uri[]) => {
    const files = collectSelection(uri, uris);
    if (!files.length) {
      vscode.window.showWarningMessage("No image(s) selected.");
      return;
    }
    await batch(files, async (u) => convertFile(u.fsPath, target));
  };

  const cmdWebp = vscode.commands.registerCommand("imageConverter.convertTo.webp", runSimple("webp"));
  const cmdJpg  = vscode.commands.registerCommand("imageConverter.convertTo.jpg",  runSimple("jpg"));
  const cmdPng  = vscode.commands.registerCommand("imageConverter.convertTo.png",  runSimple("png"));

  const cmdOpenPopup = vscode.commands.registerCommand("imageConverter.convertAndResize", async (uri: vscode.Uri, uris: vscode.Uri[]) => {
    const files = collectSelection(uri, uris);
    if (!files.length) {
      vscode.window.showWarningMessage("No image(s) selected.");
      return;
    }
    lastSelection = files;

    const panel = vscode.window.createWebviewPanel(
      "imageConverter.convertResize",
      "Convert & Resize Images",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = getWebviewHtml(files.length);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "submit") {
        const payload = msg.payload as { target: TargetFormat; maxWidth?: number; maxHeight?: number; quality?: number; };
        await batch(lastSelection, async (u) => convertFile(u.fsPath, payload.target, payload));
        panel.dispose();
      }
      if (msg?.type === "close") panel.dispose();
    });
  });

  context.subscriptions.push(cmdWebp, cmdJpg, cmdPng, cmdOpenPopup);
}

function collectSelection(uri?: vscode.Uri, uris?: vscode.Uri[]) {
  const arr = (uris && uris.length ? uris : uri ? [uri] : []).filter(Boolean) as vscode.Uri[];
  const unique = new Map(arr.map(u => [u.fsPath, u]));
  return [...unique.values()].filter(isSupportedImage);
}

function isSupportedImage(u: vscode.Uri) {
  const ext = path.extname(u.fsPath).slice(1).toLowerCase();
  return INPUT_FORMATS.includes(ext);
}

function isSvgPath(p: string) {
  return path.extname(p).toLowerCase() === ".svg";
}

async function batch(files: vscode.Uri[], runner: (u: vscode.Uri) => Promise<void>) {
  const failures: { file: string; error: string }[] = [];
  await Promise.all(files.map(async (f) => {
    try { await runner(f); }
    catch (e: any) { failures.push({ file: f.fsPath, error: String(e?.message ?? e) }); }
  }));
  vscode.window.showInformationMessage(`Converted ${files.length - failures.length} of ${files.length} image(s).`);
  if (failures.length) {
    const ch = vscode.window.createOutputChannel("Image Converter");
    ch.clear();
    ch.appendLine("Errors:");
    failures.forEach(x => ch.appendLine(`${x.file}: ${x.error}`));
    ch.show(true);
  }
}

async function convertFile(
  filePath: string,
  target: TargetFormat,
  opts?: { maxWidth?: number; maxHeight?: number; quality?: number }
) {
  const inputExt = path.extname(filePath).slice(1).toLowerCase();
  if (!INPUT_FORMATS.includes(inputExt)) throw new Error(`Unsupported format: .${inputExt}`);

  const base = path.basename(filePath, path.extname(filePath));
  const dir  = path.dirname(filePath);
  const outPath = path.join(dir, `${base}.${target}`);
  const isSvg = isSvgPath(filePath);

  let pipeline = sharp(filePath, { animated: true });

  // Resize (fit inside, keep aspect, no enlargement)
  if (opts?.maxWidth || opts?.maxHeight) {
    pipeline = pipeline.resize({
      width: opts?.maxWidth,
      height: opts?.maxHeight,
      fit: "inside",
      withoutEnlargement: true
    });
  }

  const q = clamp(opts?.quality ?? 82, 1, 100);

  switch (target) {
    case "webp": pipeline = pipeline.webp({ quality: q }); break;
    case "jpg":
      pipeline = pipeline.jpeg({ quality: q });
      if (isSvg) pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      break;
    case "png":
      pipeline = pipeline.png({ quality: q });
      break;
  }

  const buf = await pipeline.toBuffer();

  // Replace original: remove old file, write new with new extension (same base name)
  try { fs.unlinkSync(filePath); } catch {}
  fs.writeFileSync(outPath, buf);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function getWebviewHtml(selectedCount: number) {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Convert & Resize</title>
<style>
  :root { --bg:#0f1115; --panel:#161a22; --text:#e6e7e9; --muted:#a3a7b3; --accent:#4f7cff; --border:#2a2f3a; }
  body { background: var(--bg); color: var(--text); font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; margin:0; }
  .wrap { padding: 18px; }
  .card { background: var(--panel); border:1px solid var(--border); border-radius:16px; padding:18px; }
  h1 { margin:0 0 6px; font-size:18px; }
  .muted { color: var(--muted); margin: 0 0 12px; }
  .form-row { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
  label { font-size:12px; color: var(--muted); }
  input, select { width:100%; background:#12151b; color:var(--text); border:1px solid var(--border); border-radius:12px; padding:10px; outline:none; box-sizing:border-box; }
  input:focus, select:focus { border-color: var(--accent); }
  .actions { display:flex; gap:10px; margin-top:8px; }
  button { border:0; padding:10px 14px; border-radius:12px; cursor:pointer; }
  .primary { background: var(--accent); color:#fff; }
  .ghost { background: transparent; color: var(--muted); border:1px solid var(--border); }
  .hint { font-size:12px; color: var(--muted); margin-top:6px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Convert & Resize</h1>
      <p class="muted">Selected: ${selectedCount} image(s)</p>

      <div class="form-row">
        <label for="target">Target Format</label>
        <select id="target">
          <option value="webp">WebP</option>
          <option value="jpg">JPG</option>
          <option value="png">PNG</option>
        </select>
        <div class="hint">SVG → raster allowed. Other → SVG not supported.</div>
      </div>

      <div class="form-row">
        <label for="quality">Quality (1–100)</label>
        <input id="quality" type="number" min="1" max="100" value="82" />
      </div>

      <div class="form-row">
        <label for="maxWidth">Max Width (px)</label>
        <input id="maxWidth" type="number" min="1" placeholder="e.g., 1920" />
      </div>

      <div class="form-row">
        <label for="maxHeight">Max Height (px)</label>
        <input id="maxHeight" type="number" min="1" placeholder="e.g., 1080" />
      </div>

      <div class="actions">
        <button class="primary" id="convert">Convert</button>
        <button class="ghost" id="close">Close</button>
      </div>
      <div class="hint">Original files are replaced (same base name, new extension).</div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('convert').addEventListener('click', () => {
    const target = document.getElementById('target').value;
    const q = parseInt(document.getElementById('quality').value, 10);
    const w = parseInt(document.getElementById('maxWidth').value, 10);
    const h = parseInt(document.getElementById('maxHeight').value, 10);
    vscode.postMessage({
      type: 'submit',
      payload: {
        target,
        quality: Number.isFinite(q) ? q : undefined,
        maxWidth: Number.isFinite(w) ? w : undefined,
        maxHeight: Number.isFinite(h) ? h : undefined
      }
    });
  });
  document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
</script>
</body>
</html>`;
}

export function deactivate() {}
