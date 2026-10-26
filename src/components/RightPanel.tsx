import { useEffect, useState } from "react";
import { Blocks, Braces, ChevronRight, CircleAlert, Gauge, Globe2, SlidersHorizontal, Spline } from "lucide-react";
import type { InputValues, ModuleInstance, RigFrame, RigObject } from "../types";
import type { AudioFrame, DeviceOption } from "../modules/audio";
import { ScriptEditor } from "./ScriptEditor";
import { enumConstants } from "../modules/manual";
import { InputsPanel } from "./InputsPanel";
import { BehaviourPanel } from "./BehaviourPanel";
import { ModulesPanel } from "./ModulesPanel";
import { moduleInputs as moduleInputKeys } from "../modules/values";
import type { CalibrationApi } from "./VisemeCalibration";
import type { ExternalLogEntry, ExternalStatus, ExternalTextLine } from "../modules/sources";
import type { ScriptCheck, ScriptScope } from "../engine/scripts";
import {
  diagnosticName, diagnosticPlace, eventNames, scopeTitle,
} from "../engine/scripts";

interface RightPanelProps {
  selected: RigObject | null;
  /** Сколько всего объектов выделено — скрипт показывается для основного. */
  selectedCount: number;
  objects: RigObject[];
  globals: string[];
  globalScript: string;
  frame: RigFrame | null;
  engineError: string | null;
  inputs: InputValues;
  modules: ModuleInstance[];
  audio: Record<string, AudioFrame>;
  manual: Record<string, number>;
  auto: Record<string, number>;
  devices: DeviceOption[];
  audioError: string | null;
  onObjectScript: (script: string) => void;
  /** Пресет поведения: пишет блоки формул в скрипты выделенных объектов. */
  onBehaviour: (scripts: Record<string, string>) => void;
  /** Настройки текста (шрифт, оформление, источник) у выделенных объектов. */
  onText: (objects: RigObject[]) => void;
  /** Выделение целиком: поведение правится сразу у всех. */
  selectedObjects: RigObject[];
  onGlobalScript: (script: string) => void;
  onModules: (modules: ModuleInstance[], label?: string) => void;
  onManual: (key: string, value: number) => void;
  /** Вставка готового блока события в скрипт. */
  onInsertSnippet: (snippet: string) => void;
  /** Проверка скрипта в ядре: подсветка ошибки. */
  checkScript?: ScriptCheck;
  /** Выбрать объект: переход к строке чужого скрипта из ошибки. */
  onSelectObject?: (id: string) => void;
  calibrate: CalibrationApi["calibrate"];
  cancelCalibration: CalibrationApi["cancelCalibration"];
  /** Состояние внешних источников: видно в карточке модуля. */
  externalStatuses?: Record<string, ExternalStatus>;
  /** Вход в Twitch из карточки внешнего источника. */
  onAuthorizeSource?: (name: string) => void;
  onSignOutSource?: (name: string) => void;
  /** Журнал источников и проверка соединения. */
  externalLogs?: Record<string, ExternalLogEntry[]>;
  onProbeSource?: (name: string) => Promise<string>;
  /** Последние тексты источников (чат): видны во «Входах». */
  externalTexts?: Record<string, ExternalTextLine[]>;
}

type Tab = "behaviour" | "object" | "globals" | "inputs" | "modules";

export function RightPanel(props: RightPanelProps) {
  const [tab, setTab] = useState<Tab>("object");
  // Смена выделения не выбивает из «Входов», «Модулей» и «Поведения»:
  // там как раз удобно переключать объекты подряд.
  useEffect(() => {
    setTab((current) => (current === "behaviour" || current === "inputs" || current === "modules" ? current : "object"));
  }, [props.selected?.id]);
  // Значения кадра — свёрнутая секция: скрипт забирает всю высоту колонки,
  // а кадр открывается по клику и не висит пустой третью экрана.
  const [valuesOpen, setValuesOpen] = useState(false);
  /**
   * Переход «из входов в настройки модуля»: вкладка переключается, а карточка
   * раскрывается и подсвечивается. Номер перехода нужен, чтобы повторный клик
   * по тому же модулю тоже срабатывал.
   */
  const [focusModule, setFocusModule] = useState<{ name: string; nonce: number } | null>(null);
  const openModule = (name: string) => {
    setTab("modules");
    setFocusModule({ name, nonce: Date.now() });
  };
  // Переход одноразовый: подсветка отработала — заявку снимаем, иначе возврат
  // на вкладку «Модули» снова мигал бы той же карточкой.
  useEffect(() => {
    if (!focusModule) return;
    const timer = window.setTimeout(() => setFocusModule(null), 2600);
    return () => window.clearTimeout(timer);
  }, [focusModule]);
  const editorValue = tab === "globals" ? props.globalScript : props.selected?.script || "";
  // Области, о которых может говорить диагностика: `глобальные` и объекты.
  // Список сверяется с сообщением, поэтому «вызов 'clap'» за объект не сойдёт.
  const scopes = ["globals", ...props.objects.map((object) => object.id)];
  // Подписи входов — для подсказки события: `on twitch.chat.change` показывает,
  // что это «Сообщений». Считаются один раз на рендер панели.
  const inputLabels = Object.fromEntries(
    props.modules.flatMap((module) => moduleInputKeys(module).map((item) => [item.key, item.spec.label])),
  );
  const editorKey = tab === "globals" ? "globals" : props.selected?.id || "empty";
  // Куда перейти по клику на ошибку: область и строку. `nonce` нужен, чтобы
  // повторный клик по той же строке снова подсветил её, а не промолчал.
  const [reveal, setReveal] = useState<{
    scope: string; line: number; nonce: number; name?: string;
  } | null>(null);
  // Переход — событие, а не состояние: после показа строку снимаем, чтобы
  // возвращение на эту вкладку через минуту не подсвечивало её снова.
  useEffect(() => {
    if (!reveal) return;
    const timer = window.setTimeout(() => setReveal(null), 2000);
    return () => window.clearTimeout(timer);
  }, [reveal]);
  // Имя едет вместе с переходом: в чужом скрипте подсвечиваются все его
  // вхождения — от объявления до вызовов.
  const openIssue = (scope: string, line: number, name?: string) => {
    // `globals` — глобальный скрипт, остальное — id объекта. Сначала переключаем
    // область, потом просим редактор прокрутиться: он уже будет с нужным текстом.
    if (scope === "globals") {
      setTab("globals");
    } else if (props.objects.some((object) => object.id === scope)) {
      props.onSelectObject?.(scope);
      setTab("object");
    }
    // Без номера строки переходим только в область: подсвечивать нечего.
    if (line > 0) setReveal({ scope, line, nonce: Date.now(), name });
  };
  // Проверка видит соседние области: конфликт имён — это всегда две строки,
  // своя и чужая. `scope` пустой у глобального скрипта: тогда ядро смотрит,
  // не заняли ли глобальное имя в скриптах объектов.
  const checkScope: ScriptScope = {
    ...(tab === "globals" || !props.selected ? {} : { scope: props.selected.id }),
    globals: props.globalScript,
    objects: props.objects.map((object) => ({ id: object.id, script: object.script })),
  };
  const dynamic = props.selected ? props.frame?.objects[props.selected.id] : null;

  return (
    <aside className="right-panel panel-surface">
      <div className="right-tabs">
        <button className={tab === "behaviour" ? "active" : ""} onClick={() => setTab("behaviour")}><Spline size={14} /> Поведение</button>
        <button className={tab === "object" ? "active" : ""} onClick={() => setTab("object")}><Braces size={14} /> Объект</button>
        <button className={tab === "globals" ? "active" : ""} onClick={() => setTab("globals")}><Globe2 size={14} /> Глобальные</button>
        <button className={tab === "inputs" ? "active" : ""} onClick={() => setTab("inputs")}><SlidersHorizontal size={14} /> Входы</button>
        <button className={tab === "modules" ? "active" : ""} onClick={() => setTab("modules")}><Blocks size={14} /> Модули</button>
      </div>

      {tab === "behaviour" ? (
        <BehaviourPanel
          object={props.selected}
          selection={props.selectedObjects}
          onChange={props.onBehaviour}
          onText={props.onText}
        />
      ) : tab === "modules" ? (
        <ModulesPanel
          modules={props.modules}
          devices={props.devices}
          error={props.audioError}
          onChange={props.onModules}
          focus={focusModule}
          externalStatuses={props.externalStatuses}
          onAuthorizeSource={props.onAuthorizeSource}
          onSignOutSource={props.onSignOutSource}
          externalLogs={props.externalLogs}
          onProbeSource={props.onProbeSource}
          calibrate={props.calibrate}
          cancelCalibration={props.cancelCalibration}
        />
      ) : tab === "inputs" ? (
        <InputsPanel
          modules={props.modules}
          inputs={props.inputs}
          audio={props.audio}
          manual={props.manual}
          auto={props.auto}
          error={props.audioError}
          frame={props.frame}
          onManual={props.onManual}
          onModules={props.onModules}
          onInsertSnippet={props.onInsertSnippet}
          onOpenModule={openModule}
          texts={props.externalTexts}
          calibrate={props.calibrate}
          cancelCalibration={props.cancelCalibration}
        />
      ) : <>
        <div className="script-workspace">
          <div className="script-caption">
            <span>
              {tab === "globals" ? "globals.rig" : `${props.selected?.id || "object"}.rig`}
              {tab === "object" && props.selectedCount > 1 && <b className="script-multi"> +{props.selectedCount - 1}</b>}
            </span>
            <span className="autosave-note">авто · 420 мс</span>
          </div>
          {(tab === "globals" || props.selected) ? <ScriptEditor
            key={editorKey}
            value={editorValue}
            objectIds={props.objects.map((object) => object.id)}
            globals={props.globals}
            moduleInputs={props.modules.flatMap((module) => moduleInputKeys(module).map((item) => item.key))}
            moduleInputLabels={inputLabels}
            events={[...new Set([
              ...eventNames(props.globalScript),
              ...eventNames(editorValue),
            ])]}
            constants={Object.keys(enumConstants(props.modules))}
            checkScope={checkScope}
            onCheck={props.checkScript}
            reveal={reveal?.scope === editorKey ? reveal : undefined}
            onOpenIssue={openIssue}
            onApply={tab === "globals" ? props.onGlobalScript : props.onObjectScript}
          /> : <div className="empty-state"><Braces size={24} /><p>Выберите объект для редактирования скрипта</p></div>}
        </div>
        <div className={`runtime-panel ${valuesOpen ? "open" : ""}`}>
          <button
            className="runtime-heading"
            onClick={() => setValuesOpen(!valuesOpen)}
            aria-expanded={valuesOpen}
            title={valuesOpen ? "Свернуть значения кадра" : "Показать значения кадра"}
          >
            <ChevronRight className="runtime-chevron" size={13} />
            <Gauge size={13} /><span>Значения кадра</span>
            {props.frame && <small>#{props.frame.seq}</small>}
          </button>
          {(props.engineError || props.frame?.diagnostics.length) ? (
            <div className="runtime-diagnostics">
              {props.engineError && <div className="diagnostic error"><CircleAlert size={14} /><span>{props.engineError}</span></div>}
              {props.frame?.diagnostics.map((message, index) => {
                // Диагностика кадра — тоже ошибка в конкретной строке: переход
                // к ней экономит поиск объекта руками.
                const place = diagnosticPlace(message, scopes);
                const name = diagnosticName(message);
                return (
                  <div className="diagnostic" key={`${index}-${message}`}>
                    <CircleAlert size={13} />
                    <span>{message}</span>
                    {place && (
                      <button
                        type="button"
                        className="diagnostic-jump"
                        title={place.line
                          ? `Показать ${scopeTitle(place.scope)}, строка ${place.line}`
                          : `Открыть ${scopeTitle(place.scope)}`}
                        onClick={() => openIssue(place.scope, place.line ?? 0, name ?? undefined)}
                      >
                        <ChevronRight size={11} />
                        {scopeTitle(place.scope)}{place.line ? `:${place.line}` : ""}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          {valuesOpen && (
            <div className="runtime-values">
              {dynamic ? Object.entries(dynamic).map(([name, value]) => (
                <div className="runtime-value" key={name}><span>{name}</span><b>{formatValue(value)}</b></div>
              )) : tab === "globals" ? Object.entries(props.frame?.globals || {}).map(([name, value]) => (
                <div className="runtime-value" key={name}><span>{name}</span><b>{formatValue(value)}</b></div>
              )) : <span className="muted">Нет данных кадра</span>}
            </div>
          )}
        </div>
      </>}
    </aside>
  );
}

function formatValue(value: number) {
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
}
