import { useRef, useState } from "react";
import FileInputs from "./ui/FileInputs";
import Transport from "./ui/Transport";
import ModeBar from "./ui/ModeBar";
import type { Mode } from "./ui/ModeBar";
import ExportBar from "./ui/ExportBar";

export default function App() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const convRef = useRef<ConvolverNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  const musicBufRef = useRef<AudioBuffer | null>(null);
  const irBufRef = useRef<AudioBuffer | null>(null);

  const startTimeRef = useRef(0);
  const startOffsetRef = useRef(0);

  const [isPlaying, setPlaying] = useState(false);
  const [mode, setMode] = useState<Mode>("original");
  const [vol, setVol] = useState<number>(1.0);
  const [status, setStatus] = useState<string>("Load a music WAV and an IR WAV.");
  const [downloadUrl, setDownloadUrl] = useState<string>("");

  function ensureCtx(): AudioContext {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }

  async function decodeFile(file: File): Promise<AudioBuffer> {
    const ctx = ensureCtx();
    const arr = await file.arrayBuffer();
    return await ctx.decodeAudioData(arr.slice(0));
  }

  async function onPickMusic(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const buf = await decodeFile(f);
      musicBufRef.current = buf;
      setStatus(`Music loaded: ${f.name} • ${buf.sampleRate} Hz • ${buf.duration.toFixed(2)} s`);
    } catch (err) {
      setStatus(`Music load failed: ${(err as Error).message}`);
    }
  }

  async function onPickIR(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const buf = await decodeFile(f);
      irBufRef.current = buf;
      setStatus(
        (s) => s + `\nIR loaded: ${f.name} • ${buf.sampleRate} Hz • ${buf.duration.toFixed(3)} s`
      );
    } catch (err) {
      setStatus(`IR load failed: ${(err as Error).message}`);
    }
  }

  function teardownGraph() {
    try {
      srcRef.current?.stop();
    } catch {}
    srcRef.current?.disconnect();
    convRef.current?.disconnect();
    gainRef.current?.disconnect();
    srcRef.current = null;
    convRef.current = null;
    gainRef.current = null;
  }

  function makeGraph(at: number) {
    const ctx = ensureCtx();
    const music = musicBufRef.current;
    if (!music) {
      setStatus("No music loaded.");
      return;
    }

    const src = new AudioBufferSourceNode(ctx, { buffer: music });
    const gain = new GainNode(ctx, { gain: vol });
    srcRef.current = src;
    gainRef.current = gain;

    if (mode === "convolved") {
      const ir = irBufRef.current;
      if (!ir) {
        setStatus("No IR loaded.");
        return;
      }
      const conv = new ConvolverNode(ctx, { buffer: ir, disableNormalization: false });
      convRef.current = conv;
      src.connect(conv).connect(gain).connect(ctx.destination);
    } else {
      src.connect(gain).connect(ctx.destination);
    }

    src.start(0, at);
    startTimeRef.current = ctx.currentTime;
    setPlaying(true);
  }

  function currentOffset(): number {
    const ctx = audioCtxRef.current;
    if (!ctx) return 0;
    return startOffsetRef.current + (ctx.currentTime - startTimeRef.current);
  }

  function playPause() {
    if (!isPlaying) {
      makeGraph(startOffsetRef.current);
    } else {
      const off = currentOffset();
      teardownGraph();
      startOffsetRef.current = off;
      setPlaying(false);
    }
  }

  function stopAll() {
    teardownGraph();
    startOffsetRef.current = 0;
    setPlaying(false);
  }

  function onChangeMode(next: Mode) {
    if (next === mode) return;
    const off = isPlaying ? currentOffset() : startOffsetRef.current;
    teardownGraph();
    setMode(next);
    startOffsetRef.current = off;
    if (isPlaying) makeGraph(off);
  }

  function onChangeVol(v: number) {
    setVol(v);
    if (gainRef.current) gainRef.current.gain.value = v;
  }

  async function renderAndExport() {
    const music = musicBufRef.current;
    const ir = irBufRef.current;
    if (!music || !ir) {
      setStatus("Load music and IR first.");
      return;
    }

    const outLen = Math.max(1, music.length + ir.length - 1);
    const ch = music.numberOfChannels;
    const sr = music.sampleRate;

    const off = new OfflineAudioContext(ch, outLen, sr);
    const src = new AudioBufferSourceNode(off, { buffer: music });
    const conv = new ConvolverNode(off, { buffer: ir, disableNormalization: false });
    const gain = new GainNode(off, { gain: 1.0 });
    src.connect(conv).connect(gain).connect(off.destination);
    src.start();

    setStatus("Rendering…");
    const rendered = await off.startRendering();

    const rOrig = rmsBuffer(music);
    const rConv = rmsBuffer(rendered);
    const ratio = rConv > 0 ? rOrig / rConv : 1.0;
    if (ratio !== 1) scaleInPlace(rendered, Math.min(4, Math.max(0.1, ratio)));

    const wav = audioBufferToWav(rendered, 16);
    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    setStatus("Rendered. Click Download.");
  }

  function rmsBuffer(buf: AudioBuffer): number {
    let acc = 0,
      n = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const x = d[i];
        acc += x * x;
      }
      n += d.length;
    }
    return n ? Math.sqrt(acc / n) : 0;
  }

  function scaleInPlace(buf: AudioBuffer, g: number) {
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        let v = d[i] * g;
        if (v > 1) v = 1;
        if (v < -1) v = -1;
        d[i] = v;
      }
    }
  }

  function audioBufferToWav(buf: AudioBuffer, bitDepth: 16 | 24 | 32 = 16): ArrayBuffer {
    const numCh = buf.numberOfChannels;
    const len = buf.length;
    const sr = buf.sampleRate;

    const interleaved = new Float32Array(len * numCh);
    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        interleaved[i * numCh + ch] = buf.getChannelData(ch)[i];
      }
    }

    let bytesPerSample: number;
    let pcm: DataView;
    if (bitDepth === 16) {
      bytesPerSample = 2;
      const out = new ArrayBuffer(interleaved.length * 2);
      pcm = new DataView(out);
      for (let i = 0; i < interleaved.length; i++) {
        const s = Math.max(-1, Math.min(1, interleaved[i]));
        pcm.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    } else if (bitDepth === 24) {
      bytesPerSample = 3;
      const out = new ArrayBuffer(interleaved.length * 3);
      pcm = new DataView(out);
      for (let i = 0; i < interleaved.length; i++) {
        const s = Math.max(-1, Math.min(1, interleaved[i]));
        const v = Math.floor(s < 0 ? s * 0x800000 : s * 0x7fffff);
        pcm.setUint8(i * 3 + 0, v & 0xff);
        pcm.setUint8(i * 3 + 1, (v >> 8) & 0xff);
        pcm.setUint8(i * 3 + 2, (v >> 16) & 0xff);
      }
    } else {
      bytesPerSample = 4;
      const out = new ArrayBuffer(interleaved.length * 4);
      pcm = new DataView(out);
      for (let i = 0; i < interleaved.length; i++) {
        pcm.setFloat32(i * 4, interleaved[i], true);
      }
    }

    const blockAlign = numCh * bytesPerSample;
    const byteRate = sr * blockAlign;
    const dataSize = pcm.buffer.byteLength;
    const wav = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wav);

    writeStr(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, "WAVE");

    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    const format = bitDepth === 32 ? 3 : 1;
    view.setUint16(20, format, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    writeStr(view, 36, "data");
    view.setUint32(40, dataSize, true);
    new Uint8Array(wav, 44).set(new Uint8Array(pcm.buffer));
    return wav;
  }

  function writeStr(view: DataView, offset: number, s: string) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  }

  return (
    <div style={{ fontFamily: "system-ui", margin: 16, maxWidth: 900 }}>
      <h1>Harbeth SonicSuite — Web Convolver MVP</h1>

      <FileInputs onPickMusic={onPickMusic} onPickIR={onPickIR} />
      <ModeBar mode={mode} onChangeMode={onChangeMode} />
      <Transport
        isPlaying={isPlaying}
        playPause={playPause}
        stopAll={stopAll}
        vol={vol}
        onChangeVol={onChangeVol}
      />
      <ExportBar renderAndExport={renderAndExport} downloadUrl={downloadUrl} />

      <pre style={{ background: "#f5f5f5", padding: 12, borderRadius: 6, whiteSpace: "pre-wrap" }}>
        {status}
      </pre>

      <p style={{ color: "#666" }}>
        Notes: Playback uses Web Audio. Rendering uses OfflineAudioContext. RMS matched before export.
      </p>
    </div>
  );
}