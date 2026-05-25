// Minimal in-memory WAV encoder.
//
// Used to bridge browser-decoded audio (m4a, mp3, flac, ogg via
// AudioContext.decodeAudioData) into the engine's WAV-only ingest path.
// 16-bit signed PCM is the sweet spot: half the bytes of float32, fine
// dynamic range for almost anything a user drops in, and exactly what
// the Rust decoder hits its fastest path on.

export function encodeWavPcm16(
  channels: Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  if (channels.length === 0 || !channels[0]) {
    throw new Error("encodeWavPcm16: no channels");
  }
  const numChannels = channels.length;
  const frameCount = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  // 44-byte RIFF/fmt /data header + payload
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channels and convert float [-1, 1] → int16 with clamping.
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const channel = channels[ch]!;
      let s = channel[frame] ?? 0;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      // 32767 (not 32768) avoids overflow on the +1.0 edge case after rounding.
      view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
      offset += 2;
    }
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
