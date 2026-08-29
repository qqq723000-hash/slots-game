#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const mediaRoot = resolve(projectRoot, "docs/media");
const videoFileName = "primal-rampage-local-full-stack-demo-24s.mp4";
const posterFileName = "primal-rampage-local-full-stack-demo-poster.webp";
const maximumVideoBytes = 8 * 1024 * 1024;
const maximumPosterBytes = 100 * 1024;
const expectedDurationSeconds = 24;
const expectedVideoWidth = 1920;
const expectedVideoHeight = 1080;
const expectedPosterWidth = 1280;
const expectedPosterHeight = 720;
const expectedAudioChannels = 2;
const expectedAudioSampleRate = 48_000;

function readBoxSize(buffer, offset, end) {
  if (offset + 8 > end) throw new Error(`truncated MP4 box header at ${offset}`);
  const size32 = buffer.readUInt32BE(offset);
  if (size32 === 0) return { headerBytes: 8, size: end - offset };
  if (size32 !== 1) return { headerBytes: 8, size: size32 };
  if (offset + 16 > end) throw new Error(`truncated extended MP4 box header at ${offset}`);
  const size64 = buffer.readBigUInt64BE(offset + 8);
  if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`MP4 box at ${offset} exceeds the safe parser size`);
  }
  return { headerBytes: 16, size: Number(size64) };
}

export function parseMp4Boxes(buffer, start = 0, end = buffer.length) {
  if (start < 0 || end < start || end > buffer.length) {
    throw new Error(`invalid MP4 parse range ${start}:${end}`);
  }
  const boxes = [];
  let offset = start;
  while (offset < end) {
    const { headerBytes, size } = readBoxSize(buffer, offset, end);
    if (size < headerBytes || offset + size > end) {
      throw new Error(`invalid MP4 box size ${size} at ${offset}`);
    }
    boxes.push({
      type: buffer.toString("ascii", offset + 4, offset + 8),
      offset,
      size,
      headerBytes,
    });
    offset += size;
  }
  if (offset !== end) throw new Error("MP4 boxes do not cover the declared range");
  return boxes;
}

function childBoxes(buffer, parent, payloadSkip = 0) {
  const start = parent.offset + parent.headerBytes + payloadSkip;
  const end = parent.offset + parent.size;
  if (start > end) throw new Error(`${parent.type} payload is truncated`);
  return parseMp4Boxes(buffer, start, end);
}

function requiredBox(boxes, type) {
  const matches = boxes.filter((candidate) => candidate.type === type);
  if (matches.length !== 1) {
    throw new Error(`required MP4 box ${type} must occur exactly once, found ${matches.length}`);
  }
  return matches[0];
}

function readDurationBox(buffer, box, label) {
  const payload = box.offset + box.headerBytes;
  const end = box.offset + box.size;
  if (payload >= end) throw new Error(`${label} is truncated`);
  const version = buffer[payload];
  let timescaleOffset;
  let durationOffset;
  let durationBytes;
  if (version === 0) {
    timescaleOffset = payload + 12;
    durationOffset = payload + 16;
    durationBytes = 4;
  } else if (version === 1) {
    timescaleOffset = payload + 20;
    durationOffset = payload + 24;
    durationBytes = 8;
  } else {
    throw new Error(`unsupported ${label} version ${version}`);
  }
  if (durationOffset + durationBytes > end) throw new Error(`${label} duration is truncated`);
  const timescale = buffer.readUInt32BE(timescaleOffset);
  const duration = durationBytes === 4
    ? BigInt(buffer.readUInt32BE(durationOffset))
    : buffer.readBigUInt64BE(durationOffset);
  if (timescale === 0) throw new Error(`${label} timescale must be positive`);
  return { duration, timescale };
}

export function readMp4DurationSeconds(buffer) {
  const moov = requiredBox(parseMp4Boxes(buffer), "moov");
  const mvhd = requiredBox(childBoxes(buffer, moov), "mvhd");
  return readDurationBox(buffer, mvhd, "mvhd");
}

export function readMp4DisplaySize(buffer) {
  const moov = requiredBox(parseMp4Boxes(buffer), "moov");
  const tracks = childBoxes(buffer, moov).filter((box) => box.type === "trak");
  const sizes = tracks.map((track) => {
    const tkhd = requiredBox(childBoxes(buffer, track), "tkhd");
    const payload = tkhd.offset + tkhd.headerBytes;
    const end = tkhd.offset + tkhd.size;
    if (payload >= end) throw new Error("tkhd is truncated");
    const version = buffer[payload];
    const widthOffset = payload + (version === 1 ? 88 : 76);
    if (version !== 0 && version !== 1) throw new Error(`unsupported tkhd version ${version}`);
    if (widthOffset + 8 > end) throw new Error("truncated tkhd dimensions");
    return {
      width: buffer.readUInt32BE(widthOffset) >>> 16,
      height: buffer.readUInt32BE(widthOffset + 4) >>> 16,
    };
  });
  const display = sizes.sort((left, right) => right.width * right.height - left.width * left.height)[0];
  if (!display || display.width === 0 || display.height === 0) {
    throw new Error("MP4 display dimensions are missing");
  }
  return display;
}

function readHandlerType(buffer, hdlr) {
  const payload = hdlr.offset + hdlr.headerBytes;
  const end = hdlr.offset + hdlr.size;
  if (payload + 12 > end) throw new Error("hdlr is truncated");
  if (buffer.readUInt32BE(payload) !== 0) throw new Error("hdlr full-box flags are unsupported");
  return buffer.toString("ascii", payload + 8, payload + 12);
}

function readSampleEntries(buffer, stsd) {
  const payload = stsd.offset + stsd.headerBytes;
  const end = stsd.offset + stsd.size;
  if (payload + 8 > end) throw new Error("stsd is truncated");
  if (buffer.readUInt32BE(payload) !== 0) throw new Error("stsd full-box flags are unsupported");
  const entryCount = buffer.readUInt32BE(payload + 4);
  const entries = parseMp4Boxes(buffer, payload + 8, end);
  if (entryCount === 0 || entries.length !== entryCount) {
    throw new Error(`stsd entry count mismatch: declared ${entryCount}, parsed ${entries.length}`);
  }
  return entries;
}

function readSampleCount(buffer, stsz) {
  const payload = stsz.offset + stsz.headerBytes;
  const end = stsz.offset + stsz.size;
  if (payload + 12 > end) throw new Error("stsz is truncated");
  if (buffer.readUInt32BE(payload) !== 0) throw new Error("stsz full-box flags are unsupported");
  const fixedSampleSize = buffer.readUInt32BE(payload + 4);
  const sampleCount = buffer.readUInt32BE(payload + 8);
  if (sampleCount === 0) throw new Error("MP4 track has no media samples");
  if (fixedSampleSize === 0) {
    if (payload + 12 + sampleCount * 4 !== end) throw new Error("stsz sample table is truncated");
    for (let index = 0; index < sampleCount; index += 1) {
      if (buffer.readUInt32BE(payload + 12 + index * 4) === 0) {
        throw new Error("stsz contains an empty media sample");
      }
    }
  } else if (payload + 12 !== end) {
    throw new Error("fixed-size stsz contains unexpected trailing bytes");
  }
  return sampleCount;
}

function readDescriptor(buffer, offset, end, label) {
  if (offset >= end) throw new Error(`${label} descriptor is missing`);
  const tag = buffer[offset];
  let cursor = offset + 1;
  let size = 0;
  let completed = false;
  for (let index = 0; index < 4; index += 1) {
    if (cursor >= end) throw new Error(`${label} descriptor length is truncated`);
    const value = buffer[cursor];
    cursor += 1;
    size = (size << 7) | (value & 0x7f);
    if ((value & 0x80) === 0) {
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error(`${label} descriptor length exceeds four bytes`);
  const payloadEnd = cursor + size;
  if (payloadEnd > end) throw new Error(`${label} descriptor payload is truncated`);
  return { tag, payloadStart: cursor, payloadEnd };
}

function validateAvcConfiguration(buffer, avcC) {
  const payload = avcC.offset + avcC.headerBytes;
  const end = avcC.offset + avcC.size;
  if (payload + 7 > end) throw new Error("avcC is truncated");
  if (buffer[payload] !== 1) throw new Error("avcC configuration version must be 1");
  if ((buffer[payload + 4] & 0x03) !== 0x03) {
    throw new Error("avcC must declare four-byte NAL lengths");
  }
  let cursor = payload + 6;
  const sequenceCount = buffer[payload + 5] & 0x1f;
  if (sequenceCount === 0) throw new Error("avcC has no SPS");
  for (let index = 0; index < sequenceCount; index += 1) {
    if (cursor + 2 > end) throw new Error("avcC SPS length is truncated");
    const length = buffer.readUInt16BE(cursor);
    cursor += 2;
    if (length === 0 || cursor + length > end || (buffer[cursor] & 0x1f) !== 7) {
      throw new Error("avcC contains an invalid SPS");
    }
    cursor += length;
  }
  if (cursor >= end) throw new Error("avcC PPS count is missing");
  const pictureCount = buffer[cursor];
  cursor += 1;
  if (pictureCount === 0) throw new Error("avcC has no PPS");
  for (let index = 0; index < pictureCount; index += 1) {
    if (cursor + 2 > end) throw new Error("avcC PPS length is truncated");
    const length = buffer.readUInt16BE(cursor);
    cursor += 2;
    if (length === 0 || cursor + length > end || (buffer[cursor] & 0x1f) !== 8) {
      throw new Error("avcC contains an invalid PPS");
    }
    cursor += length;
  }
}

function validateAacConfiguration(buffer, esds) {
  const payload = esds.offset + esds.headerBytes;
  const end = esds.offset + esds.size;
  if (payload + 5 > end) throw new Error("esds is truncated");
  if (buffer.readUInt32BE(payload) !== 0) throw new Error("esds full-box flags are unsupported");
  const elementary = readDescriptor(buffer, payload + 4, end, "ES");
  if (elementary.tag !== 0x03 || elementary.payloadEnd !== end) {
    throw new Error("esds must contain one complete ES descriptor");
  }
  let cursor = elementary.payloadStart;
  if (cursor + 3 > elementary.payloadEnd) throw new Error("ES descriptor header is truncated");
  cursor += 2;
  const flags = buffer[cursor];
  cursor += 1;
  if ((flags & 0x80) !== 0) cursor += 2;
  if ((flags & 0x40) !== 0) {
    if (cursor >= elementary.payloadEnd) throw new Error("ES URL length is truncated");
    cursor += 1 + buffer[cursor];
  }
  if ((flags & 0x20) !== 0) cursor += 2;
  if (cursor > elementary.payloadEnd) throw new Error("ES optional fields are truncated");

  const decoder = readDescriptor(buffer, cursor, elementary.payloadEnd, "decoder configuration");
  if (decoder.tag !== 0x04 || decoder.payloadStart + 13 > decoder.payloadEnd) {
    throw new Error("AAC decoder configuration is missing or truncated");
  }
  if (buffer[decoder.payloadStart] !== 0x40) {
    throw new Error("mp4a must use the MPEG-4 AAC object type");
  }
  const streamType = buffer[decoder.payloadStart + 1];
  if (((streamType >>> 2) & 0x3f) !== 5 || (streamType & 0x01) !== 1) {
    throw new Error("mp4a decoder configuration is not an audio stream");
  }
  const decoderSpecific = readDescriptor(
    buffer,
    decoder.payloadStart + 13,
    decoder.payloadEnd,
    "AAC AudioSpecificConfig",
  );
  if (decoderSpecific.tag !== 0x05 || decoderSpecific.payloadEnd !== decoder.payloadEnd) {
    throw new Error("AAC AudioSpecificConfig is missing or malformed");
  }
  if (decoderSpecific.payloadStart + 2 > decoderSpecific.payloadEnd) {
    throw new Error("AAC AudioSpecificConfig is truncated");
  }
  const first = buffer[decoderSpecific.payloadStart];
  const second = buffer[decoderSpecific.payloadStart + 1];
  const audioObjectType = first >>> 3;
  const sampleFrequencyIndex = ((first & 0x07) << 1) | (second >>> 7);
  const channelConfiguration = (second >>> 3) & 0x0f;
  if (audioObjectType !== 2 || sampleFrequencyIndex !== 3 || channelConfiguration !== 2) {
    throw new Error("AAC AudioSpecificConfig must declare 48 kHz stereo AAC-LC");
  }
  const slConfiguration = readDescriptor(
    buffer,
    decoder.payloadEnd,
    elementary.payloadEnd,
    "SL configuration",
  );
  if (slConfiguration.tag !== 0x06 || slConfiguration.payloadEnd !== elementary.payloadEnd) {
    throw new Error("AAC SL configuration is missing or malformed");
  }
}

function readTrackContract(buffer, track) {
  const trackChildren = childBoxes(buffer, track);
  const mdia = requiredBox(trackChildren, "mdia");
  const mediaChildren = childBoxes(buffer, mdia);
  const handler = readHandlerType(buffer, requiredBox(mediaChildren, "hdlr"));
  const duration = readDurationBox(buffer, requiredBox(mediaChildren, "mdhd"), `${handler} mdhd`);
  const minf = requiredBox(mediaChildren, "minf");
  const stbl = requiredBox(childBoxes(buffer, minf), "stbl");
  const sampleTable = childBoxes(buffer, stbl);
  requiredBox(sampleTable, "stts");
  requiredBox(sampleTable, "stsc");
  const offsetTableCount = sampleTable.filter((box) => box.type === "stco" || box.type === "co64").length;
  if (offsetTableCount !== 1) throw new Error(`${handler} track must contain one chunk-offset table`);
  const sampleCount = readSampleCount(buffer, requiredBox(sampleTable, "stsz"));
  const entries = readSampleEntries(buffer, requiredBox(sampleTable, "stsd"));
  if (entries.length !== 1) throw new Error(`${handler} track must contain one sample entry`);
  return { duration, entry: entries[0], handler, sampleCount };
}

export function readMp4StreamContract(buffer) {
  const topLevel = parseMp4Boxes(buffer);
  const ftyp = requiredBox(topLevel, "ftyp");
  const moov = requiredBox(topLevel, "moov");
  const mdat = requiredBox(topLevel, "mdat");
  if (topLevel[0] !== ftyp) throw new Error("MP4 ftyp must be the first top-level box");
  if (mdat.size <= mdat.headerBytes) throw new Error("MP4 mdat contains no media payload");
  const fileTypePayload = ftyp.offset + ftyp.headerBytes;
  const fileTypeEnd = ftyp.offset + ftyp.size;
  if (fileTypePayload + 8 > fileTypeEnd || (fileTypeEnd - fileTypePayload - 8) % 4 !== 0) {
    throw new Error("MP4 ftyp is malformed");
  }
  const brands = [buffer.toString("ascii", fileTypePayload, fileTypePayload + 4)];
  for (let offset = fileTypePayload + 8; offset < fileTypeEnd; offset += 4) {
    brands.push(buffer.toString("ascii", offset, offset + 4));
  }
  if (!brands.includes("isom") || !brands.includes("avc1")) {
    throw new Error("MP4 ftyp must declare ISO BMFF and AVC compatibility");
  }

  const tracks = childBoxes(buffer, moov)
    .filter((box) => box.type === "trak")
    .map((track) => readTrackContract(buffer, track));
  const videoTracks = tracks.filter((track) => track.handler === "vide");
  const audioTracks = tracks.filter((track) => track.handler === "soun");
  if (videoTracks.length !== 1) {
    throw new Error(`one H.264 video track is required, found ${videoTracks.length}`);
  }
  if (audioTracks.length !== 1) {
    throw new Error(`one AAC audio track is required, found ${audioTracks.length}`);
  }

  const video = videoTracks[0];
  if (video.entry.type !== "avc1") {
    throw new Error(`video sample entry must be avc1, found ${video.entry.type}`);
  }
  const videoPayload = video.entry.offset + video.entry.headerBytes;
  const videoEnd = video.entry.offset + video.entry.size;
  if (videoPayload + 78 > videoEnd) throw new Error("avc1 sample entry is truncated");
  if (buffer.readUInt16BE(videoPayload + 6) !== 1) {
    throw new Error("avc1 data-reference index must be 1");
  }
  const videoWidth = buffer.readUInt16BE(videoPayload + 24);
  const videoHeight = buffer.readUInt16BE(videoPayload + 26);
  const avcC = requiredBox(childBoxes(buffer, video.entry, 78), "avcC");
  validateAvcConfiguration(buffer, avcC);

  const audio = audioTracks[0];
  if (audio.entry.type !== "mp4a") {
    throw new Error(`audio sample entry must be mp4a, found ${audio.entry.type}`);
  }
  const audioPayload = audio.entry.offset + audio.entry.headerBytes;
  const audioEnd = audio.entry.offset + audio.entry.size;
  if (audioPayload + 28 > audioEnd) throw new Error("mp4a sample entry is truncated");
  if (buffer.readUInt16BE(audioPayload + 6) !== 1) {
    throw new Error("mp4a data-reference index must be 1");
  }
  if (buffer.readUInt16BE(audioPayload + 8) !== 0) {
    throw new Error("only the portable version-0 mp4a sample entry is accepted");
  }
  const audioChannels = buffer.readUInt16BE(audioPayload + 16);
  const audioSampleSize = buffer.readUInt16BE(audioPayload + 18);
  const audioSampleRateFixed = buffer.readUInt32BE(audioPayload + 24);
  if (audioChannels !== expectedAudioChannels || audioSampleSize !== 16) {
    throw new Error("mp4a must declare 16-bit stereo audio");
  }
  if (audioSampleRateFixed !== expectedAudioSampleRate * 65_536) {
    throw new Error("mp4a must declare a 48 kHz sample rate");
  }
  const esds = requiredBox(childBoxes(buffer, audio.entry, 28), "esds");
  validateAacConfiguration(buffer, esds);

  return {
    audio: {
      channels: audioChannels,
      codec: audio.entry.type,
      duration: audio.duration,
      sampleCount: audio.sampleCount,
      sampleRate: audioSampleRateFixed >>> 16,
    },
    mdatOffset: mdat.offset,
    moovOffset: moov.offset,
    video: {
      codec: video.entry.type,
      duration: video.duration,
      height: videoHeight,
      sampleCount: video.sampleCount,
      width: videoWidth,
    },
  };
}

export function readWebpVp8Size(buffer) {
  if (
    buffer.length < 30
    || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error("poster must be a RIFF WebP image");
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) {
    throw new Error("poster RIFF size does not cover the complete file");
  }
  let offset = 12;
  const chunks = [];
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error("poster WebP chunk header is truncated");
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const end = payload + size;
    const paddedEnd = end + (size & 1);
    if (end > buffer.length || paddedEnd > buffer.length) {
      throw new Error(`poster WebP ${type} chunk is truncated`);
    }
    chunks.push({ end, payload, size, type });
    offset = paddedEnd;
  }
  if (offset !== buffer.length) throw new Error("poster WebP chunks do not cover the complete file");
  if (chunks.length !== 1 || chunks[0].type !== "VP8 ") {
    throw new Error("poster must contain exactly one simple VP8 chunk");
  }
  const vp8 = chunks[0];
  if (vp8.size < 10) throw new Error("poster VP8 key frame is truncated");
  const frameTag = buffer.readUIntLE(vp8.payload, 3);
  const firstPartitionBytes = frameTag >>> 5;
  if ((frameTag & 0x01) !== 0 || firstPartitionBytes === 0) {
    throw new Error("poster VP8 payload must start with a complete key frame");
  }
  if (10 + firstPartitionBytes > vp8.size) {
    throw new Error("poster VP8 first partition is truncated");
  }
  if (!buffer.subarray(vp8.payload + 3, vp8.payload + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    throw new Error("poster VP8 key-frame signature is missing");
  }
  const width = buffer.readUInt16LE(vp8.payload + 6) & 0x3fff;
  const height = buffer.readUInt16LE(vp8.payload + 8) & 0x3fff;
  if (width === 0 || height === 0) throw new Error("poster VP8 dimensions are missing");
  return { width, height };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, found ${actual}`);
}

async function assertRegularContainedFile(root, fileName, label) {
  const filePath = resolve(root, fileName);
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink or special entry`);
  }
  const canonicalPath = await realpath(filePath);
  const expectedPath = resolve(root, fileName);
  if (canonicalPath !== expectedPath) {
    throw new Error(`${label} resolves outside the canonical media directory`);
  }
  return filePath;
}

function assertExactTrackDuration(track, seconds, label) {
  const expected = BigInt(seconds) * BigInt(track.duration.timescale);
  if (track.duration.duration !== expected) {
    throw new Error(`${label} duration does not equal ${seconds} seconds`);
  }
}

function assertBoundedAudioDuration(track, seconds) {
  const timescale = BigInt(track.duration.timescale);
  const expected = BigInt(seconds) * timescale;
  const maximum = expected + (timescale + 9n) / 10n;
  if (track.duration.duration < expected || track.duration.duration > maximum) {
    throw new Error("AAC track duration does not cover the 24-second movie within the padding budget");
  }
}

export async function verifyDemoMedia(root = mediaRoot) {
  const requestedRoot = resolve(root);
  const rootStats = await lstat(requestedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("media directory must be a real directory, not a symlink or special entry");
  }
  const canonicalRoot = await realpath(requestedRoot);
  if (canonicalRoot !== requestedRoot) {
    throw new Error("media directory or one of its parents resolves through a symlink");
  }
  const manifestFile = await assertRegularContainedFile(canonicalRoot, "manifest.json", "media manifest");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assertEqual(manifest.manifestVersion, 1, "manifest version");
  if (!/[\p{Script=Han}]/u.test(manifest.descriptionZh)) throw new Error("Chinese media description is missing");
  if (!/\b(?:the|and|a|an)\b/iu.test(manifest.descriptionEn)) throw new Error("English media description is missing");
  assertEqual(manifest.video.file, videoFileName, "video filename");
  assertEqual(manifest.poster.file, posterFileName, "poster filename");
  assertEqual(manifest.video.durationSeconds, expectedDurationSeconds, "manifest video duration");
  assertEqual(manifest.video.width, expectedVideoWidth, "manifest video width");
  assertEqual(manifest.video.height, expectedVideoHeight, "manifest video height");
  assertEqual(manifest.video.videoCodec, "H.264", "manifest video codec");
  assertEqual(manifest.video.audioCodec, "AAC", "manifest audio codec");
  assertEqual(manifest.video.fastStart, true, "manifest faststart flag");
  assertEqual(manifest.poster.width, expectedPosterWidth, "manifest poster width");
  assertEqual(manifest.poster.height, expectedPosterHeight, "manifest poster height");
  if (!/^[0-9a-f]{64}$/u.test(manifest.video.sha256)) throw new Error("video SHA-256 is malformed");
  if (!/^[0-9a-f]{64}$/u.test(manifest.poster.sha256)) throw new Error("poster SHA-256 is malformed");

  const expectedNames = ["manifest.json", posterFileName, videoFileName].sort();
  const actualNames = (await readdir(canonicalRoot)).sort();
  assertEqual(JSON.stringify(actualNames), JSON.stringify(expectedNames), "media directory allowlist");
  const videoPath = await assertRegularContainedFile(canonicalRoot, videoFileName, "demo video");
  const posterPath = await assertRegularContainedFile(canonicalRoot, posterFileName, "demo poster");

  const video = await readFile(videoPath);
  assertEqual(video.length, manifest.video.bytes, "video byte length");
  assertEqual(sha256(video), manifest.video.sha256, "video SHA-256");
  if (video.length > maximumVideoBytes) throw new Error("video exceeds the 8 MiB GitHub delivery budget");
  const movieDuration = readMp4DurationSeconds(video);
  assertEqual(
    movieDuration.duration,
    BigInt(expectedDurationSeconds * movieDuration.timescale),
    "video duration units",
  );
  const display = readMp4DisplaySize(video);
  assertEqual(display.width, expectedVideoWidth, "video width");
  assertEqual(display.height, expectedVideoHeight, "video height");
  const streams = readMp4StreamContract(video);
  if (streams.moovOffset > streams.mdatOffset) throw new Error("MP4 faststart failed: moov follows mdat");
  assertEqual(streams.video.width, expectedVideoWidth, "avc1 video width");
  assertEqual(streams.video.height, expectedVideoHeight, "avc1 video height");
  assertExactTrackDuration(streams.video, expectedDurationSeconds, "H.264 track");
  assertBoundedAudioDuration(streams.audio, expectedDurationSeconds);

  const poster = await readFile(posterPath);
  assertEqual(poster.length, manifest.poster.bytes, "poster byte length");
  assertEqual(sha256(poster), manifest.poster.sha256, "poster SHA-256");
  if (poster.length > maximumPosterBytes) throw new Error("poster exceeds the 100 KiB first-paint budget");
  const posterSize = readWebpVp8Size(poster);
  assertEqual(posterSize.width, expectedPosterWidth, "poster width");
  assertEqual(posterSize.height, expectedPosterHeight, "poster height");

  return { manifest, posterBytes: poster.length, streams, videoBytes: video.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await verifyDemoMedia();
  process.stdout.write(
    `演示媒体门禁通过 / demo media gate passed: ${result.manifest.video.durationSeconds}s, ${result.videoBytes} video bytes, ${result.posterBytes} poster bytes.\n`,
  );
}
