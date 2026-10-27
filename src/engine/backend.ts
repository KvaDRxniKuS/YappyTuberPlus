import { invoke } from "@tauri-apps/api/core";

export interface EngineResponse {
  ok: boolean;
  handle?: number;
  frame?: import("../types").RigFrame;
  error?: string;
  diagnostics?: string[];
  /** Ответ `check`: первая ошибка скрипта или `null`, если всё разбирается. */
  scriptError?: import("../types").ScriptErrorInfo | null;
  /** Ответ `check`: все ошибки с местом и вторым объявлением, если оно есть. */
  scriptIssues?: import("../types").ScriptIssueInfo[];
  /** Ответ `version`: поколение ядра. Старое WASM такого запроса не знает. */
  core?: number;
  /**
   * Ответ `version`: старейшее поколение сценариев, которое ядро ещё понимает.
   *
   * Растёт только при удалении или смене смысла старого поведения. Ядро,
   * собранное до появления поля, его не присылает — тогда считается первое
   * поколение: старое ядро не могло ничего удалить из будущего.
   */
  acceptsFrom?: number;
}

export interface EngineBackend {
  readonly label: string;
  /**
   * Кадры считает сам Rust-планировщик: в нативном приложении цикл не зависит
   * от видимого окна, поэтому оверлей не замирает при свёрнутом редакторе.
   * В браузере кадры продвигает `requestAnimationFrame`, как и раньше.
   */
  readonly native: boolean;
  call(request: Record<string, unknown>): Promise<EngineResponse>;
}

interface RigExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  rig_alloc(length: number): number;
  rig_free(pointer: number, length: number): void;
  rig_call(pointer: number, length: number): bigint;
}

class WasmBackend implements EngineBackend {
  readonly label = "Rust · WASM";
  readonly native = false;
  constructor(private readonly exports: RigExports) {}

  async call(request: Record<string, unknown>): Promise<EngineResponse> {
    const input = new TextEncoder().encode(JSON.stringify(request));
    const inputPointer = this.exports.rig_alloc(input.length);
    new Uint8Array(this.exports.memory.buffer, inputPointer, input.length).set(input);
    let packed: bigint;
    try {
      packed = this.exports.rig_call(inputPointer, input.length);
    } finally {
      this.exports.rig_free(inputPointer, input.length);
    }
    const outputPointer = Number(packed & 0xffffffffn);
    const outputLength = Number((packed >> 32n) & 0xffffffffn);
    const output = new TextDecoder().decode(
      new Uint8Array(this.exports.memory.buffer, outputPointer, outputLength),
    );
    this.exports.rig_free(outputPointer, outputLength);
    return JSON.parse(output) as EngineResponse;
  }
}

class TauriBackend implements EngineBackend {
  readonly label = "Rust · native";
  readonly native = true;
  async call(request: Record<string, unknown>): Promise<EngineResponse> {
    const result = await invoke<string>("rig_call", { request: JSON.stringify(request) });
    return JSON.parse(result) as EngineResponse;
  }
}

let backendPromise: Promise<EngineBackend> | null = null;

export function getEngineBackend(): Promise<EngineBackend> {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    if ("__TAURI_INTERNALS__" in window) return new TauriBackend();
    const response = await fetch("/rig_core.wasm");
    if (!response.ok) throw new Error(`Не удалось загрузить Rust WASM: ${response.status}`);
    const bytes = await response.arrayBuffer();
    const instance = await WebAssembly.instantiate(bytes, {});
    return new WasmBackend(instance.instance.exports as unknown as RigExports);
  })().catch((error) => {
    backendPromise = null;
    throw error;
  });
  return backendPromise;
}
