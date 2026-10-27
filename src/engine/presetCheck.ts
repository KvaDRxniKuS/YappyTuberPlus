/**
 * Совместимость открываемого пресета с этим редактором.
 *
 * Отказ открывать файл сам по себе бесполезен: «пресет новее» ничего не говорит
 * о том, что именно сломается. Поэтому перед отказом файл разбирается как
 * данные — версии слоёв, виды объектов, требование к ядру, убранные формы
 * языка, — и редактор показывает список того, что может не работать.
 *
 * Отдельного режима «только для чтения» нет: несовместимый файл не открывается,
 * но объяснение должно быть таким, чтобы человек понял, обновлять ли редактор
 * или просить у автора пресет попроще.
 */
import { PRESET_FORMAT, PRESET_FORMATS_READABLE, VERSION, parseVersion, versionLabel } from "../version";
import { needsReport } from "./coreFeatures";
import type { RigPreset } from "../types";

/** Виды объектов, которые этот редактор умеет показывать. */
const KNOWN_KINDS: readonly string[] = ["sprite", "group", "media", "text", "shape", "light"];

/** Один пункт списка «что может не работать». */
export interface CompatibilityIssue {
  /** Короткий заголовок пункта. */
  label: string;
  /** Что именно случится на практике. */
  detail: string;
}

export interface CompatibilityReport {
  /** Можно ли открыть файл этим редактором. */
  canOpen: boolean;
  /** Паспорт файла, если он записан (`built`). */
  fileVersion: string | null;
  /** Человеческая запись паспорта файла. */
  fileLabel: string | null;
  /** Что может не работать: список для диалога. */
  issues: CompatibilityIssue[];
}

/**
 * Ошибка «версии несовместимы».
 *
 * Несёт с собой готовый отчёт: интерфейс показывает его диалогом, а не строкой
 * в тосте, потому что пунктов бывает несколько.
 */
export class IncompatiblePresetError extends Error {
  readonly report: CompatibilityReport;

  constructor(report: CompatibilityReport) {
    super(report.fileVersion
      ? `Версии несовместимы: файл ${report.fileVersion}, редактор ${versionLabel()}.`
      : "Это не пресет YappyTuberPlus или его версия несовместима с редактором.");
    this.name = "IncompatiblePresetError";
    this.report = report;
  }
}

/** Разбор файла как данных: что в нём есть и что редактор не поймёт. */
export function presetCompatibility(raw: unknown): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];
  if (!raw || typeof raw !== "object") {
    return {
      canOpen: false,
      fileVersion: null,
      fileLabel: null,
      issues: [{ label: "это не пресет", detail: "В файле нет описания сцены — возможно, это не JSON пресета." }],
    };
  }
  const preset = raw as Partial<RigPreset>;
  const objects = Array.isArray(preset.objects) ? preset.objects : [];
  const fileVersion = typeof preset.built === "string" ? preset.built : null;
  const parsed = parseVersion(fileVersion);
  const format = Number(preset.version);
  const readable = PRESET_FORMATS_READABLE.includes(format);
  const canOpen = readable && Array.isArray(preset.objects) && Boolean(preset.canvas);

  // Формат — единственное, что решает «открывать или нет».
  if (Number.isFinite(format) && format > PRESET_FORMAT) {
    issues.push({
      label: `формат файла ${format} против ${PRESET_FORMAT}`,
      detail: "Редактор знает только прежние поколения: незнакомые поля и виды объектов "
        + "он не прочитает, а при первом же сохранении потеряет их молча.",
    });
  } else if (Number.isFinite(format) && !readable) {
    issues.push({
      label: `формат файла ${format}`,
      detail: `Этот редактор читает поколения ${PRESET_FORMATS_READABLE.join(" и ")} — файл слишком старый или слишком новый.`,
    });
  }

  // Виды объектов: их видно, даже если формат незнакомый.
  const kinds = new Set(objects.map((object) => (object as { kind?: unknown })?.kind)
    .filter((kind): kind is string => typeof kind === "string"));
  const unknownKinds = [...kinds].filter((kind) => !KNOWN_KINDS.includes(kind));
  if (unknownKinds.length) {
    issues.push({
      label: "незнакомый вид объекта",
      detail: `«${unknownKinds.join("», «")}» — такие объекты не покажутся или покажутся как спрайты.`,
    });
  }

  // Требование к ядру и убранные формы считаются по содержимому сцены.
  if (Array.isArray(preset.objects)) {
    const report = needsReport(preset as RigPreset);
    const required = Math.max(report.needs, typeof preset.needs === "number" ? preset.needs : 0);
    if (required > VERSION.core) {
      const reasons = report.reasons
        .filter((reason) => reason.since > VERSION.core)
        .map((reason) => reason.label);
      issues.push({
        label: `сцене нужно ядро ${required}, у редактора ${VERSION.core}`,
        detail: reasons.length
          ? `${reasons.join(", ")} — без них формулы вернут 0.`
          : `У редактора ядро ${VERSION.core}: новые формулы этой сцены вернут 0.`,
      });
    }
    if (report.removed.length) {
      issues.push({
        label: "в сцене есть убранные формы языка",
        detail: `${report.removed.map((item) => `${item.label} (убрано в ядре ${item.removed})`).join(", ")} — `
          + "такую сцену нужно переписать, иначе она не разберётся.",
      });
    }
  }

  // Остальные слои видны только по штампу сборки, которая записала файл.
  if (parsed) {
    if (parsed.bridge > VERSION.bridge) {
      issues.push({
        label: `мост ${parsed.bridge} против ${VERSION.bridge}`,
        detail: "Кадры этой сцены оверлей такой сборки может не понять: картинка в OBS замрёт.",
      });
    }
    if (parsed.modules > VERSION.modules) {
      issues.push({
        label: `модули ${parsed.modules} против ${VERSION.modules}`,
        detail: "Незнакомые виды модулей станут «Manual», их настройки не покажутся.",
      });
    }
    if (parsed.shell > VERSION.shell) {
      issues.push({
        label: `оболочка ${parsed.shell} против ${VERSION.shell}`,
        detail: "Пресет ждёт окон, клавиш или планировщика, которых в этой сборке приложения нет.",
      });
    }
  }

  if (!canOpen && !issues.length) {
    issues.push({
      label: "файл не похож на пресет",
      detail: "Нет описания сцены или холста — открывать нечего.",
    });
  }

  return {
    canOpen,
    fileVersion,
    fileLabel: parsed ? versionLabel(parsed) : null,
    issues,
  };
}
