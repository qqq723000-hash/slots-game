import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseMp4Boxes,
  readMp4DisplaySize,
  readMp4DurationSeconds,
  readMp4StreamContract,
  readWebpVp8Size,
  verifyDemoMedia,
} from "./verify-demo-media.mjs";

const videoFileName = "primal-rampage-local-full-stack-demo-24s.mp4";
const posterFileName = "primal-rampage-local-full-stack-demo-poster.webp";
const mediaRoot = new URL("../docs/media/", import.meta.url);
const repositoryManifest = JSON.parse(await readFile(new URL("manifest.json", mediaRoot), "utf8"));
const repositoryVideo = await readFile(new URL(videoFileName, mediaRoot));
const repositoryPoster = await readFile(new URL(posterFileName, mediaRoot));

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function temporaryMediaRoot(context) {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(canonicalTemporaryRoot, "slots-demo-media-"));
  context.after(async () => rm(root, { force: true, recursive: true }));
  return root;
}

async function writeFixture(root, { poster = repositoryPoster, video = repositoryVideo } = {}) {
  const manifest = structuredClone(repositoryManifest);
  manifest.video.bytes = video.length;
  manifest.video.sha256 = sha256(video);
  manifest.poster.bytes = poster.length;
  manifest.poster.sha256 = sha256(poster);
  await Promise.all([
    writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(root, videoFileName), video),
    writeFile(join(root, posterFileName), poster),
  ]);
}

function mp4Box(type, payload) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

function markerOnlyFakeMp4() {
  const ftyp = Buffer.alloc(16);
  ftyp.write("isom", 0, 4, "ascii");
  ftyp.writeUInt32BE(0, 4);
  ftyp.write("isom", 8, 4, "ascii");
  ftyp.write("avc1", 12, 4, "ascii");
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(24_000, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(1920 << 16, 76);
  tkhd.writeUInt32BE(1080 << 16, 80);
  return Buffer.concat([
    mp4Box("ftyp", ftyp),
    mp4Box("moov", Buffer.concat([
      mp4Box("mvhd", mvhd),
      mp4Box("trak", mp4Box("tkhd", tkhd)),
    ])),
    mp4Box("mdat", Buffer.from("marker-only avc1 and marker-only mp4a")),
  ]);
}

function incompleteVp8Poster() {
  const poster = Buffer.alloc(30);
  poster.write("RIFF", 0, 4, "ascii");
  poster.writeUInt32LE(22, 4);
  poster.write("WEBP", 8, 4, "ascii");
  poster.write("VP8 ", 12, 4, "ascii");
  poster.writeUInt32LE(10, 16);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(poster, 23);
  poster.writeUInt16LE(1280, 26);
  poster.writeUInt16LE(720, 28);
  return poster;
}

function replaceUniqueAscii(buffer, value, replacement, { last = false } = {}) {
  const mutated = Buffer.from(buffer);
  const needle = Buffer.from(value, "ascii");
  const first = mutated.indexOf(needle);
  const final = mutated.lastIndexOf(needle);
  assert.notEqual(first, -1, `${value} fixture marker must exist`);
  const offset = last ? final : first;
  mutated.write(replacement, offset, needle.length, "ascii");
  return mutated;
}

test("accepts the repository demo media and its delivery manifest", async () => {
  const result = await verifyDemoMedia();
  assert.equal(result.manifest.video.durationSeconds, 24);
  assert.equal(result.streams.video.codec, "avc1");
  assert.equal(result.streams.audio.codec, "mp4a");
  assert.equal(result.streams.audio.channels, 2);
  assert.equal(result.streams.audio.sampleRate, 48_000);
  assert.ok(result.videoBytes < 8 * 1024 * 1024);
  assert.ok(result.posterBytes < 100 * 1024);
});

test("rejects a truncated MP4 box", () => {
  const truncated = Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70]);
  assert.throws(() => parseMp4Boxes(truncated), /invalid MP4 box size/u);
});

test("reads exact duration, display size, structured streams, and VP8 poster size", () => {
  assert.deepEqual(readMp4DurationSeconds(repositoryVideo), { duration: 24_000n, timescale: 1_000 });
  assert.deepEqual(readMp4DisplaySize(repositoryVideo), { width: 1920, height: 1080 });
  const streams = readMp4StreamContract(repositoryVideo);
  assert.equal(streams.video.sampleCount, 720);
  assert.equal(streams.audio.sampleCount, 1_126);
  assert.deepEqual(readWebpVp8Size(repositoryPoster), { width: 1280, height: 720 });
});

test("rejects marker-only bytes that are not structured H.264/AAC media", async (context) => {
  const root = await temporaryMediaRoot(context);
  await writeFixture(root, { video: markerOnlyFakeMp4() });
  await assert.rejects(() => verifyDemoMedia(root), /required MP4 box mdia/u);
});

test("rejects a complete RIFF envelope with an incomplete VP8 partition", async (context) => {
  const root = await temporaryMediaRoot(context);
  await writeFixture(root, { poster: incompleteVp8Poster() });
  await assert.rejects(() => verifyDemoMedia(root), /complete key frame/u);
});

test("rejects media symlinks even when their target bytes match the manifest", async (context) => {
  const root = await temporaryMediaRoot(context);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(repositoryManifest, null, 2)}\n`);
  await symlink(new URL(videoFileName, mediaRoot), join(root, videoFileName));
  await symlink(new URL(posterFileName, mediaRoot), join(root, posterFileName));
  await assert.rejects(() => verifyDemoMedia(root), /must be a regular file/u);
});

test("rejects a media root that is itself a symlink", async (context) => {
  const root = await temporaryMediaRoot(context);
  await writeFixture(root);
  const linkedRoot = `${root}-linked`;
  context.after(async () => rm(linkedRoot, { force: true }));
  await symlink(root, linkedRoot, "dir");
  await assert.rejects(() => verifyDemoMedia(linkedRoot), /media directory must be a real directory/u);
});

test("rejects an MP4 whose audio handler is missing", async (context) => {
  const root = await temporaryMediaRoot(context);
  const withoutAudio = replaceUniqueAscii(repositoryVideo, "soun", "hint");
  await writeFixture(root, { video: withoutAudio });
  await assert.rejects(() => verifyDemoMedia(root), /one AAC audio track is required, found 0/u);
});

test("rejects an MP4 whose video sample entry is not avc1", async (context) => {
  const root = await temporaryMediaRoot(context);
  const wrongSampleEntry = replaceUniqueAscii(repositoryVideo, "avc1", "vp09", { last: true });
  await writeFixture(root, { video: wrongSampleEntry });
  await assert.rejects(() => verifyDemoMedia(root), /video sample entry must be avc1/u);
});
