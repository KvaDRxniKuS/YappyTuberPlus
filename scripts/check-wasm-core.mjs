// Validate the artifact itself, not a filename or build stamp. This also runs
// when Cargo is unavailable, so npm build cannot silently ship an older core.
import {readFileSync} from "node:fs";
const expected=Number(/CORE_GENERATION:\s*u32\s*=\s*(\d+)/.exec(readFileSync(new URL("../crates/rig-core/src/lib.rs",import.meta.url),"utf8"))?.[1]);
try{
 const {instance}=await WebAssembly.instantiate(readFileSync(new URL("../public/rig_core.wasm",import.meta.url)),{});
 const {rig_alloc,rig_free,rig_call,memory}=instance.exports;
 const call=request=>{
  const data=new TextEncoder().encode(JSON.stringify(request)),pointer=rig_alloc(data.length);
  new Uint8Array(memory.buffer,pointer,data.length).set(data);
  const packed=rig_call(pointer,data.length);rig_free(pointer,data.length);
  const out=Number(packed&0xffffffffn),length=Number(packed>>32n);
  const text=new TextDecoder().decode(new Uint8Array(memory.buffer,out,length));rig_free(out,length);return JSON.parse(text);
 };
 const version=call({op:"version"});
 if(!Number.isFinite(expected)||!version.ok||version.core!==expected)throw new Error(`WASM core ${version.core??"unknown"}, требуется ${expected}. Пересоберите Rust/WASM, старый артефакт использовать нельзя.`);
 const created=call({op:"create",config:{canvas:{width:100,height:100},globals:"",objects:[{id:"probe",kind:"sprite",width:100,height:100,script:"states_art_w0_0 = mouse.x * 2",watch:["states_art_w0_0"]}]}});
 if(!created.ok)throw new Error("WASM vertex-only probe: create failed");
 const tick=call({op:"tick",handle:created.handle,now:.016,inputs:{values:{"mouse.x":.25},signals:{}},paused:false,resetClock:true});
 if(!tick.ok||tick.frame?.vars?.probe?.states_art_w0_0!==.5)throw new Error("WASM не вычисляет watched vertex-only weights");
 console.log(`WASM core ${expected}: версия и vertex-only watch проверены`);
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exit(1);}
