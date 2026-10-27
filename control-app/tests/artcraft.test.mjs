// Jarvis's ArtCraft tools, against a fake install (empty .exe files) in a temp folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-artcraft-test-"));
const artcraft = path.join(tempRoot, "ArtCraft");
process.env.ARTCRAFT_DIR = artcraft;

const {
  appForFile,
  artcraftConvert,
  artcraftFileInfo,
  listArtcraftApps,
  openArtcraftApp,
  resolveArtcraftApp
} = await import("../server/services/artcraftService.js");

const doc = path.join(tempRoot, "notes.docx");

before(() => {
  for (const name of ["PhotoCraft", "WordCraft", "PdfCraft"]) {
    const folder = path.join(artcraft, "apps", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${name.toLowerCase()}.exe`), "");
    writeFileSync(path.join(folder, `${name.toLowerCase()}-cli.exe`), "");
  }
  // A folder with no executables isn't an app.
  mkdirSync(path.join(artcraft, "apps", "Docs"), { recursive: true });
  writeFileSync(doc, "x");
});

after(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("artcraft tools", () => {
  test("installed apps are found by scanning the apps folder", () => {
    const apps = listArtcraftApps();
    assert.deepEqual(apps.map((a) => a.name), ["PdfCraft", "PhotoCraft", "WordCraft"]);
    assert.match(apps.find((a) => a.id === "photocraft").about, /photo/i);
  });

  test("app names match loosely", () => {
    for (const query of ["PhotoCraft", "photo craft", "photocraft", "photo", "Photo-Craft"]) {
      assert.equal(resolveArtcraftApp(query).id, "photocraft", query);
    }
    assert.throws(() => resolveArtcraftApp("filmcraft"), { code: "UNKNOWN_ARTCRAFT_APP" });
  });

  test("files go to the app that reads them", () => {
    assert.equal(appForFile("D:\\a\\b.PDF", { pdfcraft: [".pdf"] }, "read").id, "pdfcraft");
    assert.throws(() => appForFile("D:\\a\\b.xyz", { pdfcraft: [".pdf"] }, "read"), { code: "UNSUPPORTED_FILE" });
    // Known type, but the app that handles it isn't installed.
    assert.throws(() => appForFile("D:\\a\\b.xlsx", { gridcraft: [".xlsx"] }, "read"), { code: "ARTCRAFT_NOT_FOUND" });
  });

  test("paths must be full and exist", async () => {
    assert.throws(() => openArtcraftApp("photocraft", "cat.png"), { code: "RELATIVE_PATH" });
    assert.throws(() => openArtcraftApp("photocraft", path.join(tempRoot, "missing.png")), { code: "FILE_NOT_FOUND" });
    await assert.rejects(artcraftFileInfo(path.join(tempRoot, "missing.pdf")), { code: "FILE_NOT_FOUND" });
  });

  test("convert never overwrites and never writes into the ArtCraft folder", async () => {
    await assert.rejects(artcraftConvert(doc, doc), { code: "OUTPUT_EXISTS" });
    await assert.rejects(artcraftConvert(doc, path.join(artcraft, "apps", "out.pdf")), { code: "ARTCRAFT_FOLDER" });
    await assert.rejects(artcraftConvert(doc, path.join(tempRoot, "nope", "out.pdf")), { code: "FOLDER_NOT_FOUND" });
  });
});
