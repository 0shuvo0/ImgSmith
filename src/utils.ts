import * as path from "path";
import * as fs from "fs/promises";
import * as vscode from "vscode";
import sharp from "sharp";

export type TargetFormat = "webp" | "jpg" | "png";

const READABLE_FORMATS = [
  "png","jpg","jpeg","webp","gif","tiff","bmp","avif","heic","heif","svg","dng"
];


export function isImageFile(uri: vscode.Uri) {
  const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
  return READABLE_FORMATS.includes(ext);
}

export function isSvg(uri: vscode.Uri) {
  return path.extname(uri.fsPath).toLowerCase() === ".svg";
}

export function baseNameNoExt(fsPath: string) {
  return path.basename(fsPath, path.extname(fsPath));
}

export async function convertSingleFile(
  file: vscode.Uri,
  target: TargetFormat,
  opts?: { maxWidth?: number; maxHeight?: number; quality?: number }
) {
  const inputPath = file.fsPath;
  const dir = path.dirname(inputPath);
  const base = baseNameNoExt(inputPath);

  // Enforce: Non-SVG cannot convert to SVG (we never expose SVG as a target)
  // SVG → raster allowed.
  const isSvgInput = path.extname(inputPath).toLowerCase() === ".svg";

  // Load
  let pipeline = sharp(inputPath, { animated: true });

  // Resize (maintain aspect ratio; fit inside box if provided)
  if (opts?.maxWidth || opts?.maxHeight) {
    pipeline = pipeline.resize({
      width: opts?.maxWidth,
      height: opts?.maxHeight,
      fit: "inside",
      withoutEnlargement: true
    });
  }

  // Format + quality
  const q = Math.max(1, Math.min(100, opts?.quality ?? 80));

  switch (target) {
    case "webp":
      pipeline = pipeline.webp({ quality: q });
      break;
    case "jpg":
      // If input is SVG, flatten with white background
      pipeline = pipeline.jpeg({ quality: q });
      if (isSvgInput) {pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });}
      break;
    case "png":
      pipeline = pipeline.png({ quality: q });
      break;
  }

  const outPath = path.join(dir, `${base}.${target}`);

  const data = await pipeline.toBuffer();

  // Replace original: delete old file, write new (same base name, new extension)
  // This aligns the extension with actual content to avoid mismatches.
  try {
    await fs.unlink(inputPath);
  } catch {
    // ignore if it didn't exist or locked; we'll still write new file
  }
  await fs.writeFile(outPath, data);

  return outPath;
}

export function pickSelectedResources(arg: any): vscode.Uri[] {
  // VS Code passes the clicked resource as the first arg, and the rest of the selection via explorer context state
  // Fallback to active editor if needed
  const selected = (vscode as any).window.activeTextEditor?.document?.uri ? [ (vscode as any).window.activeTextEditor.document.uri ] : [];
  const fromArg = arg && arg instanceof vscode.Uri ? [arg] : [];
  const multi = (vscode as any).window?.activeExplorerContext?.selection as vscode.Uri[] | undefined;

  const merged = new Map<string, vscode.Uri>();
  [...fromArg, ...(multi || []), ...selected].forEach(u => {
    if (u && isImageFile(u)) {merged.set(u.fsPath, u);}
  });
  return [...merged.values()];
}

export async function handleBatch(
  files: vscode.Uri[],
  runner: (u: vscode.Uri) => Promise<string>
) {
  const successes: string[] = [];
  const failures: { file: string; error: string }[] = [];

  await Promise.all(files.map(async (f) => {
    try {
      const out = await runner(f);
      successes.push(out);
    } catch (e: any) {
      failures.push({ file: f.fsPath, error: String(e?.message ?? e) });
    }
  }));

  if (successes.length) {
    vscode.window.showInformationMessage(`Converted ${successes.length} image(s).`);
  }
  if (failures.length) {
    const detail = failures.map(x => `${x.file}: ${x.error}`).join("\n");
    vscode.window.showErrorMessage(`Failed to convert ${failures.length} image(s). See Output > Image Converter.`, { modal: false });
    const ch = vscode.window.createOutputChannel("Image Converter");
    ch.clear();
    ch.appendLine("Conversion errors:");
    ch.appendLine(detail);
    ch.show(true);
  }
}
