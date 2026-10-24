import type { ModuleConfig, ModuleType } from "../types";

export interface ModuleInputSpec {
  /** Имя входа без префикса: в скрипте выглядит как `<имя модуля>.<name>`. */
  name: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** `db` — децибелы (по умолчанию −60), остальное 0…1. */
  kind?: "level" | "db" | "flag";
  hint?: string;
}

export interface ModuleDefinition {
  type: ModuleType;
  title: string;
  description: string;
  /** Есть живой источник звука: экземпляр можно переключить на микрофон. */
  audio?: boolean;
  inputs: ModuleInputSpec[];
  /** Настройки нового экземпляра. */
  defaults: ModuleConfig;
}

const LOUDNESS: ModuleDefinition = {
  type: "loudness",
  title: "Loudness",
  description: "Уровень речи с микрофона: громкость, пик, децибелы и флаг разговора.",
  audio: true,
  defaults: { gain: 1, threshold: -43, processing: false },
  inputs: [
    { name: "speak", label: "Речь (сглаженная)", min: 0, max: 1, kind: "level" },
    { name: "loudness", label: "Пик", min: 0, max: 1, kind: "level" },
    { name: "db", label: "Децибелы", min: -80, max: 0, step: 1, kind: "db" },
    { name: "talking", label: "Разговор", min: 0, max: 1, step: 1, kind: "flag" },
  ],
};

const VISEME: ModuleDefinition = {
  type: "viseme",
  title: "Viseme",
  description: "Ручные виземы A/E/I/O/U — заглушка вместо настоящего липсинка.",
  defaults: {},
  inputs: [
    { name: "a", label: "A", min: 0, max: 1, kind: "level" },
    { name: "e", label: "E", min: 0, max: 1, kind: "level" },
    { name: "i", label: "I", min: 0, max: 1, kind: "level" },
    { name: "o", label: "O", min: 0, max: 1, kind: "level" },
    { name: "u", label: "U", min: 0, max: 1, kind: "level" },
  ],
};

const MANUAL: ModuleDefinition = {
  type: "manual",
  title: "Manual",
  description: "Ручные сигналы: моргание и другие значения, которые не приходят извне.",
  defaults: {},
  inputs: [
    { name: "blink", label: "Моргание", min: 0, max: 1, step: 0.01, kind: "flag", hint: "Кнопка «моргнуть» ставит 1 на 160 мс." },
  ],
};

export const MODULES: ModuleDefinition[] = [LOUDNESS, VISEME, MANUAL];

export function moduleDefinition(type: ModuleType): ModuleDefinition {
  return MODULES.find((definition) => definition.type === type) || MANUAL;
}

/** Значение по умолчанию для входа: у децибел это тишина, у остальных ноль. */
export function inputDefault(spec: ModuleInputSpec): number {
  return spec.kind === "db" ? -60 : 0;
}

export function isKnownModuleType(type: string): type is ModuleType {
  return MODULES.some((definition) => definition.type === type);
}
