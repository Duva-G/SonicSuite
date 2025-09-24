import { useEffect, useRef, useState } from "react";
import FileInputs from "./ui/FileInputs";
import Transport from "./ui/Transport";
import ModeBar from "./ui/ModeBar";
import type { Mode } from "./ui/ModeBar";
import ExportBar from "./ui/ExportBar";
import FRPink from "./ui/FRPink";
import FRPlayback from "./ui/FRPlayback";
import FRDifference from "./ui/FRDifference";
import IRProcessingPanel from "./ui/IRProcessingPanel";
import "./App.css";
import harbethLogo from "./assets/harbeth-logo.svg";

export default function App() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const convRef = useRef<ConvolverNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const convolverLatencyRef = useRef(0);
  const matchGainRef = useRef<GainNode | null>(null);

  const musicBufRef = useRef<AudioBuffer | null>(null);
  const irOriginalRef = useRef<AudioBuffer | null>(null);
  const irBufRef = useRef<AudioBuffer | null>(null);

  const startTimeRef = useRef(0);
  const startOffsetRef = useRef(0);

  const [isPlaying, setPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState<number>(0);
  const [mode, setMode] = useState<Mode>("original");
  const [originalVol, setOriginalVol] = useState<number>(1.0);
  const [convolvedVol, setConvolvedVol] = useState<number>(1.0);
  const [status, setStatus] = useState<string>("Load a music WAV and an IR WAV.");
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [view, setView] = useState<"playback" | "playback-fr" | "frdiff" | "frpink">("playback");
  const [sessionSampleRate, setSessionSampleRate] = useState<number>(44100);
  const [musicBuffer, setMusicBuffer] = useState<AudioBuffer | null>(null);
  const [irOriginal, setIrOriginal] = useState<AudioBuffer | null>(null);
  const [irBuffer, setIrBuffer] = useState<AudioBuffer | null>(null);
  const [convolvedMatchGain, setConvolvedMatchGain] = useState<number>(1);
  const [isConvolvedGainMatched, setConvolvedGainMatched] = useState(false);
  const [isMatchingRms, setMatchingRms] = useState(false);
  const [musicName, setMusicName] = useState<string>("");
  const [irName, setIrName] = useState<string>("");

  const transportDuration = musicBufRef.current?.duration ?? 0;
  const clampedPlaybackPosition = Math.min(playbackPosition, transportDuration || 0);


  function ensureCtx(): AudioContext {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
      setSessionSampleRate(audioCtxRef.current.sampleRate);
    }
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
      setMusicBuffer(buf);
      setMusicName(f.name);
      setSessionSampleRate(buf.sampleRate);
      setConvolvedGainMatched(false);
      startOffsetRef.current = 0;
      setPlaybackPosition(0);
      setStatus(`Music loaded: ${f.name} - ${buf.sampleRate} Hz - ${buf.duration.toFixed(2)} s`);
    } catch (err) {
      musicBufRef.current = null;
      setMusicBuffer(null);
      setMusicName("");
      setConvolvedGainMatched(false);
      startOffsetRef.current = 0;
      setPlaybackPosition(0);
      setStatus(`Music load failed: ${(err as Error).message}`);
    }
  }

  async function onPickIR(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const buf = await decodeFile(f);
      irOriginalRef.current = buf;
      setIrOriginal(buf);
      irBufRef.current = buf;
      setIrBuffer(buf);
      setIrName(f.name);
      setConvolvedMatchGain(1);
      setConvolvedGainMatched(false);
      if (matchGainRef.current) {
        matchGainRef.current.gain.value = 1;
      }
      if (mode === "convolved" && gainRef.current) {
        gainRef.current.gain.value = convolvedVol;
      }
      convolverLatencyRef.current = 0;
      const contextRate = audioCtxRef.current?.sampleRate ?? buf.sampleRate;
      setSessionSampleRate(contextRate);
      setStatus((s) =>
        s + `
IR loaded: ${f.name} - ${buf.sampleRate} Hz - ${buf.duration.toFixed(3)} s`
      );
    } catch (err) {
      irOriginalRef.current = null;
      irBufRef.current = null;
      setIrOriginal(null);
      setIrBuffer(null);
      setIrName("");
      setConvolvedMatchGain(1);
      setConvolvedGainMatched(false);
      if (matchGainRef.current) {
        matchGainRef.current.gain.value = 1;
      }
      if (mode === "convolved" && gainRef.current) {
        gainRef.current.gain.value = convolvedVol;
      }
      convolverLatencyRef.current = 0;
      setStatus(`IR load failed: ${(err as Error).message}`);
    }
  }

  function teardownGraph() {
    if (srcRef.current) {
      srcRef.current.onended = null;
    }
    try {
      srcRef.current?.stop();
    } catch (err: unknown) {
      console.warn("Audio source stop failed", err);
    }
    srcRef.current?.disconnect();
    convRef.current?.disconnect();
    matchGainRef.current?.disconnect();
    gainRef.current?.disconnect();
    srcRef.current = null;
    convRef.current = null;
    matchGainRef.current = null;
    gainRef.current = null;
  }

  function makeGraph(at: number, playbackMode: Mode = mode) {
    const ctx = ensureCtx();
    const music = musicBufRef.current;
    if (!music) {
      setStatus("No music loaded.");
      return;
    }

    const src = new AudioBufferSourceNode(ctx, { buffer: music });
    const matchValue = Math.max(convolvedMatchGain, 1e-6);
    const initialGain = playbackMode === "convolved" ? convolvedVol : originalVol;
    const volume = new GainNode(ctx, { gain: initialGain });
    srcRef.current = src;
    gainRef.current = volume;
    startOffsetRef.current = at;
    setPlaybackPosition(Math.min(at, music.duration));

    if (playbackMode === "convolved") {
      const ir = irBufRef.current;
      if (!ir) {
        setStatus("No IR loaded.");
        matchGainRef.current = null;
        convRef.current = null;
        convolverLatencyRef.current = 0;
        return;
      }
      const latencySamples = computeAnalysisOffset(ir, ir.length);
      convolverLatencyRef.current = latencySamples / ctx.sampleRate;
      const conv = new ConvolverNode(ctx, { buffer: ir, disableNormalization: false });
      const matchGain = new GainNode(ctx, { gain: matchValue });
      convRef.current = conv;
      matchGainRef.current = matchGain;
      src.connect(conv).connect(matchGain).connect(volume).connect(ctx.destination);
    } else {
      convolverLatencyRef.current = 0;
      matchGainRef.current = null;
      convRef.current = null;
      src.connect(volume).connect(ctx.destination);
    }

    src.onended = () => {
      if (srcRef.current !== src) return;
      startOffsetRef.current = 0;
      setPlaybackPosition(0);
      setPlaying(false);
      teardownGraph();
    };

    const latency = playbackMode === "convolved" ? convolverLatencyRef.current : 0;
    const startAt = Math.max(0, at - latency);
    src.start(0, startAt);
    startTimeRef.current = ctx.currentTime;
    setPlaying(true);
  }

  function currentOffset(): number {
    const ctx = audioCtxRef.current;
    if (!ctx) return 0;
    return startOffsetRef.current + (ctx.currentTime - startTimeRef.current);
  }

  useEffect(() => {
    let raf = 0;

    const update = () => {
      const music = musicBufRef.current;
      const duration = music?.duration ?? 0;
      const next = Math.min(currentOffset(), duration);
      setPlaybackPosition(next);
      raf = requestAnimationFrame(update);
    };

    if (isPlaying) {
      raf = requestAnimationFrame(update);
    } else {
      const music = musicBufRef.current;
      const duration = music?.duration ?? 0;
      const clamped = Math.min(startOffsetRef.current, duration);
      setPlaybackPosition(clamped);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isPlaying]);

  function playPause() {
    if (!isPlaying) {
      makeGraph(startOffsetRef.current, mode);
    } else {
      const music = musicBufRef.current;
      const duration = music?.duration ?? Infinity;
      const off = Math.min(currentOffset(), duration);
      teardownGraph();
      startOffsetRef.current = off;
      setPlaybackPosition(off);
      setPlaying(false);
    }
  }

  function stopAll() {
    teardownGraph();
    startOffsetRef.current = 0;
    setPlaybackPosition(0);
    setPlaying(false);
  }

  function seekTo(seconds: number, resume?: boolean) {
    const music = musicBufRef.current;
    if (!music) return;
    const duration = music.duration;
    const target = Math.max(0, Math.min(seconds, duration));
    const wasPlaying = isPlaying;
    const shouldResume = resume ?? wasPlaying;
    if (wasPlaying) {
      teardownGraph();
      setPlaying(false);
    }
    startOffsetRef.current = target;
    setPlaybackPosition(target);
    if (shouldResume && target < duration) {
      makeGraph(target, mode);
    } else {
      setPlaying(false);
    }
  }

  function skipBy(delta: number) {
    const music = musicBufRef.current;
    if (!music) return;
    const base = isPlaying ? currentOffset() : startOffsetRef.current;
    seekTo(base + delta, isPlaying);
  }

  function onChangeMode(next: Mode) {
    if (next === mode) return;
    const wasPlaying = isPlaying;
    const off = wasPlaying ? currentOffset() : startOffsetRef.current;
    const music = musicBufRef.current;
    const duration = music?.duration ?? Infinity;
    const clamped = Math.min(off, duration);
    teardownGraph();
    setMode(next);
    startOffsetRef.current = clamped;
    setPlaybackPosition(clamped);
    if (wasPlaying) makeGraph(clamped, next);
  }

  function onChangeOriginalVol(v: number) {
    setOriginalVol(v);
    if (gainRef.current && mode === "original") {
      gainRef.current.gain.value = v;
    }
  }

  function onChangeConvolvedVol(v: number) {
    setConvolvedVol(v);
    if (gainRef.current && mode === "convolved") {
      gainRef.current.gain.value = v;
    }
  }

  function handleIrManualTrim(startMs: number, endMs: number) {
    const original = irOriginalRef.current;
    if (!original) {
      setStatus("Load an impulse response before trimming.");
      return;
    }

    const sr = original.sampleRate;
    const startSample = Math.max(0, Math.floor((startMs / 1000) * sr));
    const endSample = Math.min(original.length, Math.floor((endMs / 1000) * sr));
    if (endSample - startSample < 32) {
      setStatus("IR trim range is too short.");
      return;
    }

    const trimmed = sliceAudioBuffer(original, startSample, endSample);
    applyProcessedIr(trimmed, `IR trimmed to ${trimmed.duration.toFixed(3)} s`);
  }

  function handleIrAutoTrim() {
    const original = irOriginalRef.current;
    if (!original) {
      setStatus("Load an impulse response before trimming.");
      return;
    }

    const sr = original.sampleRate;
    const mono = new Float32Array(original.length);
    for (let ch = 0; ch < original.numberOfChannels; ch++) {
      const data = original.getChannelData(ch);
      for (let i = 0; i < original.length; i++) mono[i] += Math.abs(data[i]);
    }
    const inv = original.numberOfChannels > 0 ? 1 / original.numberOfChannels : 1;
    for (let i = 0; i < mono.length; i++) mono[i] *= inv;

    let peak = 0;
    for (let i = 0; i < mono.length; i++) {
      const v = Math.abs(mono[i]);
      if (v > peak) peak = v;
    }
    if (!Number.isFinite(peak) || peak === 0) {
      setStatus("Auto trim could not detect a valid region; keeping original IR.");
      return;
    }

    const energy = mono.reduce((acc, v) => acc + v * v, 0);
    const energyTarget = energy * 0.0005;
    const amplitudeFloor = peak * 0.0001;

    let startSample = 0;
    let accum = 0;
    while (startSample < mono.length) {
      const v = mono[startSample];
      accum += v * v;
      if (accum >= energyTarget || Math.abs(v) >= amplitudeFloor) break;
      startSample++;
    }

    let endSample = mono.length - 1;
    accum = 0;
    while (endSample > startSample) {
      const v = mono[endSample];
      accum += v * v;
      if (accum >= energyTarget || Math.abs(v) >= amplitudeFloor) break;
      endSample--;
    }
    endSample++;

    const minWindow = Math.max(32, Math.round(sr * 0.05));
    if (endSample - startSample < minWindow) {
      endSample = Math.min(original.length, startSample + minWindow);
      if (endSample - startSample < minWindow) startSample = Math.max(0, endSample - minWindow);
    }

    const safety = Math.round(sr * 0.002);
    startSample = Math.max(0, startSample - safety);
    endSample = Math.min(original.length, endSample + safety);

    if (endSample - startSample < 32) {
      setStatus("Auto trim could not find a prominent region; keeping original IR.");
      return;
    }

    const trimmed = sliceAudioBuffer(original, startSample, endSample);
    applyProcessedIr(
      trimmed,
      `IR auto-trimmed to ${trimmed.duration.toFixed(3)} s (start ${((startSample / sr) * 1000).toFixed(1)} ms)`
    );
  }


  function handleIrReset() {
    const original = irOriginalRef.current;
    if (!original) return;
    const clone = cloneAudioBuffer(original);
    applyProcessedIr(clone, "IR trim reset to original length.");
  }

  function applyProcessedIr(buffer: AudioBuffer, message: string) {
    irBufRef.current = buffer;
    setIrBuffer(buffer);
    setConvolvedMatchGain(1);
    setConvolvedGainMatched(false);
    if (matchGainRef.current) {
      matchGainRef.current.gain.value = 1;
    }
    if (mode === "convolved" && gainRef.current) {
      gainRef.current.gain.value = convolvedVol;
    }
    convolverLatencyRef.current = 0;
    setStatus((s) => s + `
${message}`);
  }

  function sliceAudioBuffer(buffer: AudioBuffer, startSample: number, endSample: number): AudioBuffer {
    const length = Math.max(32, endSample - startSample);
    const sliced = new AudioBuffer({
      length,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const source = buffer.getChannelData(ch);
      const target = sliced.getChannelData(ch);
      target.set(source.subarray(startSample, startSample + length));
    }
    return sliced;
  }

  function cloneAudioBuffer(buffer: AudioBuffer): AudioBuffer {
    const clone = new AudioBuffer({
      length: buffer.length,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      clone.getChannelData(ch).set(buffer.getChannelData(ch));
    }
    return clone;
  }

  async function matchConvolvedRMS() {
    const music = musicBufRef.current;
    const ir = irBufRef.current;
    if (!music || !ir) {
      setStatus("Load music and IR first.");
      return;
    }

    setMatchingRms(true);
    setConvolvedGainMatched(false);
    try {
      const targetRate = audioCtxRef.current?.sampleRate ?? music.sampleRate;
      const dryBuffer = resampleAudioBuffer(music, targetRate);
      const wetIr = resampleAudioBuffer(ir, targetRate);
      const offlineLength = Math.max(1, dryBuffer.length + wetIr.length - 1);
      const offline = new OfflineAudioContext(dryBuffer.numberOfChannels, offlineLength, targetRate);
      const drySource = new AudioBufferSourceNode(offline, { buffer: dryBuffer });
      const conv = new ConvolverNode(offline, { buffer: wetIr, disableNormalization: false });
      const gain = new GainNode(offline, { gain: 1 });
      drySource.connect(conv).connect(gain).connect(offline.destination);
      drySource.start();
      const rendered = await offline.startRendering();

      const offset = computeAnalysisOffset(wetIr, rendered.length);
      convolverLatencyRef.current = offset / targetRate;
      const [dryRms, wetRms] = alignedRmsPair(dryBuffer, rendered, offset);
      let ratio = wetRms > 0 ? dryRms / wetRms : 1;
      if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1;
      const clamped = Math.min(4, Math.max(0.1, ratio));
      setConvolvedMatchGain(clamped);
      setConvolvedGainMatched(true);
      if (matchGainRef.current) {
        matchGainRef.current.gain.value = clamped;
      }
      if (mode === "convolved" && gainRef.current) {
        gainRef.current.gain.value = convolvedVol;
      }
      if (mode === "original" && gainRef.current) {
        gainRef.current.gain.value = originalVol;
      }
      setStatus((s) => s + `
Playback RMS gain set to ${clamped.toFixed(2)}x.`);
    } catch (err) {
      setStatus(`RMS match failed: ${(err as Error).message}`);
    } finally {
      setMatchingRms(false);
    }
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

    setStatus("Renderingâ€¦");
    const rendered = await off.startRendering();

    const irForAnalysis = resampleAudioBuffer(ir, sr);
    const analysisOffset = computeAnalysisOffset(irForAnalysis, rendered.length);
    const [rOrig, rConv] = alignedRmsPair(music, rendered, analysisOffset);
    const ratio = rConv > 0 ? rOrig / rConv : 1.0;
    if (ratio !== 1) scaleInPlace(rendered, Math.min(4, Math.max(0.1, ratio)));

    const wav = audioBufferToWav(rendered, 16);
    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    setStatus("Rendered. Click Download.");
  }

  function rmsBuffer(buf: AudioBuffer, frameCount?: number, offset = 0): number {
    const start = Math.max(0, Math.min(offset, buf.length));
    const available = buf.length - start;
    const frames = Math.min(frameCount ?? available, available);
    if (frames <= 0) return 0;
    const channels = buf.numberOfChannels;
    if (channels === 0) return 0;
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        const x = data[start + i];
        acc += x * x;
      }
    }
    const count = frames * channels;
    return count ? Math.sqrt(acc / count) : 0;
  }

  function impulseOffset(buf: AudioBuffer): number {
    const threshold = 0.0005;
    let minIndex = buf.length;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < buf.length; i++) {
        if (Math.abs(data[i]) > threshold) {
          if (i < minIndex) minIndex = i;
          break;
        }
      }
    }
    if (!Number.isFinite(minIndex) || minIndex >= buf.length) return 0;
    return minIndex;
  }

  function computeAnalysisOffset(irBuffer: AudioBuffer, maxFrames: number): number {
    const raw = impulseOffset(irBuffer);
    return Math.min(raw, Math.max(0, maxFrames - 1));
  }

  function alignedRmsPair(dry: AudioBuffer, wet: AudioBuffer, offset: number): [number, number] {
    if (dry.length === 0 || wet.length === 0) return [0, 0];
    const wetAvailable = Math.max(0, wet.length - offset);
    let frames = Math.min(dry.length, wetAvailable);
    if (frames <= 0) frames = Math.min(dry.length, wet.length);
    if (frames <= 0) return [0, 0];
    const wetOffset = Math.max(0, Math.min(offset, wet.length - frames));
    const dryOffset = 0;
    const dryRms = rmsBuffer(dry, frames, dryOffset);
    const wetRms = rmsBuffer(wet, frames, wetOffset);
    return [dryRms, wetRms];
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

  function resampleAudioBuffer(buffer: AudioBuffer, targetRate: number): AudioBuffer {
    if (buffer.sampleRate === targetRate) return buffer;
    const duration = buffer.length / buffer.sampleRate;
    const newLength = Math.max(1, Math.round(duration * targetRate));
    const resampled = new AudioBuffer({
      length: newLength,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: targetRate,
    });
    const ratio = buffer.sampleRate / targetRate;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dest = resampled.getChannelData(ch);
      for (let i = 0; i < newLength; i++) {
        const srcPos = i * ratio;
        const idx = Math.floor(srcPos);
        const frac = srcPos - idx;
        const s0 = src[Math.min(idx, src.length - 1)];
        const s1 = src[Math.min(idx + 1, src.length - 1)];
        dest[i] = s0 + (s1 - s0) * frac;
      }
    }
    return resampled;
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

  const canMatchRms = Boolean(musicBufRef.current && irBuffer);

  return (
    <div className="app">
      <div className="app-shell">
        <header className="app-header">
          <img src={harbethLogo} alt="Harbeth Audio" className="app-logo" />
          <h1 className="app-title">SonicSuite Convolver</h1>
          <p className="app-subtitle">
            Harbeth SonicSuite: a powerful tool to convolve, compare, and analyse audio with precision.
          </p>
        </header>

        <FileInputs
          onPickMusic={onPickMusic}
          onPickIR={onPickIR}
          musicBuffer={musicBuffer}
          musicName={musicName}
          irBuffer={irBuffer}
          irName={irName}
        />

        {irOriginal && (
          <IRProcessingPanel
            original={irOriginal}
            processed={irBuffer}
            irName={irName}
            onManualTrim={handleIrManualTrim}
            onAutoTrim={handleIrAutoTrim}
            onReset={handleIrReset}
          />
        )}

        <section className="panel status-panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Session status</h2>
              <p className="panel-desc">Track file loading, rendering progress, and export readiness.</p>
            </div>
          </div>
          <pre>{status}</pre>
        </section>

        <section className="panel view-panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Workspace view</h2>
              <p className="panel-desc">Choose between playback controls and frequency-response visualisations.</p>
            </div>
          </div>
          <div className="segmented-control" role="group" aria-label="Workspace view selector">
            <button
              type="button"
              className={`segmented-control__segment${view === "playback" ? " is-active" : ""}`}
              onClick={() => setView("playback")}
            >
              Playback Controls
            </button>
            <button
              type="button"
              className={`segmented-control__segment${view === "playback-fr" ? " is-active" : ""}`}
              onClick={() => setView("playback-fr")}
            >
              FR (Playback)
            </button>
            <button
              type="button"
              className={`segmented-control__segment${view === "frdiff" ? " is-active" : ""}`}
              onClick={() => setView("frdiff")}
            >
              FR (Difference)
            </button>
            <button
              type="button"
              className={`segmented-control__segment${view === "frpink" ? " is-active" : ""}`}
              onClick={() => setView("frpink")}
            >
              FR (Pink Noise)
            </button>
          </div>
        </section>

        {view === "playback" ? (
          <>
            <section className="panel playback-panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Playback Panel</h2>
                  <p className="panel-desc">Switch modes, control transport, and balance the convolved gain.</p>
                </div>
              </div>
              <ModeBar mode={mode} onChangeMode={onChangeMode} />
              <div className="rms-match">
                <button
                  type="button"
                  className={`control-button button-ghost rms-match__button${isConvolvedGainMatched ? " is-matched" : ""}`}
                  onClick={matchConvolvedRMS}
                  disabled={isMatchingRms || !canMatchRms}
                  aria-pressed={isConvolvedGainMatched}
                >
                  {isMatchingRms ? "Matching..." : isConvolvedGainMatched ? "RMS Matched" : "Match RMS (Convolved)"}
                </button>
              </div>
              <Transport
                isPlaying={isPlaying}
                playPause={playPause}
                stopAll={stopAll}
                originalVol={originalVol}
                onChangeOriginalVol={onChangeOriginalVol}
                convolvedVol={convolvedVol}
                onChangeConvolvedVol={onChangeConvolvedVol}
                duration={transportDuration}
                position={clampedPlaybackPosition}
                onSeek={seekTo}
                onSkipForward={() => skipBy(10)}
                onSkipBackward={() => skipBy(-10)}
              />
            </section>

            <ExportBar renderAndExport={renderAndExport} downloadUrl={downloadUrl} />
          </>
        ) : view === "playback-fr" ? (
          <section className="panel frpink-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Playback FR</h2>
                <p className="panel-desc">Overlay the spectrum of the original track and its convolved version.</p>
              </div>
            </div>
            <FRPlayback musicBuffer={musicBufRef.current} irBuffer={irBuffer} sampleRate={sessionSampleRate} />
          </section>
        ) : view === "frdiff" ? (
          <section className="panel frpink-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Playback Difference</h2>
                <p className="panel-desc">Inspect how the convolved playback deviates from the original.</p>
              </div>
            </div>
            <FRDifference musicBuffer={musicBufRef.current} irBuffer={irBuffer} sampleRate={sessionSampleRate} />
          </section>
        ) : (
          <section className="panel frpink-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">FR (Pink Noise)</h2>
                <p className="panel-desc">Visualise the response of the loaded impulse against pink noise.</p>
              </div>
            </div>
            <FRPink irBuffer={irBuffer} sampleRate={sessionSampleRate} label="A" />
          </section>
        )}

        <p className="footnote">
          Notes: Playback uses Web Audio. Rendering uses OfflineAudioContext. RMS matched before export.
        </p>
      </div>
    </div>
  );
}




