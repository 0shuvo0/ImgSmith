import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";

type TargetFormat = "webp" | "jpg" | "png";

const INPUT_FORMATS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "tiff",
  "bmp",
  "avif",
  "heic",
  "heif",
  "svg",
  "dng",
];

let lastSelection: vscode.Uri[] = [];

export function activate(context: vscode.ExtensionContext) {
  const runSimple =
    (target: TargetFormat) => async (uri: vscode.Uri, uris: vscode.Uri[]) => {
      const files = collectSelection(uri, uris);
      if (!files.length) {
        vscode.window.showWarningMessage("No image(s) selected.");
        return;
      }
      await batch(files, async (u) => convertFile(u.fsPath, target));
    };

  const cmdWebp = vscode.commands.registerCommand(
    "imageConverter.convertTo.webp",
    runSimple("webp")
  );
  const cmdJpg = vscode.commands.registerCommand(
    "imageConverter.convertTo.jpg",
    runSimple("jpg")
  );
  const cmdPng = vscode.commands.registerCommand(
    "imageConverter.convertTo.png",
    runSimple("png")
  );

  const cmdOpenPopup = vscode.commands.registerCommand(
    "imageConverter.convertAndResize",
    async (uri: vscode.Uri, uris: vscode.Uri[]) => {
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
          const payload = msg.payload as {
            target: TargetFormat;
            maxWidth?: number;
            maxHeight?: number;
            quality?: number;
          };
          await batch(lastSelection, async (u) =>
            convertFile(u.fsPath, payload.target, payload)
          );
          panel.dispose();
        }
        if (msg?.type === "close") {
          panel.dispose();
        }
      });
    }
  );

  const cmdGenerateFavicon = vscode.commands.registerCommand(
    "imageConverter.generateFavicon",
    async (uri: vscode.Uri, uris: vscode.Uri[]) => {
      const files = collectSelection(uri, uris);
      if (!files.length) {
        vscode.window.showWarningMessage("No image(s) selected.");
        return;
      }
      lastSelection = files;

      const panel = vscode.window.createWebviewPanel(
        "imageConverter.generateFavicon",
        "Generate Favicon Set",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.webview.html = getFaviconWebviewHtml(files.length);

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === "submit") {
          const payload = msg.payload as {
            sizes: number[];
            format: "png" | "ico";
            quality?: number;
          };
          await batch(lastSelection, async (u) =>
            generateFaviconSet(u.fsPath, payload)
          );
          panel.dispose();
        }
        if (msg?.type === "close") {
          panel.dispose();
        }
      });
    }
  );

  context.subscriptions.push(
    cmdWebp,
    cmdJpg,
    cmdPng,
    cmdOpenPopup,
    cmdGenerateFavicon
  );
}

function collectSelection(uri?: vscode.Uri, uris?: vscode.Uri[]) {
  const arr = (uris && uris.length ? uris : uri ? [uri] : []).filter(
    Boolean
  ) as vscode.Uri[];
  const unique = new Map(arr.map((u) => [u.fsPath, u]));
  return [...unique.values()].filter(isSupportedImage);
}

function isSupportedImage(u: vscode.Uri) {
  const ext = path.extname(u.fsPath).slice(1).toLowerCase();
  return INPUT_FORMATS.includes(ext);
}

function isSvgPath(p: string) {
  return path.extname(p).toLowerCase() === ".svg";
}

async function batch(
  files: vscode.Uri[],
  runner: (u: vscode.Uri) => Promise<void>
) {
  const failures: { file: string; error: string }[] = [];
  await Promise.all(
    files.map(async (f) => {
      try {
        await runner(f);
      } catch (e: any) {
        failures.push({ file: f.fsPath, error: String(e?.message ?? e) });
      }
    })
  );
  vscode.window.showInformationMessage(
    `Converted ${files.length - failures.length} of ${files.length} image(s).`
  );
  if (failures.length) {
    const ch = vscode.window.createOutputChannel("Image Converter");
    ch.clear();
    ch.appendLine("Errors:");
    failures.forEach((x) => ch.appendLine(`${x.file}: ${x.error}`));
    ch.show(true);
  }
}

async function convertFile(
  filePath: string,
  target: TargetFormat,
  opts?: { maxWidth?: number; maxHeight?: number; quality?: number }
) {
  const inputExt = path.extname(filePath).slice(1).toLowerCase();
  if (!INPUT_FORMATS.includes(inputExt)) {
    throw new Error(`Unsupported format: .${inputExt}`);
  }

  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const outPath = path.join(dir, `${base}.${target}`);
  const isSvg = isSvgPath(filePath);

  let pipeline = sharp(filePath, { animated: true });

  // Resize (fit inside, keep aspect, no enlargement)
  if (opts?.maxWidth || opts?.maxHeight) {
    pipeline = pipeline.resize({
      width: opts?.maxWidth,
      height: opts?.maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const q = clamp(opts?.quality ?? 82, 1, 100);

  switch (target) {
    case "webp":
      pipeline = pipeline.webp({ quality: q });
      break;
    case "jpg":
      pipeline = pipeline.jpeg({ quality: q });
      if (isSvg) {
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      }
      break;
    case "png":
      pipeline = pipeline.png({ quality: q });
      break;
  }

  const buf = await pipeline.toBuffer();

  // Replace original: remove old file, write new with new extension (same base name)
  try {
    fs.unlinkSync(filePath);
  } catch {}
  fs.writeFileSync(outPath, buf);
}

async function generateFaviconSet(
  filePath: string,
  opts: { sizes: number[]; format: "png" | "ico"; quality?: number }
) {
  const inputExt = path.extname(filePath).slice(1).toLowerCase();
  if (!INPUT_FORMATS.includes(inputExt)) {
    throw new Error(`Unsupported format: .${inputExt}`);
  }

  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const faviconDir = path.join(dir, "favicons");

  // Create favicons directory if it doesn't exist
  if (!fs.existsSync(faviconDir)) {
    fs.mkdirSync(faviconDir, { recursive: true });
  }

  const q = clamp(opts?.quality ?? 90, 1, 100);
  const isSvg = isSvgPath(filePath);

  // Generate each favicon size
  for (const size of opts.sizes) {
    let pipeline = sharp(filePath, { animated: false });

    // Resize to exact dimensions, crop if needed to maintain square aspect
    pipeline = pipeline.resize({
      width: size,
      height: size,
      fit: "cover",
      position: "center",
    });

    // Apply format-specific settings
    if (opts.format === "png") {
      pipeline = pipeline.png({ quality: q, compressionLevel: 9 });
    } else {
      // For ICO format, we'll generate PNG and let the user know
      pipeline = pipeline.png({ quality: q, compressionLevel: 9 });
    }

    // Handle SVG background for non-transparent formats
    if (isSvg && opts.format !== "png") {
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    const buf = await pipeline.toBuffer();
    const fileName = `favicon-${size}x${size}.${
      opts.format === "ico" ? "png" : opts.format
    }`;
    const outPath = path.join(faviconDir, fileName);

    fs.writeFileSync(outPath, buf);
  }

  // Generate a standard favicon.ico (16x16) for web compatibility
  if (opts.sizes.includes(16)) {
    const pipeline16 = sharp(filePath, { animated: false })
      .resize({ width: 16, height: 16, fit: "cover", position: "center" })
      .png({ quality: q, compressionLevel: 9 });

    if (isSvg) {
      pipeline16.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    const buf16 = await pipeline16.toBuffer();
    fs.writeFileSync(path.join(faviconDir, "favicon.ico"), buf16);
  }
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

function getFaviconWebviewHtml(selectedCount: number) {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Generate Favicon Set</title>
<style>
  :root { --bg:#0f1115; --panel:#161a22; --text:#e6e7e9; --muted:#a3a7b3; --accent:#4f7cff; --border:#2a2f3a; --success:#22c55e; }
  body { background: var(--bg); color: var(--text); font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; margin:0; }
  .wrap { padding: 18px; }
  .card { background: var(--panel); border:1px solid var(--border); border-radius:16px; padding:18px; }
  h1 { margin:0 0 6px; font-size:18px; }
  .muted { color: var(--muted); margin: 0 0 12px; }
  .form-row { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
  label { font-size:12px; color: var(--muted); }
  input, select { width:100%; background:#12151b; color:var(--text); border:1px solid var(--border); border-radius:12px; padding:10px; outline:none; box-sizing:border-box; }
  input:focus, select:focus { border-color: var(--accent); }
  .checkbox-group { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .checkbox-item { display: flex; align-items: center; gap: 6px; background: #12151b; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: all 0.2s; }
  .checkbox-item:hover { border-color: var(--accent); }
  .checkbox-item.selected { border-color: var(--success); background: rgba(34, 197, 94, 0.1); }
  .checkbox-item input[type="checkbox"] { margin: 0; }
  .checkbox-item label { margin: 0; cursor: pointer; font-size: 11px; }
  .actions { display:flex; gap:10px; margin-top:8px; }
  button { border:0; padding:10px 14px; border-radius:12px; cursor:pointer; }
  .primary { background: var(--accent); color:#fff; }
  .ghost { background: transparent; color: var(--muted); border:1px solid var(--border); }
  .hint { font-size:12px; color: var(--muted); margin-top:6px; }
  .preset-buttons { display: flex; gap: 6px; margin-top: 6px; }
  .preset-btn { background: #1a1f2e; border: 1px solid var(--border); color: var(--muted); padding: 4px 8px; border-radius: 6px; font-size: 11px; cursor: pointer; }
  .preset-btn:hover { border-color: var(--accent); color: var(--text); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>🖼️ Generate Favicon Set</h1>
      <p class="muted">Selected: ${selectedCount} image(s)</p>

      <div class="form-row">
        <label>Favicon Sizes (px)</label>
        <div class="preset-buttons">
          <button class="preset-btn" onclick="selectPreset('web')">Web Standard</button>
          <button class="preset-btn" onclick="selectPreset('all')">All Sizes</button>
          <button class="preset-btn" onclick="selectPreset('clear')">Clear All</button>
        </div>
        <div class="checkbox-group">
          <div class="checkbox-item" onclick="toggleSize(16)">
            <input type="checkbox" id="size16" value="16" checked>
            <label for="size16">16×16</label>
          </div>
          <div class="checkbox-item" onclick="toggleSize(32)">
            <input type="checkbox" id="size32" value="32" checked>
            <label for="size32">32×32</label>
          </div>
          <div class="checkbox-item" onclick="toggleSize(48)">
            <input type="checkbox" id="size48" value="48" checked>
            <label for="size48">48×48</label>
          </div>
          <div class="checkbox-item" onclick="toggleSize(64)">
            <input type="checkbox" id="size64" value="64">
            <label for="size64">64×64</label>
          </div>
          <div class="checkbox-item" onclick="toggleSize(128)">
            <input type="checkbox" id="size128" value="128">
            <label for="size128">128×128</label>
          </div>
          <div class="checkbox-item" onclick="toggleSize(256)">
            <input type="checkbox" id="size256" value="256">
            <label for="size256">256×256</label>
          </div>
        </div>
        <div class="hint">Standard web favicons: 16×16, 32×32, 48×48. Larger sizes for app icons.</div>
      </div>

      <div class="form-row">
        <label for="format">Output Format</label>
        <select id="format">
          <option value="png">PNG (recommended)</option>
          <option value="ico">ICO (legacy)</option>
        </select>
        <div class="hint">PNG is modern and widely supported. ICO for older browser compatibility.</div>
      </div>

      <div class="form-row">
        <label for="quality">Quality (1–100)</label>
        <input id="quality" type="number" min="1" max="100" value="90" />
        <div class="hint">Higher quality for crisp favicon appearance.</div>
      </div>

      <div class="actions">
        <button class="primary" id="generate">🚀 Generate Favicons</button>
        <button class="ghost" id="close">Close</button>
      </div>
      <div class="hint">Favicons will be saved in a "favicons" folder next to your image.</div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  
  function toggleSize(size) {
    const checkbox = document.getElementById('size' + size);
    const item = checkbox.closest('.checkbox-item');
    checkbox.checked = !checkbox.checked;
    updateCheckboxStyle(item, checkbox.checked);
  }
  
  function updateCheckboxStyle(item, checked) {
    if (checked) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
  }
  
  function selectPreset(preset) {
    const checkboxes = document.querySelectorAll('.checkbox-item input[type="checkbox"]');
    const items = document.querySelectorAll('.checkbox-item');
    
    checkboxes.forEach((cb, index) => {
      const size = parseInt(cb.value);
      let shouldCheck = false;
      
      if (preset === 'web') {
        shouldCheck = [16, 32, 48].includes(size);
      } else if (preset === 'all') {
        shouldCheck = true;
      }
      
      cb.checked = shouldCheck;
      updateCheckboxStyle(items[index], shouldCheck);
    });
  }
  
  // Initialize checkbox styles
  document.querySelectorAll('.checkbox-item').forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    updateCheckboxStyle(item, checkbox.checked);
  });
  
  document.getElementById('generate').addEventListener('click', () => {
    const selectedSizes = Array.from(document.querySelectorAll('.checkbox-item input[type="checkbox"]:checked'))
      .map(cb => parseInt(cb.value));
    
    if (selectedSizes.length === 0) {
      alert('Please select at least one favicon size.');
      return;
    }
    
    const format = document.getElementById('format').value;
    const quality = parseInt(document.getElementById('quality').value, 10);
    
    vscode.postMessage({
      type: 'submit',
      payload: {
        sizes: selectedSizes,
        format: format,
        quality: Number.isFinite(quality) ? quality : 90
      }
    });
  });
  
  document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
</script>
</body>
</html>`;
}

export function deactivate() {}
