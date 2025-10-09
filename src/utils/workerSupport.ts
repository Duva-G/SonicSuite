export type WorkerInitResult = {
  worker: Worker | null;
  error: Error | null;
};

export function createModuleWorker(scriptUrl: string | URL, options?: WorkerOptions): WorkerInitResult {
  if (typeof Worker === "undefined") {
    return {
      worker: null,
      error: new Error("Web Workers are not supported in this environment."),
    };
  }

  try {
    const worker = new Worker(scriptUrl, { ...options, type: options?.type ?? "module" });
    return { worker, error: null };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { worker: null, error };
  }
}
