import {test,expect} from "@playwright/test";
import {TauriEventBus,CompositeBus,WebSocketBus,type OverlayBus} from "../../src/overlay/bus";
import type {WireMessage} from "../../src/overlay/protocol";
const frame=(seq:number)=>({t:"frame",sender:"host",sceneVersion:1,frame:{seq}} as WireMessage);
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test("Tauri keeps one in-flight and only the latest waiting frame",async()=>{
  const sent:WireMessage[]=[];let release=()=>{};
  const bus=new TauriEventBus((_event,message)=>{sent.push(message);return new Promise<void>(resolve=>{release=resolve;});});
  bus.post(frame(1));for(let i=2;i<=1000;i++)bus.post(frame(i));
  expect(sent).toHaveLength(1);release();await flush();
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(frame(1000));
  bus.post(frame(1001));bus.close();release();await flush();
  expect(sent).toHaveLength(2);
});
test("Tauri recovers after rejection and discards obsolete queued scene",async()=>{
  const sent:WireMessage[]=[];let reject=()=>{};
  const bus=new TauriEventBus((_event,message)=>{sent.push(message);if(message.t!=="frame")return;return new Promise<void>((_resolve,no)=>{reject=()=>no(new Error("offline"));});});
  bus.post(frame(1));bus.post(frame(2));
  // A scene replacement invalidates waiting poses, not the control message.
  bus.post({t:"scene",sender:"host",scene:{version:2}} as WireMessage);
  reject();await flush();expect(sent).toHaveLength(2);
  bus.post(frame(3));expect(sent).toHaveLength(3);bus.close();reject();await flush();
});
test("Composite subscriptions can be removed independently",()=>{
  const listeners=new Set<(message:WireMessage,source:"broadcast")=>void>();
  const part:OverlayBus={kind:"broadcast",label:"test",ready:true,post(){},close(){listeners.clear();},
    subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};}};
  const bus=new CompositeBus([part]);let a=0,b=0;
  const offA=bus.subscribe(()=>a++);bus.subscribe(()=>b++);
  offA();for(const listener of listeners)listener(frame(1),"broadcast");
  expect(a).toBe(0);expect(b).toBe(1);bus.close();expect(listeners.size).toBe(0);
});
test("WebSocket writable send supersedes old pending frame",async()=>{
  const sent:string[]=[];
  const socket={bufferedAmount:0,send(text:string){sent.push(text);},close(){},onopen:()=>{}};
  const bus=new WebSocketBus("ws://test",()=>socket as unknown as WebSocket);
  socket.onopen();socket.bufferedAmount=300000;bus.post(frame(1));
  socket.bufferedAmount=0;bus.post(frame(2));
  await new Promise(resolve=>setTimeout(resolve,90));
  expect(sent.map(s=>JSON.parse(s).frame.seq)).toEqual([2]);bus.close();
  bus.post(frame(3));expect(sent).toHaveLength(1);
});
test("Tauri rejection still sends the latest waiting frame",async()=>{
  const sent:WireMessage[]=[];const rejectors:Array<()=>void>=[];
  const bus=new TauriEventBus((_event,message)=>{sent.push(message);return new Promise<void>((_ok,no)=>rejectors.push(()=>no(new Error("failed"))));});
  bus.post(frame(1));bus.post(frame(2));bus.post(frame(3));
  rejectors[0]();await flush();expect(sent).toEqual([frame(1),frame(3)]);
  bus.close();rejectors[1]();await flush();
});
