import {useEffect,useRef,useState} from "react";
import {collectPerformanceReport} from "../engine/performanceReport";

/** Local state only: running this test must not rerender the editor tree. */
export function PerformanceTest({context}:{context:()=>object}) {
  const latest=useRef(context);latest.current=context;
  const controller=useRef<AbortController|null>(null);
  const text=useRef<HTMLTextAreaElement>(null);
  const [running,setRunning]=useState(false),[report,setReport]=useState("");
  const [message,setMessage]=useState("");
  useEffect(()=>()=>{controller.current?.abort();},[]);
  const start=async()=>{
    if(controller.current) return;
    const abort=new AbortController();controller.current=abort;
    setRunning(true);setReport("");setMessage("");
    try {const result=await collectPerformanceReport(()=>latest.current(),abort.signal);if(!abort.signal.aborted)setReport(result);}
    catch(error) {if(!abort.signal.aborted)setMessage(`Ошибка диагностики: ${String(error)}`);}
    finally {if(controller.current===abort)controller.current=null;if(!abort.signal.aborted)setRunning(false);}
  };
  return <>
    <button onClick={()=>{if(running){controller.current?.abort();controller.current=null;setRunning(false);}else void start();}}
      title="15 секунд наблюдения. Не меняйте сцену/режим, оставьте окно видимым. Отчёт без содержимого проекта.">
      {running?"Тест идёт · отменить":"Тест CPU · 15 с"}
    </button>
    {message&&<span role="status">{message}</span>}
    {report&&<div className="dialog-backdrop">
      <div className="overlay-dialog performance-dialog" role="dialog" aria-modal="true" aria-label="Отчёт производительности" onKeyDown={event=>{event.stopPropagation();if(event.key==="Escape")setReport("");}}>
        <header className="dialog-head"><h3>Отчёт производительности</h3><button autoFocus onClick={()=>setReport("")}>Закрыть</button></header>
        <div className="dialog-body">
          <p>Скопируйте отчёт и приложите CPU из диспетчера задач. Для сравнения повторите тест в работе, на паузе и на стопе. Во время каждого замера оставляйте окно видимым и не меняйте сцену.</p>
          <textarea ref={text} aria-label="Текст отчёта" readOnly value={report} onFocus={event=>event.target.select()} />
          <button onClick={()=>{void navigator.clipboard?.writeText(report).then(()=>setMessage("Отчёт скопирован"),()=>{text.current?.focus();text.current?.select();setMessage("Нажмите Ctrl+C, чтобы скопировать выделенный отчёт");});if(!navigator.clipboard){text.current?.focus();text.current?.select();setMessage("Нажмите Ctrl+C");}}}>Копировать отчёт</button>
          <p role="status">{message}</p>
        </div>
      </div>
    </div>}
  </>;
}
