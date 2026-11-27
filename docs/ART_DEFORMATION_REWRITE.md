# Единый артмеш: согласованное устройство и ход замены

## Текущий статус (этап 24)

Старые NxN/cage UI, runtime, recording, clipboard и типы удалены. Ниже сохранён
пошаговый исторический журнал: пометки «пока не подключено/осталось удалить»
относятся к соответствующему этапу, а не к текущему дереву. Format 8/core 28.
Активный старый cage без artMesh отклоняется при чтении, не мигрируется.

Основной оставшийся внешний gate: компиляция Rust/WASM и Windows/OBS smoke.
Браузерная проверка редактора не доказывает работу нового binary playback.

## Решения

Один меш: stable vertex IDs, локальные rest-позиции, UV и треугольники по ID.
Поза — смещения тех же вершин. Нет отдельной NxN управляющей поверхности.
Два режима: правка базы/топологии и деформация существующих вершин.
NxM — генератор артмеша, не отдельный деформер.

Родительская деформация — barycentric binding в rest-треугольниках родителя.
Вне треугольников/в отверстиях точка остаётся на месте. Выключенное наследование
сохраняет существующее поведение; скрытая геометрия детям не добавляется.
Группа-деформер владеет нетекстурированным мешем; группу нельзя исключать из
редактора геометрии, как это делает старый Scene.

Кнопка генерации вместо manual/grid. Диалог для объекта и подготовки потомков:
regular NxM или по alpha-контуру; threshold, contour inset, boundary spacing,
interior spacing, simplification; preview и числа вершин/треугольников.
Применение атомарное, один undo. Замена меша очищает только vertex poses данного
объекта с предупреждением; прочие параметры состояний остаются. Отмена не меняет
проект. Вершины вставляются с интерполяцией UV/pose; удаление не перенумеровывает ID.
Правка rest сохраняет относительные offsets, UV остаётся фиксированным.

Проект — демо: не поддерживать вечный legacy runtime и не делать молчаливую
приблизительную миграцию. Старые данные при переходе должны либо явно сбрасываться
с предупреждением, либо отвергаться как старый формат. Обновление формата/needs
выполнять при подключении нового формата, а не до этого.

## Реализовано: математическая основа (пока не подключена)

`src/engine/artDeformation.ts`:
- единая топология и offsets по стабильным ID;
- regular генератор с продолжением nextId при замене;
- binding/evaluation по rest-треугольникам, границы и отверстия;
- правка rest без изменения UV;
- вставка внутри треугольника с интерполяцией состояний;
- удаление вершины/прилегающих треугольников/её pose entries.

Проверено четырьмя unit tests и TypeScript. Нынешний renderer/Scene/StatesPanel
не переключены, format сохранения прежний. Новый модуль — подготовка замены,
не второй пользовательский режим совместимости. Edge split пока отдельно не
реализован: вставка на ребре явно отклоняется, чтобы не создать T-junction.

## Обязательно дальше

1. Валидатор сериализации нового формата, сборка renderer geometry из rest+pose.
2. Перевести parent binding и state interpolation на stable IDs, исключить
   регулярные grid sampling и implicit child tessellation.
3. Перевести Scene handles, кисть, симметрию, рамки и StatesPanel на вершины;
   удалить cols/rows из деформационных операций. Разрешить меш группам.
4. Единый generator dialog, alpha outline/holes triangulation и preview;
   пакетная подготовка потомков, чистка только vertex poses, атомарный undo.
5. Пресет/копирование/импорт/экспорт, version/format/needs; удалить старые warp,
   grid deformation и remapping после замены всех вызовов, обновить документацию.
6. Проверить сохранение, undo/redo, состояния, вложенных родителей и OBS (атомарная
   передача frame+geometry). Пиксельная проверка границ/дырок и UV.

Не просить пользователя пересобирать промежуточную математическую основу:
пользовательского изменения интерфейса пока нет.

## Этап 2: формат, геометрия и API рендера

Добавлен artMeshRuntime: строгий readArtMesh/readArtOffsets (без угадывания старого
формата), compileArtMesh и evaluateArtMesh. Компиляция переводит stable IDs в
индексы один раз; покадрово строятся только targets, UV/triangles переиспользуются.
readArtMesh копирует входные данные, отвергает дубли ID/граней, отсутствующие ссылки,
нечисловые координаты, некорректный nextId и чрезмерные массивы. Пока это валидатор
нового mesh payload, не подключённый валидатор всего RigPreset.

bindArtVertices/applyArtBindings разделяют поиск rest-треугольников и покадровую
подстановку позиций. Координаты binding и targets должны быть локальными родителю;
преобразование между пространствами объектов ещё предстоит подключить в bend.
Привязки пересоздаются после изменения rest/topology; владелец lifecycle — будущий
интеграционный слой. Глобальные сильные кеши не добавлены.

В renderer добавлен drawArtMesh: принимает compiled unified mesh + offsets,
не вызывает GridSpec/sampleGrid и не создаёт геометрию по умолчанию. Использует
существующий WebGL/Canvas backend. Пустая топология не рисует исходную картинку.
Тестируется прямой API, Canvas fallback и индексные данные; Scene/drawRig пока
используют старый путь. Это не завершённая пользовательская миграция.

Восемь тестов нового ядра/runtime проходят. Реальный WebGL нового API, UI,
сохранение всего пресета и OBS ещё не проверены. Следующий этап — определить
единственное новое поле меша в RigObject и переключить его владельцев (preset,
states, Scene, Inspector, parent transforms, render, clipboard). Не называть
готовым переходом простое добавление optional unified рядом со старым MeshSpec.

## Этап 3: vertex poses в состояниях

Существующий readStates теперь сохраняет ключи v0/v1/... при чтении JSON-блока:
до этого любой stable ID молча отбрасывался, поскольку принимались только цифры.
writeStates и posePoints проверены roundtrip/интерполяцией со stable IDs.
Цифровые ключи пока читаются лишь до удаления старых владельцев grid; новые
операции не конвертируют индексы в ID и не пытаются угадывать соответствие.

artMeshStates возвращает одну пару mesh+states для атомарного commit:
insertArtStateVertex интерполирует каждый ключ всех слоёв; removeArtStateVertex
удаляет только записи вершины; replaceArtStateMesh очищает только pose.points,
сохраняя at/weight/pose и настройки слоёв. Входные структуры не мутируются.
artRecordDelta принимает явные offsets по ID, не использует rest как временную
позу: правка базы не должна нечаянно записываться в анимационный ключ. Null previous
и отсутствие изменения не создают запись; возврат в нейтраль возвращает пустую
карту, а не null. Это позволяет удалить старые offsets из выбранного ключа.

Проверены 11 новых тестов и 62 существующих states tests, TypeScript.
Scene/StatesPanel ещё не вызывают новые транзакции, RigPreset пока старый.
Не считать эту стадию завершённым пользовательским переключением. Потребитель
должен применять обе части результата одной исторической операцией; сам модуль
не создаёт undo и не переписывает скрипт. Сериализацию скрипта выполняет writeStates.
Старая mirrorLayer отражает нормализованные векторы grid, и её нельзя применять
к новым local-unit offsets с width/height масштабированием без изменения:
нужно отдельное отражение локального вектора в новом редакторе/перевод API.

## Этап 4: подключённый путь объектов и общего renderer

RigObject получил artMesh/artPose (локальные единицы). normalizePreset валидирует
новые данные, сохраняет их в объектах sprite/media/shape/group и исключает старые
mesh/warp при наличии artMesh. Некорректные ссылки pose отвергают preset (null),
а не включают старый grid fallback. meshOf не возвращает старый mesh у такого
объекта, meshEnabled включает новый путь. Legacy поля пока существуют только для
ещё не переписанного интерфейса; это временная стадия замены, не обещание поддержки.

meshGeometry/meshSurfaceGeometry для artMesh используют compiled vertices +
artPose + переданные offsets по ID, без zone/sampleGrid/subdivision и без
неявной геометрии. Вызовы prepareRigMeshes/drawRig теперь могут обслуживать новый
payload, не только отдельный drawArtMesh API. Структурная подпись OBS учитывает
новую геометрию и базовые offsets; сцена/атомарные prepared meshes передаются тем
же транспортом. Тест сравнивает подготовленные геометрии редактора/receiver,
а не реальный Windows/OBS. Скриптовая анимация новых offsets в обычном playback
ещё требует перевода StatesPanel и автора frame-side state channels.

Parent sampler поддерживает artMesh групп с переводом local↔world и обратно.
Новый родитель действует только на детей со своим artMesh и deformParent===true:
нет скрытого tessellation и нет opt-in по умолчанию. Отверстия/внешняя область не
смещаются. Пока bindArtVertices вызывается из sampler для каждой точки: правильный
путь подключён, но persistent binding lifecycle для стабильных rest-топологий ещё
не подключён. Нельзя заявлять отсутствие поиска треугольников каждый кадр в этом
интеграционном пути.

43 теста и production build проходят. UI всё ещё нельзя использовать для авторинга
artMesh: старые инструменты правят GridSpec, новые данные не создают. До публичного
переключения необходимо заменить инструменты/инспектор/StatesPanel/clipboard,
поднять format/needs, проверить явный отказ старых файлов и удалить старые пути.
Нынешние сохранения с artMesh нельзя считать совместимыми со старыми сборками,
которые не знают нового поля. Пока не предлагать пользовательский тест/сохранение
новых моделей на промежуточной сборке.

## Этап 5: первый UI для нового меша (не завершённый переход)

Scene: кнопка «Сгенерировать артмеш» в инструментах T/R, диалог regular NxM с
отступом, SVG draft-preview/числами и явным «Заменить сетку». Отмена не мутирует
проект. Применение — commit mesh+очистка vertex poses в скрипте одним шагом undo.
Старые mesh/warp убираются у изменённого объекта. После генерации доступны
«Правка сетки»/«Деформация»: прямое перетаскивание вершин меняет rest или artPose,
UV остаётся прежним. Drag пишет исходное состояние в историю один раз, закрывается
по pointerup/cancel/blur. Панорама и зум остаются прежними. Новый overlay рисует
те же вершины/грани, а старые NxM панели для нового объекта скрыты. Inspector
нового меша показывает количество, сброс pose и явное наследование от родителя.

Это первый работоспособный базовый authoring flow, но НЕ готовая замена:
- пока только регулярная генерация, без alpha-contour и пакетной команды;
- нет переноса кисти/симметрии/топологических действий в новый UI;
- state recording/preview всё ещё нужно переключить на artPose и локальные units;
- ручки пока в собственной позе объекта, без визуальной компенсации родительского
  деформера; не обещать корректный drag внутри уже деформированной группы;
- формат файла/старые пути всё ещё ожидают финального переключения. Не использовать
  промежуточную сборку для ценных новых моделей или обмена со старыми сборками.

10 целевых тестов, TypeScript и production build проверены. Тест UI диалога
статический, drag math — unit; браузерный/Windows ручной тест не выполнен.
Не объявлять кисть/симметрию/генерацию по форме реализованными на этой стадии.

## Этап 6: запись artPose в панели состояний

Подключён onArtPose через App/RightPanel/StatesPanel. Панель снимает авторские
смещения, ждёт завершения жеста, переносит разницу в выбранный/созданный ключ
и возвращает авторские смещения без отдельного шага истории. Новая rest-геометрия
не является источником смещений; замена набора stable IDs переснимает baseline.
Отражение нового pose работает в локальных единицах (без прежнего масштабирования
по ширине/высоте). 70 целевых тестов и production build проходят.

Воспроизведение пока НЕ перенесено: Rust runtime выдаёт watch только из уже
вычисленного cache, не вычисляет произвольные watched locals. Поэтому нельзя
просто запросить веса в watch и считать это корректным playback, особенно для
свободных слоёв с выражениями. Следующий этап должен явно провести vertex channels
из состояний через runtime/frame к подготовке геометрии, включая замену только
выбранного слоя в preview и те же значения для overlay. Cargo в окружении нет;
нативные проверки сейчас недоступны. Текущая запись проверена математическими
тестами; React lifecycle/undo end-to-end и Windows всё ещё требуют проверки.

## Этап 7: исходники frame-based playback

statesBlock объявляет отдельные states_art_wL_P для слоёв с stable-ID points,
watchNames запрашивает их. Rust runtime теперь вычисляет объявленные watched
locals до сборки кадра, даже если transform-channel их не читает; отсутствующие
имена не превращаются в нули. Добавлен Rust regression test vertex-only weights.
artMeshPlayback читает только веса из frame.vars, суммирует локальные offsets,
фильтрует ID по текущей топологии, поддерживает sum/average. prepareRigMeshes,
прямой drawRig и parent-deformer путь получают эти данные. Авторский artPose
прибавляется отдельно и один раз. Overlay по-прежнему получает готовые поверхности
от host атомарно вместе с кадром, не исполняет скрипты самостоятельно.
Preview несёт индекс непустого слоя и заменяет только его vertex-вклад; пустой
preview корректно убирает вклад выбранного слоя, не остальных. Ручки собственной
позы теперь учитывают состояние (но компенсация parent-deformer всё ещё нужна).

Проверено: 81 TS/protocol/math test, tsc, diff-check. Rust test НЕ запущен:
Cargo отсутствует. public/rig_core.wasm и dist намеренно НЕ обновлены — обычная
сборка без Cargo молча подхватила бы старое ядро и не включила эту функциональность.
Нужны cargo test -p rig-core и полная npm run build с Rust wasm32 target прежде,
чем утверждать, что playback работает в собранном приложении. В этом этапе нет
нативного/браузерного подтверждения исполнения выражений весов.

Ограничения следующего шага: актуализировать ранее записанные промежуточные
блоки состояний, не содержащие states_art_w; согласовать preview/recording для
average с vertex runtime; закончить parent-aware handles, инструменты,
alpha/batch generation, формат/needs и удаление старых путей. Не публиковать
эту промежуточную ветку как завершённую миграцию.

## Этап 8: единая vertex-смесь и актуализация state blocks

blendArtLayer / artPosePoints — общий расчёт для runtime offsets и preview
нового меша. Для average нормируется вся поза по сумме весов слоя, а не отдельно
по ненулевым X/Y. Отсутствующая вершина/нулевая координата нейтральны, но вес
позы остаётся в знаменателе: переход от нулевого ключа не скачет сразу к полной
деформации. При нулевой сумме весов результат нейтральный; нечисловые веса
игнорируются. Старый numeric-grid preview не меняется.

Запись между ключами нового меша берёт ту же показанную смесь перед добавлением
смещения и созданием нового ключа. При normalizePreset блоки состояний объектов
с artMesh канонически пересобираются из metadata через writeStates: добавляются
актуальные states_art_w, сохраняются ключи и авторский код вне блока; операция
идемпотентна. Это не второй legacy runtime.

78 tests + tsc + diff-check прошли. Включены regression cases neutral/sparse
average, runtime/preview equality, запись между ключами и повторная нормализация.
Cargo по-прежнему отсутствует; WASM/dist не обновлялись. Исходники runtime из
этапа 7 всё ещё требуют компиляции и проверки Rust/реального приложения.

## Этап 9: parent-aware ручки и локальное обратное преобразование

Отрисовка и hit-test новых вершин используют createParentMeshTransforms — тот
же sampler, что подготовка поверхности. State/preview offsets считаются один раз
при pointerdown, а не для каждой вершины. Rest mode показывает rest-поверхность
с воздействием родителей; pose mode — собственную текущую позу с родителями.
Drag сохраняет исходную точку, смещение хвата относительно неё и sampler начала
жеста. inverseArtEditorPoint локально обращает sampler методом Newton с поиском
убывающего шага; следующая точка ищется от последней успешной, чтобы сохранять
локальную ветвь. Запись остаётся в собственных локальных units объекта, не в
координатах уже деформированного родителя. Исходные UV/IDs не меняются.

На схлопнутых/необратимых участках, при нечисловых координатах или отсутствии
сходимости движение пропускается, последняя корректная поза сохраняется.
Глобальный уникальный inverse для складок и разрывов на краю деформера не
обещается; прыжок через край/отверстие может быть отклонён. Sampler заморожен на
жест; движение самого родителя во время жеста не компенсируется в реальном времени.

17 targeted tests passed: обратный drag affine/skew, реальный вложенный group
sampler, совпадение ручек с prepared child vertices, отключённое наследование,
необратимые/NaN поверхности; tsc и diff-check пройдены. Это математические тесты,
не браузерная проверка pointer gestures. Cargo/WASM/dist — прежнее ограничение.
Далее: multi-selection/brush/symmetry и topology UI, alpha/batch generation,
окончательный format/needs, удаление legacy и полная Rust/Windows проверка.

## Этап 10: multi-selection и move-brush нового меша

Shift+клик добавляет/убирает stable ID в выделении, обычный drag выбранной
вершины двигает всю выборку. Есть «Все вершины»/«Снять», выбранные ручки белые.
Клик по пустому месту снимает выборку; Shift-клик не начинает undo-жест.
Кнопка кисти включает soft move: радиус 1–1000 scene units, круг предпросмотра,
влияние smoothstep от центра до нуля на краю. Область/веса фиксируются на начале
жеста — это move-brush, не накопительный paint/smear stroke. Кисть работает со
всеми вершинами в радиусе независимо от выборки. В rest и pose режимах используется
одна атомарная immutable операция editArtVertices без накопления delta между
pointermove. Для каждой вершины отдельно обращается parent sampler; при отказе
inverse сохраняется последняя успешная позиция этой вершины. История по-прежнему
открывается один раз на весь жест.

20 targeted tests + tsc + diff-check прошли. Math tests покрывают multi-update,
сохранение rest/UV/pose/topology, отсутствие накопления и soft-falloff; реальный
браузерный pointer workflow ещё не подтверждён. Симметрия, рамка/лассо и topology
UI пока НЕ перенесены; существующие старые инструменты скрыты для artMesh.
WASM/dist не обновлены: Rust toolchain по-прежнему отсутствует.

## Этап 11: симметрия вершин нового меша

В панели артмеша добавлено off / лево↔право / верх↔низ. Оси проходят через
центр локальных размеров объекта; отображаются пунктиром с учётом родителей.
На pointerdown строятся пары stable IDs по rest (допуск 0.5 local units,
spatial buckets, только взаимно ближайшие кандидаты). Отсутствующая пара не
создаёт вершину или скрытый меш. Пары фиксируются на жест, не дрожат от правок.
Отражаются локальные delta после обращения parent sampler, в обоих режимах и
с soft move кистью. Осевые вершины ограничены движением вдоль оси. При влиянии
на обе стороны больший local delta определяет пару; равные — приоритет stable ID,
без двойного суммирования. Это не исправление уже асимметричного rest/pose и не
гарантия экранной симметрии под асимметричным родителем.

19 targeted math/integration tests + tsc + diff-check прошли. Тесты: пары,
осевые вершины, оба направления, missing counterpart, детерминированный brush
conflict, UV/topology invariants. Браузерные жесты не проверены. Произвольная ось,
рамка/лассо, topology UI, alpha/batch generation и окончательное удаление старых
путей ещё впереди; Cargo/WASM/dist ограничения остаются.

## Этап 12: рамка и лассо для stable-ID вершин

В инструментах нового артмеша добавлены «Перемещение / Рамка / Лассо».
Выделение строится по snapshot видимых scene-space координат с state/preview
и parent deformation, в rest и pose режимах. Shift — добавить, Alt — вычесть,
иначе заменить; границы региона включаются. Выделение применяется на pointerup,
не вызывает onDragStart, не меняет проект и не создаёт undo. Escape, blur,
pointercancel, смена объекта/инструмента отменяют draft. Лассо ограничено 4096
точками с минимальным шагом 2 screen px; перед polygon-test отсекается bbox.
После региона для drag нужно вернуться в «Перемещение» (или включить кисть).

16 targeted tests + tsc + diff-check прошли: reverse rectangle, edge inclusion,
lasso vs bbox, add/subtract, неизменность входных данных и regression checks
editing/symmetry. Реальные DOM pointer/keyboard cancellation ещё не проверены.
Далее topology UI/edge split, alpha/batch generation, формат/needs и удаление
legacy; Rust toolchain/WASM/dist всё ещё ожидают полноценной сборки.

## Этап 13: первая topology UI и безопасный shared-edge split

insertArtVertex теперь вставляет вершину внутри грани либо разделяет все грани,
смежные с ребром, сохраняя winding. UV, artPose и vertex points всех state keys
интерполируются по одной rest-space binding; совпадение с существующей вершиной,
внешняя/нечисловая точка и превышение лимитов отвергаются. nextId монотонен.

editArtTopology — полная immutable object transaction. App делает один commit
на вставку/удаление выбранной пачки: mesh+artPose+script со всеми ключами вместе.
В rest mode есть «Вставить вершину» (клик, snap 6 screen px к видимым рёбрам) и
«Удалить вершины». Удаление убирает прилегающие грани и создаёт отверстие, без
автозаливки/перенумерации; это указано в tooltip кнопки. Ошибки вставки видны в
status панели, не только в console. До вызова updater вставка валидируется.
Топология не зеркалится автоматически, симметрия пока действует на перемещение.
После удаления всех граней восстанавливать поверхность нужно генерацией: пока
нет UI ручного соединения/создания граней. Snap под сильной нелинейной родительской
деформацией приближён хордой между концами ребра; это не точный inverse curve hit.

11 targeted core/states/topology tests + tsc + diff-check проходят. Тестируются
shared/boundary split, winding, authored/state interpolation и сохранение прочих
полей, атомарный результат, удаление stable IDs. DOM undo/pointer и Rust/Windows
по-прежнему требуют проверки. WASM/dist не обновлены (нет Cargo).

## Этап 14: ручное создание/удаление граней

В rest toolbar есть «Создать грань» и «Удалить грань» по ровно трём выбранным
stable IDs. Создание нормализует winding, отклоняет дубликаты, вырожденные грани,
пересечения/перекрытия, прохождение через другие вершины (T-junction) и третью
грань на уже занятом двумя гранями ребре. Удаление грани не удаляет её вершины.
Face-only editArtTopology возвращает новый объект/mesh с теми же artPose, vertices,
UV и script: состояния не переписываются и не очищаются. App использует один
commit с отдельной подписью истории. Ошибки видны в status toolbar.

Это ручное заполнение по одному треугольнику, не автоматическая заливка
произвольного контура. Пока нет создания изолированных вершин вне поверхности,
реберного flip, автозаливки и пакетной генерации по alpha. 11 targeted tests,
tsc и diff-check прошли: восстановление грани, winding, overlap/duplicates,
collinear/T-junction rejection и byte-for-byte сохранность state script.
Браузерные gestures/undo, Rust compile и WASM/dist остаются непроверенными.

## Этап 15: пакетная подготовка потомков (regular)

Кнопка «Подготовить потомков…» открывает тот же ArtMeshGenerator с пакетной
областью: прямые/все вложенные потомки, только без нового артмеша (по умолчанию),
отдельная выключенная галочка включения наследования. Предупреждение показывает
число целей и заменяемых существующих сеток. Есть выбор объекта предпросмотра,
общие counts; регулярные cols/rows/inset применяются ко всем целям. Некорректный
отступ хотя бы у одной цели блокирует Apply всего draft. Неподдерживаемые типы
и нулевые размеры пропускаются с явным счётчиком. Корневой объект не меняется.

artDescendants ограничивает циклы. replaceArtMeshes валидирует всю пачку до
построения результата, не допускает повторные цели/старые IDs, сбрасывает только
artPose и vertex state channels. Прочие параметры/состояния сохранены, наследование
без галочки не меняется. App выполняет один commit на всю пачку. Cancel не
вызывает изменения проекта.

16 targeted tests, tsc и diff-check прошли (scope/cycle, batch invariants,
inheritance opt-in, ошибочная последняя цель без partial result). UI preview и
undo в браузере не проверены. Alpha-contour generation ещё НЕ реализован; диалог
пока только regular. Группы с размерами 0 требуют отдельного решения явных
bounds, не получают скрытую геометрию. Полная Rust сборка/WASM/dist всё ещё
ожидается; формат/needs и удаление legacy не завершены.

## Этап 16: чистое ядро alpha generation (без UI подключения)

artMeshAlpha принимает bounded alpha raster и local object dimensions. Реализованы
threshold (прозрачные пиксели не считаются даже при threshold=0), внешний padding,
cell-edge tracing отдельных островов/отверстий, closed RDP simplification,
contour spacing, earcut triangulation с holes и проверкой deviation, interior
spacing через insertion. UV вычисляются из local rest/object dimensions; nextId
начинается с переданного монотонного счётчика. Коллинеарные contour samples,
пропущенные earcut, восстанавливаются edge split, без orphan vertices.

Ограничения намеренно явные: вход до 512×512, padded raster до 1024×1024,
trace budget 65536 edges, mesh budget 8192 vertices и bounded interior sampling.
Padding — anisotropic octile distance approximation, а не точный евклидов offset.
Слишком сложный/пустой контур и выявленные пересечения после simplification
отвергаются, а не заменяются регулярной сеткой. Геометрическая устойчивость на
реальных сложных масках ещё требует проверки. Это не качественный remesher:
внутренние точки делят существующие треугольники, без Delaunay optimization.

Добавлена зависимость earcut (+ dev types); npm audit сообщает 0 vulnerabilities.
10 targeted tests + tsc + diff-check прошли: threshold/UV/IDs, ring hole, separate
islands/diagonal touch, padding, budgets, used contour/interior vertices, insertion
regression. Подключение alpha source (sprite/shape/media), preview controls и batch
в ArtMeshGenerator ещё НЕ сделано; пользователь пока видит только regular mode.
Cargo/WASM/dist — прежнее ограничение. Не объявлять alpha UI готовым по core tests.

## Этап 17: alpha mode в общем диалоге (исходники)

ArtMeshGenerator получил regular/alpha mode и threshold/padding/contour spacing/
interior spacing/simplification. Scene передаёт captureArtAlpha: sprite — уже
загруженная картинка, shape — тот же drawShapeObject, media — текущий готовый
video/image element. Новых скрытых media players/геометрии нет. Источник —
авторское содержимое без masks, runtime opacity и deformation, это подписано.
Группы без alpha-source явно отклоняются; для них пока regular. Снимок ограничен
256×256, фиксируется при входе в alpha mode/смене источника, обновляется отдельной
кнопкой. Refresh сразу инвалидирует прошлый результат до повторного чтения.

Тот же режим работает в batch: отдельный raster/nextId каждой цели, preview
выбранного объекта и totals. Пустой/недоступный/CORS source или ошибка геометрии
одной цели блокирует всю пачку с её именем; regular fallback отсутствует. Временный
canvas сбрасывается после чтения, snapshot не попадает в проект. До Apply проект
не меняется. SVG viewBox учитывает внешний padding. Capture budget пачки 2M pixels.
Генерация пока синхронная/ограниченная, без worker: latency больших пачек ещё
требует профилирования и дальнейшей работы.

17 targeted tests + tsc + diff-check + Vite bundling в .cache/alpha-ui-build
прошли. Новый настоящий Playwright UI test добавлен, но запуск НЕ состоялся:
Chromium executable отсутствует (browserType.launch), до assertions не дошло.
Не считать DOM/Canvas/source/Apply flow подтверждённым браузером. Два source tests
используют canvas mock, остальные — core/batch math. WASM/dist не обновлены, Cargo
по-прежнему нет. Следом: полноценная проверка UI/undo, group bounds/alpha policy,
clipboard/format/needs, удаление старой системы, Rust+Windows build.

## Этап 18: clipboard нового артмеша

В Scene добавлены «Копировать артмеш»/«Вставить артмеш…», включая вставку в
поддерживаемый объект без artMesh. Буфер in-memory хранит owned strict copies
mesh/UV/artPose/размеров, не состояния источника; чтение тоже возвращает копию.
Отдельный ArtMeshPasteDialog требует подтверждение замены, предлагает fit/local
и выключенный по умолчанию перенос авторской деформации. Fit масштабирует rest
и выбранные pose offsets, UV остаются нормированными исходными. Local сохраняет
единицы источника. Новые IDs выдаются от target.nextId, старые не переиспользуются.

pasteArtMesh — полная object transaction; App делает один commit. Смещения
вершин всех target keys очищаются, остальные state properties/слои сохраняются,
inheritance и размеры объекта не меняются. Битый payload/нечисловое масштабирование
отвергаются. Cancel не меняет проект, смена объекта закрывает draft. Старый
numeric grid clipboard ещё существует только для не переведённых объектов/UI;
это не преобразователь между форматами и он должен уйти при удалении legacy.

12 targeted tests + tsc + Vite bundling (.cache/clipboard-build) + diff-check
прошли: owned copies, fit/local/pose, stable IDs, state preservation, failures.
DOM dialog/undo не проверены — Chromium по-прежнему отсутствует. Rust toolchain
и согласованные WASM/dist всё ещё не собраны. Осталось решить group bounds,
format/needs, завершить удаление старой системы и полноценную UI/native проверку.

## Этап 19: явные размеры group surface

При генерации сетки самой группы диалог теперь показывает editable ширину/высоту
поверхности. Для новой zero-size группы draft начинается с 400×400; это только
видимое предложение в диалоге, не скрытая геометрия проекта. Apply сохраняет
размеры+artMesh+очистку vertex poses одной immutable transaction/одним commit.
Cancel ничего не сохраняет. Существующие base/pivot, параметры потомков и
наследование не меняются, автоматической подгонки под bounds потомков нет.
Alpha mode для собственной нетекстурированной группы отключён; подготовка
потомков по alpha по-прежнему работает для объектов с источником. Batch пропускает
zero-size группы с явным счётчиком, не назначает им случайные размеры.

replaceArtObjectMesh строго проверяет размеры/mesh/монотонные IDs; явные размеры
через этот путь разрешены только группе. App single regeneration также использует
эту проверяемую transaction вместо прежнего встроенного сброса states.
16 targeted tests + tsc + Vite bundling (.cache/group-surface-build) + diff-check
прошли. Включён тест создания поверхности zero-size группы, сохранения base/pivot,
эффекта на подготовленный child mesh и отсутствия мутации потомков. Браузерная
проверка dialog/undo и Rust/WASM/dist всё ещё не выполнена. Следующий крупный блок:
format/needs и удаление старого NxN runtime/UI, затем полная проверка цепочки.

## Этап 20: формат 8, needs 27 и запрет stale WASM build

PRESET_FORMAT поднят до 8, VERSION.core и Rust CORE_GENERATION — 27. Любая
запись через stampPreset явно ставит текущий version, а не сохраняет номер
входного объекта: старый frontend формата 7 откажется открыть новый файл вместо
молчаливой потери artMesh/artPose. needsCore распознаёт artMesh и генерируемые
states_art_w locals как требование 27; простые сцены не получают 27 автоматически.
Промежуточно форматы 2–7 ещё читаются; legacy runtime/UI пока НЕ удалены.

scripts/check-wasm-core.mjs инстанцирует реальный public/rig_core.wasm, сверяет
его ответ version с Rust source generation, затем проверяет vertex-only watch
вычислением кадра. build-wasm вызывает проверку как при fallback без Cargo, так
и после компиляции. Больше нельзя получить «успешную сборку» с прежним WASM,
который не поддерживает новый contract. Это намеренно ужесточает build gate.

28 targeted tests + tsc + diff-check прошли, version:report согласовал 27 в
таблице/редакторе/Rust. Отдельный npm run build:wasm ОЖИДАЕМО завершился code 1:
Cargo отсутствует, существующий артефакт не сообщает требуемое поколение 27.
WASM probe успешного ядра пока проверить нельзя; Rust tests не выполнены.
`npm run build` теперь тоже будет блокироваться до полноценной Rust/WASM сборки.
Dist/public WASM не обновлены. Следующий шаг — удалить старые NxN-пути, но не
объявлять миграцию готовой до Rust/browser/Windows проверок.

## Этап 21: удаление старого authoring UI

Удалены старые NxN/warp панели Inspector, Scene grid/art/manual selectors,
line-chain toolbar, zone/control-node/warp drag handlers, overlay helpers и их
локальное состояние. Убраны Scene onMesh/onWarp callbacks и соответствующие
App setters. Более 1200 строк старого UI/controller кода удалено, а не оставлено
за feature flag. У неподготовленного объекта T/R ничего не создают неявно:
доступны генератор/clipboard; Inspector явно показывает «НЕТ СЕТКИ».
T/R titles и справочник клавиш описывают новый артмеш, без Ctrl-зоны и ручных
цепочек. Scene больше не подмешивает numeric-grid preview; hit-test нового меша
получает те же frame/preview vertex offsets.

124 targeted math/protocol/source tests (все art-*, кроме недоступного browser UI,
плюс states/shortcuts), tsc, Vite bundling и diff-check прошли. Добавлен static
regression test отсутствия legacy authoring API/панелей. Это не DOM доказательство:
Chromium и Cargo всё ещё отсутствуют, public WASM/dist не обновлены.

Осталось удалить собственно legacy render/bend/runtime, GridSpec recording/remap
в App/StatesPanel/states, старые типы/fixtures/clipboard modules и согласовать
поведение старых demo presets без compatibility engine. Этот этап НЕ объявляет
старый runtime удалённым: он пока ещё используется при чтении старых объектов.

## Этап 22: единственный runtime поверхностей

Удалены cage/zone sampling, source tessellation caches, numeric node picking и
bendFrame (перенос центра ребёнка). meshGeometry/meshSurfaceGeometry теперь
возвращают только явный artMesh. rigCanvas, bounds и Scene больше не включают
warp fallback и не создают render-only defaultMesh ребёнку. Наследование требует
artMesh ребёнка и явного deformParent=true; объектные базы не изгибаются.
Хит-тест сцены использует реальные треугольники, включая пустоты, и state offsets
даже без деформации родителем.

21 целевой тест, TypeScript, Vite bundling прошли. Добавлены проверки, что поля
старого cage не включают sampler/surface и production renderer их не импортирует.
Старые тесты bend/mesh authoring относятся к удалённому API и ещё требуют замены;
не объявляем полный suite зелёным. Legacy schema/state recording пока остаются.

## Этап 23: удаление схемы и recording старой системы

Удалены engine/mesh.ts (~1700 строк), meshClipboard.ts, render/warp.ts, старые
Warp/ArtMesh/Grid/Mesh/Brush/Mirror типы. Общая affineFromTriangles выделена в
triangleAffine.ts. Удалены gridRecordDelta и билинейный remap ключей, сеточные
refs/onMesh в StatesPanel/RightPanel/App. Запись вершин теперь только stable-ID
local offsets; копирование объекта владеет копией artMesh/artPose. Протокол сцены
не хеширует старые mesh/warp. normalizePreset удаляет старые payload поля без
миграции/создания геометрии; старые сцены без artMesh рисуются недеформированными.
Исторический feature catalogue оставляет названия warp-параметров как историю
поколений, но они удалены из TS/Rust built-in output channels (Param::ALL = 19).
Rust source пока не компилировался здесь. Старые authoring tests удалены вместе с
их API; общие matrix/render/overlay/state tests сохранены, mesh fixtures заменены
на новый формат. Сторожи README и launcher specs приведены к реальным файлам;
publish fixture генерирует свой паспорт вместо зависимости от устаревшего dist.
Node-only renderer не запоминает отсутствие document как отказ настоящего GPU;
mask scratch не переезжает между разными document (включая тестовые).

**567 тестов в 84 browser-free файлах прошли одним запуском**, TypeScript и
Vite bundling прошли. Browser впервые удалось запустить из npm-пакета Chromium
в ignored .cache вместе с его NSS libs; alpha UI test прошёл после исправления
CJS/ESM импорта React в тестовой harness. Это пока только alpha generator test,
не утверждение о полной browser/native/OBS проверке. Ничего из browser-tools,
бинарников и временных сборок в Git не добавляется.

## Этап 24: browser authoring/undo и финальный контракт

Реальный App в Chromium: Cancel/Apply генерации, один Ctrl+Z для замены; pose drag
не меняет rest, rest drag не меняет UV/pose, каждый жест отменяется одним шагом;
clipboard требует подтверждения и отменяется; подготовка потомков учитывает
scope/inheritance и откатывается целиком; вставка вершины отменяется вместе с
ID/UV/гранями. **Все 5 App browser tests прошли**. Отдельно alpha source/preview/
Apply browser test прошёл. Смешанный запуск с serverless Chromium однажды упал
на создании browser context после первого теста (не на assertion продукта);
финальные раздельные запуски обоих файлов успешны.

Финальный полный browser-free запуск: **569 passed**. TypeScript, Vite bundling,
diff-check, version report согласованы. Добавлен Rust Param contract test, но
Rust тесты НЕ запускались: Cargo отсутствует. `npm run build:wasm` предсказуемо
exit 1: реальный старый artifact не отвечает core28. Успешный gate на новом
скомпилированном WASM здесь ещё не проверен.

Удаление built-in warp channels — разрыв контракта: core **28**, ACCEPTS_FROM
**28**, warp-формулы помечены removed28. Формат остаётся 8; art vertex weights
по-прежнему требуют минимум27. Полная версия **1.1.28.8.2.5.21**. Активный legacy
cage без artMesh теперь отклоняется при чтении, а не теряет форму молча;
выключенные defaults удаляются. README описывает новый UX; PLAN-RIG помечен как
исторический. В docs/BUILD.md записаны команды пересборки и native/OBS checklist.

### Что остаётся за внешней компиляцией/приёмкой

- `cargo test -p rig-core`, реальный build:wasm/core28 gate и test:engine;
- полноценный `npm run build` / Tauri Windows build и обновление public WASM/dist;
- vertex-only playback закрытой вкладки на новой бинарной сборке;
- WebView2/OBS, аппаратный GPU и сложные модели с глубокой вложенностью;
- стресс-проверка качества/performance сложных alpha-контуров (bounded sync
  raster/генерация; не Delaunay; возможна блокировка UI на тяжёлой пачке).

Это не оставленные compatibility ветки и не незаконченный перенос NxN: старый
движок физически удалён. Это оставшиеся непроверенные среды и качественные
ограничения, которые нельзя выдать за успешно пройденные.

## Исправление диагностики открытия после этапа 24

Отказ legacy cage / битого artMesh раньше выполнялся в normalizePreset, но
presetCompatibility знал только формат: получался canOpen=true с пустыми issues
при фактическом отказе. Общий presetObjectDataIssues теперь используется обоими
путями. Отчёт содержит имя объекта, причину и действия; неизвестный отказ тоже
получает непустую причину. Диалог отказа больше не утверждает, что файл обязательно
новее и обновление его починит. Текущая сцена при отказе остаётся неизменной.
Проверено: 15 targeted protocol/math tests, browser upload/rejection test реального
App, TypeScript и Vite bundling. Legacy runtime не восстановлен, автоматической
конвертации нет.

## Исправление глаз структуры в стопе/паузе

Замороженный кадр раньше держал прошлый visible и обновлялся только от симуляции;
повторное включение также не могло восстановить значение, уже затёртое enabled.
applyEnabled теперь сохраняет sparse pre-eye visibility только для реально
замаскированных объектов. В паузе/стопе флаг структуры переобрабатывает готовый
кадр без tick, продвижения времени, пересчёта формул/physics. stoppedFrame общий
для редактора и overlay; скрытые формулой объекты не становятся видимыми от глаза.
Renderer/hit-test дополнительно исключают выключенные поддеревья: дети скрытой
группы не всплывают стоп-призраками. Поле enabledVisibility — frontend-only,
опциональное, не требует новой сборки ядра само по себе.
Проверено: 573 browser-free tests одним запуском, TypeScript/Vite/diff-check;
2 browser pixel tests реального App (hide/show в стопе и паузе; скрытие/возврат
группы с потомком); overlay transport regression для frozen hide/show.
Windows WebView2 и OBS нативно здесь не проверялись.

### Artmesh authoring workspace (2026-10-24)

- Scene toolbar now opens a docked, scrollable artmesh panel. Tools/brushes/radius/symmetry and mesh generation/descendants/copy/paste have separate tabs; shortcut help no longer shares the title's text flow.
- Manual start creates an explicit empty artmesh. In rest mode, Create point inserts/interpolates within an existing triangle or creates a loose vertex outside. Loose vertices can be selected/moved and joined with explicit three-point faces. Connect points is restricted to meshes without faces: convex hull plus interior insertion, preserving IDs, UV, poses and undo. Concave outlines/holes require manual faces, not automatic hull filling.
- Rest editor can display a translucent source for tracing, editor-only (not overlay or ambient sampling). Empty meshes remain actual empty authored meshes, not an implicit fallback geometry.
- Generation dialog has separate parameter/preview columns, styled numeric/select controls, alpha silhouette preview, vertex markers and counts, responsive scrolling and explicit Apply/Cancel.
- Alpha generation uses staggered triangular interior samples and constrained local edge flips improving minimum angles without moving vertices/UV or changing contour/hole edges. Circle regression checks local edge lengths, nonzero faces, vertex participation and interior coverage; existing hole/island tests retained. No claim of a concentric radial mesher or universal optimal triangulation.
- Validation: TypeScript + Vite-only bundle, 575 browser-free tests; browser generator test and all 9 App artmesh scenarios passed (7 in initial run, remaining 2 after test navigation/debounced-save assertion corrections). Native Rust/WASM/Windows/OBS gates remain external; no binaries rebuilt here.

### Restore direct mesh controls (2026-10-24, supersedes workspace controls above)

- Removed the mesh mode/selection dropdowns and separate create point, split, create/delete face and connect point controls. T and R remain the two scene authoring contexts, not panel submodes. The ordinary V/M/L toolbar and physical shortcuts now select vertices inside the active mesh context without switching to object selection.
- R: click empty space to create a point (interpolated split inside faces, connected to valid visible boundary edges outside); drag an existing/new vertex normally. The first non-collinear points triangulate automatically. Shift selects vertices and joins three by a face if valid. Alt-click erases a vertex, an edge's incident faces, or the face under the pointer. Deletion of an edge is one undo transaction. Delete/Backspace inside mesh editing never delete the scene object.
- Rest dragging now reprojects UV from the edited local coordinate/object dimensions: topology editing no longer stretches the image as pose deformation did. Relative pose/state offsets remain intact. T pose editing still retains UV and changes only pose offsets. The soft brush is restricted to T; R has no brush movement submode.
- Validation: 577 browser-free tests, 10 actual App browser scenarios, TypeScript; includes new vertex drag after V/M/L, UV projection, Alt erasure/undo, automatic boundary connection and atomic edge erasure. Native binaries are not rebuilt by these frontend changes.

### Automatic rest topology and arbitrary-angle symmetry (2026-10-24)

- Rest editing now rebuilds the point-set triangulation during dragging, on click insertion and after vertex/edge/face erase gestures. Uses robust Delaunator triangulation rather than leaving the incident faces absent or retaining old diagonals. Rebuild preserves vertex order/IDs/UV, nextId and authored/state offsets. Pose editing does not retriangulate. This is Delaunay local triangle quality, not a claim of a globally minimum-total-edge-length graph.
- Automatic rest rebuilding covers the convex hull of the current points, as the direct point-set editor does; it does not persist deleted diagonals as constraints. Thus an erased edge may be selected again if the rebuilt triangulation requires it, and point-set rebuilding can fill previously authored holes/concavities. Alpha generation itself still preserves its alpha boundaries/holes until automatic point-set editing is performed. Collinear/under-three-point sets cannot form faces; coincident points cannot both participate in a nondegenerate triangulation.
- Symmetry is enabled with a checkbox and a numeric angle (degrees, zero vertical, 90 horizontal). Pair lookup, reflected deltas, on-axis motion projection and the rendered guide all use the same object-local angle/center. Does not generate hidden mirror vertices where no counterpart exists.
- Validation: 582 browser-free tests including new diagonal-rebuild, erasure/orphan, degenerate-set and arbitrary-angle tests; 12 actual App scenarios including 45-degree rest movement and Alt edge rebuild. TypeScript, Vite-only build and diff checks passed. Native/WASM/Windows/OBS remain external gates.

### Camera, mode exit and alpha layouts (2026-10-24)

- Removed automatic Fit on mesh-panel visibility and T/R context transitions. Only initial scene initialization and explicit Fit reposition the camera. Browser regression pans/zooms, toggles the panel and compares both the content's pixel origin and zoom.
- Active T/R toggles back to ordinary object cursor. Escape and an explicit panel exit button also exit mesh editing; V/M/L still select vertices within the current context. Escape first cancels an active region-selection gesture without also exiting. Starting/applying a mesh while already in R no longer triggers its toggle off.
- Alpha generation now triangulates contour constraints and ALL interior samples together using constrained Delaunay (`cdt2d`). Removed Earcut and its dependencies; temporary bridge diagonals are no longer retained. Long unconstrained edges in thin features missed by the sampling lattice receive bounded midpoint refinement. Hole/island constraints remain separate.
- Alpha layout options: plain rectangular rows or concentric rings around an interior center per component. For a component whose geometric center is outside/inside a hole, choose a sampled occupied point with maximum boundary clearance. Clip rings/rows against the component and its holes. These are sampling layouts, not immutable radial edge constraints.
- Boundary points are uniformly resampled by arc length after simplification: contour step now reduces density instead of only subdividing already-dense pixel corners. Default simplification is 4 local px. Simplification/nesting/intersection failures back off automatically, first reducing simplification without increasing sampling density, then refining sampling if needed, finally using valid unsimplified contours. Geometry/budget errors still reject Apply atomically. Fine strands may be lost at coarse user-selected contour/simplification settings; no fixed vertex-count promise for an unprovided source image.
- Validation: 586 browser-free tests; 13 actual App scenarios; standalone alpha dialog browser test including radial selection; TypeScript, Vite-only bundle and diff checks. Added both-layout circle edge-length/participation checks, hairy contour density and simplification 4/7/8/20, both-layout hole preservation and thin-strip edge refinement. Last fallback-density adjustment rechecked with all 9 alpha tests and TypeScript. Native/WASM/Windows/OBS remain external.

### Generator numeric drafts and regular source preview (2026-10-24)

- All generator numeric controls (including group dimensions, regular rows/columns/inset and alpha parameters) now keep text drafts inside DeferredNumberInput. No generation runs on intermediate keystrokes. Commit on blur, Enter or 5000 ms without edits; timers restart on edits and are cleared on unmount. Empty/nonfinite drafts revert to the last committed number. Clicking Apply after a normal pending draft commits it on blur before applying the resulting mesh.
- Explicit unit step and integer-aligned minimum for alpha spacing remove the native min=0.1/step=1 lattice which turned 100 into 100.1. Decimal manual entry remains available; arrow stepping uses whole units.
- Source capture retains RGBA in addition to alpha and is available in regular mode as well as alpha mode. Both previews show the actual authored source pixels underneath topology; groups remain explicitly untextured. Missing regular preview sources do not block regular generation.
- Deferred Live2D-style mesh-line generation is recorded in docs/BACKLOG.md, not implemented in this change.
- Validation: TypeScript, 586 browser-free tests, Vite-only bundle, diff check; three standalone browser generator scenarios (alpha apply, Enter/blur/5s draft timing + arrow stepping, regular RGBA source pixels + latest-draft Apply), plus actual App regular-generation undo and descendant-batch scenarios. Draft timeout test uses Playwright clock to assert the 4900/5000 ms boundary. Native gates remain external.

### Persistent manual topology, brush tools, key actions and source selection (2026-10-24)

This entry supersedes the earlier erase-and-rebuild policy: explicitly removed
faces are intentional holes, not a request to restore the convex hull there.

- Shift-click three vertices in R to pin a manual face. Its edges constrain
  subsequent automatic Delaunay rebuilding, even when another diagonal is shorter.
  Alt-click a face/edge cuts the affected faces persistently. `manualFaces` and
  `excludedFaces` use stable vertex IDs, survive strict loading and clipboard ID
  remapping, and are cleared with full generation replacement. Only the union
  boundary of adjacent cuts is constrained; a new manual face can fill part of a
  cut using a different diagonal without restoring the other half. Automatic
  edges remain automatic elsewhere. Crossing manual constraints reject the drag
  with an error rather than passing an invalid graph to the triangulator.
- Brush is a toolbar tool (B); V/M/L leave brush selection for vertex selection,
  without leaving T/R context. Symmetry is an independent toolbar toggle.
  Both have downward chevrons and hover/focus dropdowns beneath their icons.
  Brush options: radius, hardness and static/dynamic mode. Static fixes influence
  at pointer-down; dynamic samples moved vertices under each current cursor
  position and integrates only that motion increment. Leaving its circle stops
  further influence. A mirrored brush samples a reflected footprint as well as
  reflecting motion, so it does not depend on exact symmetric vertex pairing.
  Mirrored circle and angled axis are shown. Hardness controls the full-strength
  inner radius and smooth edge falloff; overlapping symmetric influence is not
  summed twice. Brush deformation remains a T operation, not rest-topology paint.
- R now renders the selected object's rest surface without its own pose/state
  offsets, matching displayed base vertices; this is scene-only, not a saved pose
  reset. Reference tracing ignores the selected source's mask/runtime opacity and
  visibility and handles root objects/empty meshes. Explicit structure-disabled
  objects/subtrees still remain hidden. Ancestor transformations remain active.
- Recording an authored mesh gesture into a state key uses the gesture's original
  undo snapshot; the script update/restoration no longer adds a second history
  step. Verified brush key recording, Ctrl+Z and redo in the actual App.
- Key context menus are available on bound timeline dots/chips, empty timeline
  positions and free-pose rows. Copy, replace/paste and vertical/horizontal mirror;
  paste preserves target time/weight and validates mesh point IDs. Mirror remaps
  paired stable vertex IDs as well as reflecting offsets. Playhead beam no longer
  intercepts clicks on actual keys. Layer-wide clipboard/menu commands are intact.
- Inspector → Parameters → Artmesh: choose deformation sources individually in a
  highlighted hierarchy; Show all layers reveals unrelated objects too. Explicit
  `deformSources` selects only those surfaces (empty list means none), with the
  enable checkbox retained. Without an explicit list the enabled ancestor chain
  remains the default; disabled still means position-only, no invented geometry.
  Selected sources use their own surface offsets, not recursively expanded source
  lists, avoiding implicit extra inheritance and dependency cycles. Self/missing
  sources are ignored; application is descendant-first, then stable scene order.
  Shared TS renderer and serialized overlay geometry use the same source selection;
  changing the list invalidates the overlay scene signature.
- Validation: TypeScript, Vite-only bundle, diff check; **592 browser-free tests**
  and **18 actual App browser scenarios**. New coverage includes manual constraints,
  holes/rest movement/clipboard, arbitrary source selection, toolbar brush symmetry,
  static/dynamic strokes, key undo/redo, key menus including paste at a new time,
  reference pixels and rest-surface alignment. Native Rust/WASM/Windows/OBS gates
  remain untested here; no new binary-validation claim.

### Ordered manual edge chains (2026-10-24)

- In rest/topology mode R with the cursor V, hold Ctrl (or Meta) and click
  vertices in order: A → B → C adds A–B and B–C, without implicitly closing A–C
  and without creating a manually pinned triangular face. Releasing the modifier,
  clicking elsewhere normally, changing object/tool, blur or undo ends the chain.
- `manualEdges` are stable-ID constraints for the shared constrained Delaunay
  rebuild. They take priority over automatic diagonals; automatic neighbouring
  triangles continue to rebuild as points move. Existing intermediate vertices
  split a line into consecutive nonoverlapping edges, including points inserted
  onto that line later. Conflicting manual constraints require a common vertex;
  a crossing is rejected atomically, not passed to the triangulator.
- Manual edges are highlighted in orange in R and are drawable/pickable even
  without any surface triangles. Alt-click removes an edge and cuts incident
  faces consistently with existing erase controls. Endpoint deletion clears its
  edge references. Existing intentional cut regions are not filled by drawing
  a wire through them. JSON validation, clipboard ID remapping, undo/redo and
  regeneration follow the same rules as manual face constraints.
- Validation: TypeScript, Vite-only build and diff checks; **597 browser-free
  tests** and **19 actual App browser scenarios**. New tests cover a deliberately
  longer constrained diagonal, consecutive-series semantics, intermediate-point
  splitting, atomic crossing rejection, edge-only geometry, JSON/clipboard,
  Ctrl-chain lifecycle, rest drag, Alt erasure and undo/redo. Native gates remain
  external; no Rust/WASM binaries rebuilt here.

### Reconnect authored points and explicit auto-lines action (2026-10-24)

- Creating a connected point inside a previously erased face now locally reopens
  the containing cut triangle(s) before insertion. The point is immediately part
  of the triangulation; UV, authored offsets and every state key interpolate from
  that restored surface. Unrelated cut regions remain excluded. Merely moving
  points or rebuilding still respects intentional cuts; adding a new point there
  is now an explicit request to author surface there.
- R panel → **Создать автолинии**: with no selected current vertices, rebuild using
  all points and clear intentional cut exclusions. With a selection from any
  selection tool, reopen cuts incident to selected vertices or containing selected
  loose points, and triangulate against the complete surrounding point set (not
  an isolated mesh containing only the selection). Other cuts stay intact. Manual
  edges/faces retain priority in both cases; IDs, rest, UV, authored poses and state
  keys are not regenerated. Each button action is a single undo transaction.
- Validation: TypeScript, Vite-only bundle, diff checks, **600 browser-free tests**
  and **21 actual App browser scenarios**. Added cut-insertion/interpolation,
  selected/all reconnection, untouched cut preservation, manual edge priority,
  marquee-selected UI action and undo checks. Native gates remain external.

### Самостоятельная кисть точек (2026-10-24)

- B и постоянная иконка рядом с V выбирают кисть без входа в редактор сетки. В R/T кисть сохраняет текущую базу/позу, в редакторе контура — выбранный контур.
- Кисть работает с вершинами артмеша и точками path-фигуры; для контура не создаётся и не сохраняется артмеш. Без доступных точек мазок ничего не меняет.
- Радиус, жёсткость и static/dynamic доступны под иконкой; симметрия также доступна вне панели артмеша. Мазок отменяется одним действием.
- Проверки: TypeScript, Vite, 600 pure-тестов и 23 браузерных сценария, включая кисть вне редактора, сохранение R и контур без сетки. Native/WASM сборка в этой среде не проверена.

### Очистка влияния удалённых слоёв (2026-10-24)

- Удаление последнего слоя состояний очищает предпросмотр, даже если панель остаётся открытой: его поза больше не влияет на объект и наследующих детей.
- Кэш живого вклада учитывает изменение скрипта слоя, а не только номер кадра/индекс.
- При удалении объекта его ID удаляется из явных deformSources оставшихся объектов; пустой список остаётся явным, без включения всех предков.
- Проверено: TypeScript, 24 браузерных сценария (включая визуальную регрессию удаления слоя с дочерней поверхностью), 64 профильных теста состояний/смешивания/проигрывания. Native/WASM не проверен.

### Базовый трансформ и Delete в структуре (2026-10-24)

- Отдельный инструмент G рядом с T/R. Он меняет существующие base-каналы x/y, sizeX/sizeY, rotation, skewX/skewY, не вершины/UV артмеша.
- Восемь точек: углы — XY, середины — одна ось. За участок грани между точками — skew. Четыре выносные крутилки — поворот; внутри рамки — перемещение.
- Без модификаторов масштаб/skew держат противоположную точку/грань, поворот — центр рамки. Alt использует пивот, Shift — центр рамки; при совместном нажатии Alt приоритетнее.
- Ctrl/Cmd на начале жеста правит только зону трансформа. Её affine-рамка хранится в transformFrame в координатах контента и не меняет изображение. Зона не является второй деформирующей сеткой. Следующие жесты учитывают её размер/направление. Это настройка инструмента объекта, а не ключ анимации.
- Обычные трансформы записываются в активный слой состояний существующими каналами. Запись позы использует уже открытый шаг истории жеста: отмена одним действием.
- Delete/Backspace редактора вершин теперь ограничен фокусом сцены. Дерево получает собственный фокус, поэтому Delete удаляет объекты даже при активных T/R/B. Поля переименования сохраняют обычное редактирование текста.
- Регрессии: математика опор и affine-преобразований с поворотом/skew, Ctrl-рамка, Delete дерева с отменой, базовый масштаб без изменения сетки, запись масштаба в состояние с одной отменой. Native/WASM сборка здесь не проверена.
