// Collect notices from the actual locked Windows dependency graph, not the
// developer's entire Cargo cache. Extra build-time notices are harmless.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/collect-licenses.mjs <output-directory>');
const out = resolve(destination);
mkdirSync(out, { recursive: true });
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', join(root, 'src-tauri/Cargo.toml'), '--format-version', '1', '--locked', '--offline', '--filter-platform', 'x86_64-pc-windows-msvc'], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
const included = new Set(metadata.resolve.nodes.map(node => node.id));
const records = [];
function collect(source, folder, depth = 0) {
  const files = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!/^(licen[cs]e|copying|copyright|notice)([._-]|$)/i.test(entry.name)) continue;
    const from = join(source, entry.name);
    if (entry.isFile()) { mkdirSync(folder, { recursive: true }); copyFileSync(from, join(folder, entry.name)); files.push(entry.name); }
    else if (entry.isDirectory() && depth < 1) {
      mkdirSync(join(folder, entry.name), { recursive: true });
      for (const sub of readdirSync(from, { withFileTypes: true })) if (sub.isFile()) {
        copyFileSync(join(from, sub.name), join(folder, entry.name, sub.name)); files.push(`${entry.name}/${sub.name}`);
      }
    }
  }
  return files;
}
for (const pkg of metadata.packages) {
  if (!included.has(pkg.id) || !pkg.source) continue;
  const folder = `rust-${pkg.name}-${pkg.version}`;
  const source = dirname(pkg.manifest_path);
  const files = collect(source, join(out, folder));
  if (pkg.license_file) {
    const file = resolve(source, pkg.license_file);
    if (existsSync(file)) { mkdirSync(join(out, folder), { recursive: true }); copyFileSync(file, join(out, folder, 'declared-license.txt')); files.push('declared-license.txt'); }
  }
  records.push({ ecosystem: 'Rust', name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, directory: folder, files });
}
for (const name of ['react', 'react-dom', 'scheduler', '@tauri-apps/api']) {
  const source = join(root, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const folder = `js-${name.replaceAll('/', '-')}-${pkg.version}`;
  records.push({ ecosystem: 'JavaScript', name, version: pkg.version, license: pkg.license, directory: folder, files: collect(source, join(out, folder)) });
}
const bloub = join(root, 'renderer/src/third-party/bloub');
records.push({ ecosystem: 'vendored', name: 'bloub', directory: 'bloub', files: collect(bloub, join(out, 'bloub')) });
writeFileSync(join(out, 'DEPENDENCIES.json'), JSON.stringify(records, null, 2));
writeFileSync(join(out, 'README.txt'), 'Third-party notices collected from locked dependencies for the Windows x64 build.\nIncludes build-time dependencies; inclusion does not claim each is dynamically shipped.\nSee DEPENDENCIES.json and each package directory. System Windows/WebView2 components are not bundled.\n');
console.log(`Collected notices for ${records.length} dependencies; ${records.filter(r => !r.files.length).length} packages declare a license but ship no root notice file.`);
