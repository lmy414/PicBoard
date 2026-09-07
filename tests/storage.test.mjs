import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { buildWindowsFileDropBuffer, createStorage } = await import("../dist-electron/electron/main/storage.js");
const { fitWindowToWorkArea } = await import("../dist-electron/electron/main/window-geometry.js");
const { pointerToLookTarget, MAX_LOOK_YAW, MAX_LOOK_PITCH } = await import("../dist-electron/electron/main/look-geometry.js");

async function tempStorage() {
  return mkdtemp(path.join(os.tmpdir(), "quick-image-board-test-"));
}

function imagePayload(name = "sample.png") {
  return { name, data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) };
}

test("pointer look targets stay bounded and forward for extreme coordinates", () => {
  assert.deepEqual(pointerToLookTarget(0, 0), { yaw: 0, pitch: -0 });
  const extreme = pointerToLookTarget(100000, -100000);
  assert.ok(extreme.yaw > 0 && extreme.pitch > 0);
  assert.ok(extreme.yaw <= MAX_LOOK_YAW);
  assert.ok(extreme.pitch <= MAX_LOOK_PITCH);
  assert.deepEqual(pointerToLookTarget(Number.NaN, Number.POSITIVE_INFINITY), { yaw: 0, pitch: -0 });
  const corner = pointerToLookTarget(-1, 1);
  assert.ok(Math.abs(corner.yaw) < MAX_LOOK_YAW);
  assert.ok(Math.abs(corner.pitch) < MAX_LOOK_PITCH);
});

test("isolated storage keeps visible coordinates, canvas view, and concurrent imports", async () => {
  const root = await tempStorage();
  try {
    const store = createStorage({ rootDir: root });
    const first = await store.loadState();
    const canvasId = first.activeCanvasId;
    const imported = await store.importImages(canvasId, [imagePayload()], { x: -900, y: -500, zoom: 1, width: 640, height: 480 });
    const image = Object.values(imported.images)[0];
    assert.equal(image.x, 1140);
    assert.equal(image.y, 670);
    await store.moveImage(image.id, -321, -177);
    const second = await store.createCanvasRecord();
    const secondImageState = await store.importImages(second.activeCanvasId, [imagePayload("second.png")], { x: 40, y: 20, zoom: 1.5, width: 640, height: 480 });
    const secondImage = Object.values(secondImageState.images).find((item) => item.fileName === "second.png");
    assert.ok(secondImage);
    await Promise.all(Array.from({ length: 5 }, (_, index) => store.importImages(canvasId, [imagePayload(`parallel-${index}.png`)])));
    const viewportSaved = await store.setCanvasViewport(canvasId, { x: -321, y: -177, zoom: 1.5 });
    await store.setActiveCanvas(canvasId);
    assert.equal(viewportSaved.canvases.find((item) => item.id === canvasId).viewport.zoom, 1.5);
    const reopened = createStorage({ rootDir: root });
    const persisted = await reopened.loadState();
    assert.equal(persisted.activeCanvasId, canvasId);
    assert.deepEqual(persisted.canvases.find((item) => item.id === canvasId).viewport, { x: -321, y: -177, zoom: 1.5 });
    assert.equal(persisted.canvases.find((item) => item.id === canvasId).imageIds.length, 6);
    assert.ok(Object.values(persisted.images).some((item) => item.x === -321 && item.y === -177));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classification uses stable id storage and canvas deletion preserves classified files", async () => {
  const root = await tempStorage();
  try {
    const store = createStorage({ rootDir: root });
    const initial = await store.loadState();
    const canvasId = initial.activeCanvasId;
    const imported = await store.importImages(canvasId, [imagePayload()], { x: 0, y: 0, zoom: 1, width: 640, height: 480 });
    const image = Object.values(imported.images)[0];
    const category = imported.categories[0];
    const classified = await store.classifyImages([image.id], category.id);
    const classifiedImage = classified.images[image.id];
    assert.equal(classifiedImage.status, "classified");
    assert.match(classifiedImage.relativePath, new RegExp(`^classified[\\\\/]${category.id}[\\\\/]`));
    await stat(path.join(root, classifiedImage.relativePath));
    const extraCanvas = await store.createCanvasRecord();
    const extraImageState = await store.importImages(extraCanvas.activeCanvasId, [imagePayload("temporary.png")]);
    const extraImage = Object.values(extraImageState.images).find((item) => item.fileName === "temporary.png");
    await store.deleteCanvas(extraCanvas.activeCanvasId);
    assert.equal(Object.values((await store.loadState()).images).some((item) => item.id === extraImage.id), false);
    await stat(path.join(root, classifiedImage.relativePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt state is preserved while the valid backup recovers", async () => {
  const root = await tempStorage();
  try {
    const store = createStorage({ rootDir: root });
    await store.loadState();
    await store.createCanvasRecord();
    const validBackup = await readFile(path.join(root, "state.json.bak"), "utf8");
    await writeFile(path.join(root, "state.json"), "{not-json", "utf8");
    const recovered = await createStorage({ rootDir: root }).loadState();
    assert.match(recovered.storageNotice, /损坏/);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "state.json.bak"), "utf8")), JSON.parse(validBackup));
    const files = await readdir(root);
    assert.ok(files.some((file) => file.startsWith("state.json.corrupt-")));
    const recoveredText = await readFile(path.join(root, "state.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(recoveredText));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CF_HDROP buffer contains the native DROPFILES header and UTF-16 file list", () => {
  const buffer = buildWindowsFileDropBuffer(["C:/Temp/one.png", "D:/图片/two.jpg"]);
  assert.equal(buffer.readUInt32LE(0), 20);
  assert.equal(buffer.readUInt32LE(16), 1);
  const list = buffer.subarray(20).toString("utf16le");
  assert.ok(list.startsWith("C:\\Temp\\one.png\0D:\\图片\\two.jpg"));
  assert.ok(list.endsWith("\0\0"));
});

test("copyImageFiles sends every selected file to the injected file clipboard writer", async () => {
  const root = await tempStorage();
  try {
    const copiedPaths = [];
    const store = createStorage({ rootDir: root, fileClipboard: async (paths) => copiedPaths.push([...paths]) });
    const initial = await store.loadState();
    const imported = await store.importImages(initial.activeCanvasId, [imagePayload("one.png"), imagePayload("two.png")]);
    const images = Object.values(imported.images);
    const result = await store.copyImageFiles([images[0].id, images[1].id, images[0].id]);
    assert.equal(result.copied, 2);
    assert.equal(copiedPaths.length, 1);
    assert.deepEqual(copiedPaths[0].map((filePath) => path.relative(root, filePath)), [images[0].relativePath, images[1].relativePath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expanded and collapsed window bounds stay inside a display work area", () => {
  const workArea = { x: 0, y: 0, width: 1366, height: 768 };
  assert.deepEqual(fitWindowToWorkArea({ x: 1200, y: 700, width: 300, height: 96 }, workArea, true), { x: 706, y: 24, width: 660, height: 744 });
  assert.deepEqual(fitWindowToWorkArea({ x: -200, y: -100, width: 660, height: 744 }, workArea, false), { x: 0, y: 0, width: 88, height: 88 });
});
