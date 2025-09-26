/// <reference lib="webworker" />

import { downsample } from "../../audio/downsample";
import type { DownsampleInput, DownsampleOutput } from "../../audio/downsample";

type DownsampleRequest = {
  id: number;
  payload: DownsampleInput;
};

type DownsampleSuccess = DownsampleOutput & { id: number };
type DownsampleFailure = { id: number; error: string };

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<DownsampleRequest>) => {
  const { id, payload } = event.data;

  try {
    const result = downsample(payload);
    const transfer: Transferable[] = [
      result.times.buffer,
      ...result.channelSamples.map((array) => array.buffer),
    ];
    const response: DownsampleSuccess = { id, ...result };
    self.postMessage(response, transfer);
  } catch (error) {
    const response: DownsampleFailure = {
      id,
      error:
        error instanceof Error ? error.message : "Unknown downsample error",
    };
    self.postMessage(response);
  }
});
