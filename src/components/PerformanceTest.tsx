import {useEffect,useRef,useState} from "react";
import {collectPerformanceReport} from "../engine/performanceReport";

interface Report {text:string;label:string;cpu:number|null;draws:number;frames:number}
/** State stays local: diagnostic UI never rerenders the editor tree. */
export function PerformanceTest({context}:{context:()=>object}) {
  const latest=useRef(context);latest.current=context;
  const controller=useRef<AbortController|null>(null);
  const text=useRef<HTMLTextAreaElement>(null);
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
        const report:Report={text:result,label:`${new Date().toLocaleTimeString()} · ${data.contextStart.mode??"замер"}`,
          cpu:data.native.meanCpuPercent,draws:data.work.drawsPerSecond,frames:data.work.framesPerSecond};
        setReports(previous=>[report,...previous].slice(0,5));setSelected(0);setOpen(true);
      }
    } catch(error){if(!abort.signal.aborted){setMessage(`Ошибка диагностики: ${String(error)}`);setOpen(true);}}
    finally{if(controller.current===abort)controller.current=null;if(!abort.signal.aborted)setRunning(false);}
  };
  const cancel=()=>{controller.current?.abort();controller.current=null;setRunning(false);setMessage("Замер отменён");};
  const report=reports[selected];
  const fallbackCopy=()=>{text.current?.focus();text.current?.select();setMessage("Нажмите Ctrl+C, чтобы скопировать выделенный отчёт");};
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
    {open&&<div className="dialog-backdrop">
      <div className="overlay-dialog performance-dialog" role="dialog" aria-modal="true" aria-label="Диагностика производительности" onKeyDown={event=>{event.stopPropagation();if(event.key==="Escape")setOpen(false);}}>
        <header className="dialog-head"><h3>Диагностика производительности</h3><button autoFocus onClick={()=>setOpen(false)}>Закрыть</button></header>
        <div className="dialog-body">
          <p>Пассивный замер: сцена, частота симуляции и настройки не меняются. Окно диагностики скроется на время теста. Оставьте приложение видимым и не редактируйте сцену. Сравните работу, паузу и стоп отдельными замерами.</p>
          <div className="performance-actions">
            <label>Длительность <select aria-label="Длительность замера" disabled={running} value={duration} onChange={event=>setDuration(Number(event.target.value))}>
              <option value={15}>15 секунд</option><option value={30}>30 секунд</option><option value={60}>60 секунд</option>
            </select></label>
            {running?<button onClick={cancel}>Отменить · {remaining} с</button>:<button onClick={()=>void start()}>Начать замер</button>}
          </div>
          <p>CPU и память дерева процессов доступны в новой нативной сборке Windows/Linux. В браузере или старой оболочке будет частичный отчёт. GPU utilization/time, чистое IPC-время и полный профиль React не измеряются.</p>
          {reports.length>0&&<>
            <h4>Последние замеры · только в памяти этого окна</h4>
            <table className="performance-history"><thead><tr><th>Замер</th><th>CPU дерева</th><th>Рисований/с</th><th>Кадров/с</th></tr></thead>
              <tbody>{reports.map((item,i)=><tr key={item.label+String(i)}><td><button aria-pressed={selected===i} onClick={()=>{setSelected(i);setMessage("");}}>{item.label}</button></td><td>{item.cpu===null?"н/д":`${item.cpu.toFixed(2)}%`}</td><td>{item.draws.toFixed(1)}</td><td>{item.frames.toFixed(1)}</td></tr>)}</tbody>
            </table>
            <p>CPU: 100% = все логические ядра. Проверьте cpuCoverage и предупреждения отчёта: неполное покрытие процессов может занижать сумму.</p>
            <textarea ref={text} aria-label="Текст отчёта" readOnly value={report?.text??""} onFocus={event=>event.target.select()} />
            <div className="performance-actions"><button onClick={()=>void copy()}>Копировать отчёт</button><button onClick={save}>Скачать .txt</button></div>
          </>}
          <p role="status">{message}</p>
        </div>
      </div>
    </div>}
  </>;
}
