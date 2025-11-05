export type WorkerInitResult = {
  worker: Worker | null;
  error: Error | null;
};

type WorkerFactory = () => Worker;

export function createModuleWorker(factory: WorkerFactory): WorkerInitResult {
  if (typeof Worker === "undefined") {
    return {
      worker: null,
      error: new Error("Web Workers are not supported in this environment."),
    };
  }

  try {
    const worker = factory();
    return { worker, error: null };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { worker: null, error };
  }
}
