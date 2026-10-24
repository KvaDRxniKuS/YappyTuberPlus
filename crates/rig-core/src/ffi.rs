use crate::RuntimeStore;
use std::cell::RefCell;

thread_local! {
    static STORE: RefCell<RuntimeStore> = RefCell::new(RuntimeStore::default());
}

#[no_mangle]
pub extern "C" fn rig_alloc(length: usize) -> *mut u8 {
    let mut buffer = vec![0u8; length.max(1)].into_boxed_slice();
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// The pointer must come from `rig_alloc` or `rig_call`, with its original length.
#[no_mangle]
pub unsafe extern "C" fn rig_free(pointer: *mut u8, length: usize) {
    if !pointer.is_null() {
        let slice = std::ptr::slice_from_raw_parts_mut(pointer, length.max(1));
        drop(Box::from_raw(slice));
    }
}

#[no_mangle]
pub extern "C" fn rig_call(pointer: *const u8, length: usize) -> u64 {
    let response = if pointer.is_null() {
        "{\"ok\":false,\"error\":\"null input\"}".to_string()
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(pointer, length) };
        match std::str::from_utf8(bytes) {
            Ok(source) => STORE.with(|store| store.borrow_mut().call_json(source)),
            Err(_) => "{\"ok\":false,\"error\":\"input is not UTF-8\"}".to_string(),
        }
    };
    let mut bytes = response.into_bytes().into_boxed_slice();
    let pointer = bytes.as_mut_ptr();
    let length = bytes.len();
    std::mem::forget(bytes);
    ((length as u64) << 32) | (pointer as u32 as u64)
}
