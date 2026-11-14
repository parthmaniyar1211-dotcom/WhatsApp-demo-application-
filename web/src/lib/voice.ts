// Voice notes: record in the browser and produce a file WhatsApp accepts.
//
// WhatsApp voice notes must be OGG files with the Opus codec, mono (Meta "Audio messages").
// WhatsApp does NOT accept WebM. What browsers can record:
//   Firefox           audio/ogg;codecs=opus   -> used as is
//   Chrome / Edge     audio/webm;codecs=opus  -> the same Opus packets, repackaged into OGG below
//                                                (no re-encoding, so no quality loss and no big library)
//   Safari            audio/mp4 (AAC)         -> accepted by WhatsApp as a normal audio message
//                                                (plays fine, but is not shown as a "voice note")

const CANDIDATES = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"];

export function pickRecordingType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function canRecord(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && pickRecordingType() !== null;
}

export interface Recording {
  /** Stops recording and returns the finished file (null when cancelled or empty). */
  stop: (cancel?: boolean) => Promise<File | null>;
}

/** Asks for the microphone and starts recording in mono. */
export async function startRecording(): Promise<Recording> {
  const type = pickRecordingType();
  if (!type) throw new Error("This browser cannot record audio.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    throw new Error("Microphone access was refused. Allow the microphone for this site and try again.");
  }

  // Force mono: WhatsApp only accepts mono Opus, and some microphones deliver stereo.
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  destination.channelCount = 1;
  destination.channelCountMode = "explicit";
  context.createMediaStreamSource(stream).connect(destination);

  const recorder = new MediaRecorder(destination.stream, { mimeType: type, audioBitsPerSecond: 32_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();

  return {
    stop: (cancel = false) =>
      new Promise<File | null>((resolve, reject) => {
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop());
          void context.close();
          if (cancel || chunks.length === 0) return resolve(null);
          try {
            resolve(await toWhatsAppFile(new Blob(chunks, { type }), type));
          } catch (err) {
            reject(err);
          }
        };
        recorder.stop();
      }),
  };
}

async function toWhatsAppFile(blob: Blob, type: string): Promise<File> {
  if (type.startsWith("audio/ogg")) return new File([blob], "voice-note.ogg", { type: "audio/ogg" });
  if (type.startsWith("audio/webm")) {
    const ogg = webmOpusToOgg(new Uint8Array(await blob.arrayBuffer()));
    return new File([ogg as BlobPart], "voice-note.ogg", { type: "audio/ogg" });
  }
  return new File([blob], "voice-note.m4a", { type: "audio/mp4" });
}

// ---------------------------------------------------------------------------
// WebM (Matroska) -> OGG, for Opus audio. Both are containers around the same
// Opus packets: read the packets out of one and write them into the other.
// ---------------------------------------------------------------------------

// Matroska element ids we care about.
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const AUDIO = 0xe1;
const CHANNELS = 0x9f;
const CLUSTER = 0x1f43b675;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
// Containers whose children we walk through (their own size may be "unknown" in live recordings).
const CONTAINERS = new Set([SEGMENT, TRACKS, TRACK_ENTRY, AUDIO, CLUSTER, BLOCK_GROUP]);

/** Converts a WebM file with one Opus track into an OGG/Opus file. Exported for tests. */
export function webmOpusToOgg(webm: Uint8Array): Uint8Array {
  const packets: Uint8Array[] = [];
  let opusHead: Uint8Array | null = null;
  let codecId = "";
  let channels = 1;

  let position = 0;
  while (position < webm.length) {
    const id = readElementId(webm, position);
    if (!id) break;
    const size = readVint(webm, position + id.length);
    if (!size) break;
    const dataStart = position + id.length + size.length;

    if (CONTAINERS.has(id.value)) {
      position = dataStart; // step inside
      continue;
    }
    if (size.unknown) throw new Error("Recording could not be converted (unexpected WebM layout).");
    const data = webm.subarray(dataStart, dataStart + size.value);

    if (id.value === CODEC_ID) codecId = new TextDecoder().decode(data);
    else if (id.value === CODEC_PRIVATE) opusHead = data;
    else if (id.value === CHANNELS) channels = data[data.length - 1] || 1;
    else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      // Block = track number (vint) + 2 bytes timecode + 1 byte flags + the frame.
      const track = readVint(data, 0);
      if (track) {
        const flags = data[track.length + 2];
        if ((flags & 0x06) !== 0) throw new Error("Recording could not be converted (laced WebM blocks).");
        packets.push(data.subarray(track.length + 3));
      }
    }
    position = dataStart + size.value;
  }

  if (codecId !== "A_OPUS" || packets.length === 0) {
    throw new Error("Recording could not be converted (no Opus audio found).");
  }
  // WebM stores the standard "OpusHead" header as the codec's private data.
  const head = opusHead && new TextDecoder().decode(opusHead.subarray(0, 8)) === "OpusHead"
    ? opusHead
    : defaultOpusHead(channels);
  return writeOgg(head, packets);
}

function readElementId(bytes: Uint8Array, at: number): { value: number; length: number } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // 1..4 bytes, the marker bit is part of the id
  if (length > 4 || at + length > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length };
}

function readVint(bytes: Uint8Array, at: number): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // 1..8 bytes
  if (at + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

function defaultOpusHead(channels: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  const view = new DataView(head.buffer);
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, 312, true); // pre-skip
  view.setUint32(12, 48000, true); // original sample rate
  return head;
}

/** Number of 48 kHz samples in one Opus packet, from its first byte(s) (RFC 6716, section 3.1). */
function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const config = packet[0] >> 3;
  let frameMs: number;
  if (config < 12) frameMs = [10, 20, 40, 60][config & 3];
  else if (config < 16) frameMs = [10, 20][config & 1];
  else frameMs = [2.5, 5, 10, 20][config & 3];
  const code = packet[0] & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frames * frameMs * 48;
}

function writeOgg(opusHead: Uint8Array, packets: Uint8Array[]): Uint8Array {
  const serial = Math.floor(Math.random() * 0xffffffff);
  const pages: Uint8Array[] = [];
  let sequence = 0;

  const tags = new Uint8Array(8 + 4 + 5 + 4);
  tags.set(new TextEncoder().encode("OpusTags"));
  new DataView(tags.buffer).setUint32(8, 5, true); // vendor string length
  tags.set(new TextEncoder().encode("inbox"), 12); // vendor string, then 0 comments

  pages.push(oggPage([opusHead], 0, serial, sequence++, 0x02)); // beginning of stream
  pages.push(oggPage([tags], 0, serial, sequence++, 0));

  // Audio pages: about one second each (50 packets of 20 ms), at most 255 segments per page.
  let granule = 0;
  let group: Uint8Array[] = [];
  let segments = 0;
  const flush = (last: boolean) => {
    if (group.length === 0) return;
    pages.push(oggPage(group, granule, serial, sequence++, last ? 0x04 : 0));
    group = [];
    segments = 0;
  };
  packets.forEach((packet, index) => {
    const needed = Math.floor(packet.length / 255) + 1;
    if (segments + needed > 255 || group.length >= 50) flush(false);
    group.push(packet);
    segments += needed;
    granule += opusPacketSamples(packet);
    if (index === packets.length - 1) flush(true);
  });

  const total = pages.reduce((sum, page) => sum + page.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.length;
  }
  return out;
}

function oggPage(packets: Uint8Array[], granule: number, serial: number, sequence: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  const dataLength = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + dataLength);
  const view = new DataView(page.buffer);
  page.set(new TextEncoder().encode("OggS"));
  page[4] = 0; // version
  page[5] = flags;
  view.setUint32(6, granule % 0x100000000, true);
  view.setUint32(10, Math.floor(granule / 0x100000000), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  view.setUint32(22, 0, true); // checksum, filled in below
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggChecksum(page), true);
  return page;
}

// CRC-32 as OGG defines it: polynomial 0x04c11db7, no bit reflection, start value 0.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggChecksum(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}
