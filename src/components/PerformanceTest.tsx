import {createPortal} from "react-dom";
import {useEffect,useRef,useState} from "react";
import {collectPerformanceReport} from "../engine/performanceReport";

interface Report {text:string;label:string;cpu:number|null;draws:number;frames:number;drawMs:number;heapDelta:number;status:string;hidden:boolean}
/** State stays local: diagnostic UI never rerenders the editor tree. */
export function PerformanceTest({context}:{context:()=>object}) {
  const latest=useRef(context);latest.current=context;
  const controller=useRef<AbortController|null>(null);
  const text=useRef<HTMLTextAreaElement>(null);
  const raw=useRef<HTMLDetailsElement>(null);
  const [open,setOpen]=useState(false),[running,setRunning]=useState(false);
  const [duration,setDuration]=useState(15),[remaining,setRemaining]=useState(0);
  const [reports,setReports]=useState<Report[]>([]),[selected,setSelected]=useState(0);
  const [message,setMessage]=useState("");
  useEffect(()=>()=>{controller.current?.abort();},[]);
  useEffect(()=>{
    if(!running)return;
    const until=Date.now()+duration*1000;
    const timer=setInterval(()=>setRemaining(Math.max(0,Math.ceil((until-Date.now())/1000))),1000);
    return ()=>clearInterval(timer);
  },[running,duration]);
  const start=async()=>{
    if(controller.current)return;
    const abort=new AbortController();controller.current=abort;
    setRunning(true);setRemaining(duration);setMessage("");setOpen(false);
    try {
      const result=await collectPerformanceReport(()=>latest.current(),abort.signal,duration*1000);
      if(!abort.signal.aborted){
        const data=JSON.parse(result.slice(result.indexOf("\n")+1));
        const modes:Record<string,string>={playing:"Работа",paused:"Пауза",stopped:"Стоп"};
        const report:Report={text:result,label:`${new Date().toLocaleTimeString()} · ${modes[data.contextStart.mode]??"Замер"}`,
          cpu:data.native.meanCpuPercent,draws:data.work.drawsPerSecond,frames:data.work.framesPerSecond,
          drawMs:data.work.drawMeanMs,heapDelta:data.memoryEnd.heapLimit>0&&data.memoryStart.heapLimit>0?(data.memoryEnd.heapUsed-data.memoryStart.heapUsed)/1048576:NaN,
          status:data.native.status,hidden:data.validity.hiddenDuringTest};
        setReports(previous=>[report,...previous].slice(0,5));setSelected(0);setOpen(true);
      }
    } catch(error){if(!abort.signal.aborted){setMessage(`Ошибка диагностики: ${String(error)}`);setOpen(true);}}
    finally{if(controller.current===abort)controller.current=null;if(!abort.signal.aborted)setRunning(false);}
  };
  const cancel=()=>{controller.current?.abort();controller.current=null;setRunning(false);setMessage("Замер отменён");};
  const report=reports[selected];
  const fallbackCopy=()=>{if(raw.current)raw.current.open=true;requestAnimationFrame(()=>{text.current?.focus();text.current?.select();});setMessage("Нажмите Ctrl+C, чтобы скопировать выделенный отчёт");};
  const copy=async()=>{if(!report)return;try{if(!navigator.clipboard){fallbackCopy();return;}await navigator.clipboard.writeText(report.text);setMessage("Отчёт скопирован");}catch{fallbackCopy();}};
  const save=()=>{
    if(!report)return;
    const url=URL.createObjectURL(new Blob([report.text],{type:"text/plain;charset=utf-8"}));
    const link=document.createElement("a");link.href=url;link.download="yappytuber-performance.txt";
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <>
    <button onClick={()=>setOpen(true)} title="Встроенная диагностика CPU, памяти и кадров; данные никуда не отправляются">
      {running?`Диагностика · ${remaining} с`:"Диагностика"}
    </button>
    {open&&createPortal(<div className="dialog-backdrop performance-backdrop">
      <div className="overlay-dialog performance-dialog" role="dialog" aria-modal="true" aria-label="Диагностика производительности" onKeyDown={event=>{event.stopPropagation();if(event.key==="Escape")setOpen(false);}}>
        <header className="dialog-head"><div><span className="performance-eyebrow">ИНСТРУМЕНТЫ ПРИЛОЖЕНИЯ</span><h3>Диагностика производительности</h3></div><button className="performance-button" autoFocus onClick={()=>setOpen(false)}>Закрыть</button></header>
        <div className="dialog-body">
          <section className="performance-section"><h4>Новый замер</h4>
          <p>Пассивный замер: сцена, частота симуляции и настройки не меняются. Окно диагностики скроется на время теста. Оставьте приложение видимым и не редактируйте сцену. Сравните работу, паузу и стоп отдельными замерами.</p>
          <div className="performance-actions">
            <label>Длительность <select aria-label="Длительность замера" disabled={running} value={duration} onChange={event=>setDuration(Number(event.target.value))}>
              <option value={15}>15 секунд</option><option value={30}>30 секунд</option><option value={60}>60 секунд</option>
            </select></label>
            {running?<button className="performance-button performance-cancel" onClick={cancel}>Отменить · {remaining} с</button>:<button className="performance-button performance-primary" onClick={()=>void start()}>Начать замер</button>}
          </div>
          </section>
          <p className="performance-note">CPU и память дерева процессов доступны в новой нативной сборке Windows/Linux. В браузере или старой оболочке будет частичный отчёт. GPU utilization/time, чистое IPC-время и полный профиль React не измеряются.</p>
          {reports.length>0&&<>
            <section className="performance-section"><h4>Последние замеры <small>До 5 · в памяти окна</small></h4>
            <table className="performance-history"><thead><tr><th>Замер</th><th>CPU дерева</th><th>Рисований/с</th><th>Кадров/с</th></tr></thead>
              <tbody>{reports.map((item,i)=><tr key={item.label+String(i)}><td><button aria-pressed={selected===i} onClick={()=>{setSelected(i);setMessage("");}}>{item.label}</button></td><td>{item.cpu===null?"н/д":`${item.cpu.toFixed(2)}%`}</td><td>{item.draws.toFixed(1)}</td><td>{item.frames.toFixed(1)}</td></tr>)}</tbody>
            </table>
            </section>
            {report&&<section className="performance-section"><h4>Результат выбранного замера</h4>
              <div className="performance-cards">
                <div><span>CPU приложения + WebView</span><strong>{report.cpu===null?"Недоступно":`${report.cpu.toFixed(2)} %`}</strong><small>Среднее по дереву процессов</small></div>
                <div><span>Перерисовки сцены</span><strong>{report.draws.toFixed(1)} / с</strong><small>Движок: {report.frames.toFixed(1)} кадров/с</small></div>
                <div><span>Вызов отрисовки</span><strong>{report.drawMs.toFixed(2)} мс</strong><small>Среднее CPU-время, не GPU</small></div>
                <div><span>Изменение JS-кучи</span><strong>{Number.isFinite(report.heapDelta)?`${report.heapDelta>0?"+":""}${report.heapDelta.toFixed(1)} МБ`:"Недоступно"}</strong><small>За замер · не вся память процесса</small></div>
              </div>
              {report.status!=="measured"&&<p className="performance-warning">Частичный отчёт: системные показатели не измерены или недостаточно проб.</p>}
              {report.hidden&&<p className="performance-warning">Окно было скрыто: браузер мог замедлить таймеры. Повторите замер с видимым окном.</p>}
            </section>}
            <p className="performance-note">CPU: 100% = все логические ядра. Проверьте cpuCoverage и предупреждения отчёта: неполное покрытие процессов может занижать сумму.</p>
            <section className="performance-section"><h4>Отчёт для отправки</h4>
            <div className="performance-actions"><button className="performance-button performance-primary" onClick={()=>void copy()}>Копировать отчёт</button><button className="performance-button" onClick={save}>Скачать .txt</button></div>
            <details ref={raw}><summary>Технические данные · полный текст</summary>
            <textarea ref={text} aria-label="Текст отчёта" readOnly value={report?.text??""} onFocus={event=>event.target.select()} />
            </details></section>
          </>}
          <p role="status">{message}</p>
        </div>
      </div>
    </div>,document.body)}
  </>;
}
