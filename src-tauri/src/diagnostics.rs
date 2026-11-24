//! On-demand process-tree sampling. No shell, elevated rights, paths or command lines.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static CALLS: AtomicU64 = AtomicU64::new(0);
static CALL_NS: AtomicU64 = AtomicU64::new(0);
static EMITS: AtomicU64 = AtomicU64::new(0);
static EMIT_NS: AtomicU64 = AtomicU64::new(0);
static RESPONSE_BYTES: AtomicU64 = AtomicU64::new(0);
pub fn record_call(start: Instant) {
    CALL_NS.fetch_add(start.elapsed().as_nanos().min(u64::MAX as u128) as u64, Ordering::Relaxed);
    CALLS.fetch_add(1, Ordering::Relaxed);
}
pub fn record_emit(start: Instant, bytes: usize) {
    EMIT_NS.fetch_add(start.elapsed().as_nanos().min(u64::MAX as u128) as u64, Ordering::Relaxed);
    EMITS.fetch_add(1, Ordering::Relaxed);
    RESPONSE_BYTES.fetch_add(bytes as u64, Ordering::Relaxed);
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pid: u32,
    parent_pid: u32,
    name: String,
    identity: String,
    cpu_seconds: Option<f64>,
    resident_bytes: Option<u64>,
    private_bytes: Option<u64>,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    root_pid: u32,
    logical_cores: usize,
    platform: &'static str,
    processes: Vec<ProcessSample>,
    calls: u64,
    call_ms: f64,
    emits: u64,
    emit_ms: f64,
    response_bytes: u64,
    probe_ms: f64,
}

fn descendants(rows: &[(u32,u32,String)], root: u32) -> std::collections::HashSet<u32> {
    let mut selected=std::collections::HashSet::from([root]);
    loop {
        let before=selected.len();
        for (pid,parent,_) in rows {if selected.contains(parent) {selected.insert(*pid);}}
        if before==selected.len() {return selected;}
    }
}

#[tauri::command]
pub async fn performance_snapshot() -> Result<Snapshot,String> {
    tauri::async_runtime::spawn_blocking(|| {
        let start=Instant::now();
        let root=std::process::id();
        let processes=platform::sample(root)?;
        Ok(Snapshot {
            root_pid:root,logical_cores:std::thread::available_parallelism().map(|n|n.get()).unwrap_or(1),
            platform:std::env::consts::OS,processes,
            calls:CALLS.load(Ordering::Relaxed),call_ms:CALL_NS.load(Ordering::Relaxed) as f64 / 1e6,
            emits:EMITS.load(Ordering::Relaxed),emit_ms:EMIT_NS.load(Ordering::Relaxed) as f64 / 1e6,
            response_bytes:RESPONSE_BYTES.load(Ordering::Relaxed),probe_ms:start.elapsed().as_secs_f64()*1000.0,
        })
    }).await.map_err(|e|e.to_string())?
}

#[cfg(target_os="windows")]
mod platform {
    use super::*;
    use std::ffi::c_void;
    type Handle=*mut c_void;
    #[repr(C)]
    struct Entry {size:u32,usage:u32,pid:u32,heap:usize,module:u32,threads:u32,parent:u32,priority:i32,flags:u32,name:[u16;260]}
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {low:u32,high:u32}
    #[repr(C)]
    #[derive(Default)]
    struct Memory {size:u32,faults:u32,peak_working:usize,working:usize,peak_paged:usize,paged:usize,peak_nonpaged:usize,nonpaged:usize,pagefile:usize,peak_pagefile:usize,private:usize}
    #[link(name="kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags:u32,pid:u32)->Handle;
        fn Process32FirstW(handle:Handle,entry:*mut Entry)->i32;
        fn Process32NextW(handle:Handle,entry:*mut Entry)->i32;
        fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;
        fn CloseHandle(handle:Handle)->i32;
        fn GetProcessTimes(handle:Handle,created:*mut FileTime,exit:*mut FileTime,kernel:*mut FileTime,user:*mut FileTime)->i32;
    }
    #[link(name="psapi")]
    extern "system" {fn GetProcessMemoryInfo(handle:Handle,memory:*mut Memory,size:u32)->i32;}
    struct Owned(Handle);
    impl Drop for Owned {fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
    fn ticks(time:&FileTime)->u64 {(time.high as u64)<<32|time.low as u64}
    pub fn sample(root:u32)->Result<Vec<ProcessSample>,String> {
        // Toolhelp enumerates PIDs, PPIDs and executable basenames only.
        let handle=unsafe{CreateToolhelp32Snapshot(2,0)};
        if handle as isize == -1 {return Err(format!("process enumeration: {}",std::io::Error::last_os_error()));}
        let handle=Owned(handle);
        let mut entry:Entry=unsafe{std::mem::zeroed()};entry.size=std::mem::size_of::<Entry>() as u32;
        let mut rows=Vec::new();
        let mut ok=unsafe{Process32FirstW(handle.0,&mut entry)};
        if ok==0 {return Err(format!("process enumeration: {}",std::io::Error::last_os_error()));}
        while ok!=0 {
            let len=entry.name.iter().position(|&x|x==0).unwrap_or(260);
            rows.push((entry.pid,entry.parent,String::from_utf16_lossy(&entry.name[..len])));
            ok=unsafe{Process32NextW(handle.0,&mut entry)};
        }
        let selected=descendants(&rows,root);
        Ok(rows.into_iter().filter(|r|selected.contains(&r.0)).map(|(pid,parent,name)| {
            let mut row=ProcessSample {pid,parent_pid:parent,name,identity:format!("{pid}:unknown"),cpu_seconds:None,resident_bytes:None,private_bytes:None,error:None};
            // QUERY_INFORMATION | VM_READ; fall back to limited query for CPU.
            let mut h=unsafe{OpenProcess(0x410,0,pid)};
            if h.is_null(){h=unsafe{OpenProcess(0x1000,0,pid)};}
            if h.is_null(){row.error=Some("process exited or access denied".into());return row;}
            let h=Owned(h);
            let (mut created,mut exit,mut kernel,mut user)=(FileTime::default(),FileTime::default(),FileTime::default(),FileTime::default());
            if unsafe{GetProcessTimes(h.0,&mut created,&mut exit,&mut kernel,&mut user)}!=0 {
                row.identity=format!("{pid}:{}",ticks(&created));
                row.cpu_seconds=Some((ticks(&kernel)+ticks(&user)) as f64/1e7);
            } else {row.error=Some("CPU times unavailable".into());}
            let mut mem=Memory::default();mem.size=std::mem::size_of::<Memory>() as u32;
            let size=mem.size;
            if unsafe{GetProcessMemoryInfo(h.0,&mut mem,size)}!=0 {
                row.resident_bytes=Some(mem.working as u64);row.private_bytes=Some(mem.private as u64);
            } else {row.error=Some("memory unavailable (CPU may still be available)".into());}
            row
        }).collect())
    }
}

#[cfg(target_os="linux")]
mod platform {
    use super::*;
    extern "C" {fn sysconf(name:std::os::raw::c_int)->std::os::raw::c_long;}
    pub fn sample(root:u32)->Result<Vec<ProcessSample>,String> {
        let hz=unsafe{sysconf(2)}; // Linux _SC_CLK_TCK
        let page=unsafe{sysconf(30)}; // Linux _SC_PAGESIZE
        if hz<=0||page<=0 {return Err("sysconf unavailable".into());}
        let mut rows=Vec::new();let mut data=std::collections::HashMap::new();
        for entry in std::fs::read_dir("/proc").map_err(|e|e.to_string())?.flatten() {
            let Some(pid)=entry.file_name().to_str().and_then(|s|s.parse::<u32>().ok()) else {continue};
            let Ok(stat)=std::fs::read_to_string(entry.path().join("stat")) else {continue};
            let Some(end)=stat.rfind(')') else {continue};
            let Some(begin)=stat.find('(') else {continue};
            let fields:Vec<&str>=stat[end+1..].split_whitespace().collect();
            if fields.len()<22 {continue;}
            let val=|n:usize| fields[n].parse::<u64>().ok();
            let (Some(parent),Some(user),Some(kernel),Some(created),Some(rss))=(val(1),val(11),val(12),val(19),val(21)) else {continue};
            let name=stat[begin+1..end].to_owned();rows.push((pid,parent as u32,name.clone()));
            data.insert(pid,ProcessSample{pid,parent_pid:parent as u32,name,identity:format!("{pid}:{created}"),cpu_seconds:Some((user+kernel) as f64/hz as f64),resident_bytes:Some(rss*page as u64),private_bytes:None,error:None});
        }
        let selected=descendants(&rows,root);
        Ok(data.into_iter().filter(|(pid,_)|selected.contains(pid)).map(|(_,row)|row).collect())
    }
}
#[cfg(not(any(target_os="windows",target_os="linux")))]
mod platform {use super::*;pub fn sample(_:u32)->Result<Vec<ProcessSample>,String>{Err("process counters not implemented on this OS".into())}}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn tree_excludes_unrelated() {
        let rows=vec![(1,0,String::new()),(2,1,String::new()),(3,2,String::new()),(4,9,String::new())];
        assert_eq!(descendants(&rows,1),std::collections::HashSet::from([1,2,3]));
    }
}
