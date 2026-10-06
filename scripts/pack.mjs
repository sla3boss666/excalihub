// Construit release/excalifree-<version>.zip, le paquet à envoyer sur le Chrome Web Store.
// Sans dépendance : l'archive zip est écrite ici (deflate de zlib), donc le script
// fonctionne aussi sous Windows, où les commandes zip et mkdir -p n'existent pas.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Contenu du paquet : uniquement ce que l'extension charge, plus les licences
const INCLUDE = [
  "manifest.json",
  "picker.html",
  "src/content.css",
  "icons",
  "dist",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "PRIVACY.md",
];
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function collect(path) {
  const full = join(root, path);
  if (!existsSync(full)) throw new Error(`Fichier manquant : ${path}`);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full)
    .filter((name) => !IGNORED.has(name))
    .flatMap((name) => collect(`${path}/${name}`));
}

const files = [...new Set(INCLUDE.flatMap(collect))].sort();

// Tous les fichiers cités par le manifeste (et picker.html, ouvert par background.js) doivent être présents
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const required = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []),
  "picker.html",
].filter(Boolean);
const missing = required.filter((f) => !files.includes(f));
if (missing.length) throw new Error(`Absents du paquet : ${missing.join(", ")}. Lancez d'abord npm run build.`);

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const locals = [];
const centrals = [];
let offset = 0;

for (const file of files) {
  const data = readFileSync(join(root, file));
  const packed = deflateRawSync(data, { level: 9 });
  const name = Buffer.from(file, "utf8");
  const crc = crc32(data);
  const { time, day } = dosDateTime(statSync(join(root, file)).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version requise
  local.writeUInt16LE(0x0800, 6); // noms en UTF-8
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // créé par
  central.writeUInt16LE(20, 6); // version requise
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42); // position de l'en-tête local ; le reste vaut 0

  locals.push(local, name, packed);
  centrals.push(central, name);
  offset += local.length + name.length + packed.length;
}

const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", `excalifree-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...locals, directory, end]));
console.log(`${relative(root, out)} : ${files.length} fichiers`);
