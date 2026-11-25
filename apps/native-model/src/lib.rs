//! Short-lived result receipts in memory or on a private Linux volume. The caller hashes
//! the Studio request ID and its private per-attempt capability into a 32-byte key.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const ITEM_LIMIT: usize = 48 * 1024 * 1024;
const BYTE_LIMIT: usize = 96 * 1024 * 1024;
const ENTRY_LIMIT: usize = 128;
const READY_TTL: Duration = Duration::from_secs(180);
const PENDING_TTL: Duration = Duration::from_secs(30 * 60);
const MISSING: isize = -1;
const PENDING: isize = -2;
type Key = [u8; 32];

#[cfg(target_os = "linux")]
mod disk;

#[cfg(target_os = "linux")]
fn volume() -> Option<&'static std::path::Path> {
    static PATH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = std::env::var_os("DEEPFLARE_IMAGE_RECEIPT_DIR").map(std::path::PathBuf::from)?;
        let cleanup = path.clone();
        std::thread::spawn(move || loop {
            disk::sweep(&cleanup);
            std::thread::sleep(Duration::from_secs(30));
        });
        Some(path)
    })
    .as_deref()
}

struct Entry {
    until: Instant,
    result: Option<Vec<u8>>,
    spent: bool,
}

#[derive(Default)]
struct Store {
    entries: HashMap<Key, Entry>,
}

impl Store {
    fn expire(&mut self, now: Instant) {
        self.entries.retain(|_, entry| entry.until > now);
    }

    fn evict_oldest_result(&mut self) -> bool {
        let oldest = self
            .entries
            .iter()
            .filter(|(_, e)| e.result.is_some())
            .min_by_key(|(_, e)| e.until)
            .map(|(key, _)| *key);
        oldest.is_some_and(|key| self.entries.remove(&key).is_some())
    }

    fn reserve(&mut self, key: Key, now: Instant) -> i32 {
        self.expire(now);
        if self.entries.contains_key(&key) {
            return 0;
        }
        if self.entries.len() >= ENTRY_LIMIT && !self.evict_oldest_result() {
            return -1;
        }
        self.entries.insert(
            key,
            Entry {
                until: now + PENDING_TTL,
                result: None,
                spent: false,
            },
        );
        1
    }

    fn finish(&mut self, key: Key, data: &[u8], now: Instant, byte_limit: usize) -> bool {
        self.expire(now);
        if !self
            .entries
            .get(&key)
            .is_some_and(|e| !e.spent && e.result.is_none())
        {
            return false;
        }
        if data.is_empty() || data.len() > ITEM_LIMIT || data.len() > byte_limit {
            self.entries.get_mut(&key).unwrap().spent = true;
            return false;
        }
        let used = |s: &Self| {
            s.entries
                .values()
                .filter_map(|e| e.result.as_ref())
                .map(Vec::len)
                .sum::<usize>()
        };
        while used(self) > byte_limit - data.len() {
            if !self.evict_oldest_result() {
                return false;
            }
        }
        self.entries.insert(
            key,
            Entry {
                until: now + READY_TTL,
                result: Some(data.to_vec()),
                spent: false,
            },
        );
        true
    }
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            if let Ok(mut cache) = store().lock() {
                cache.expire(Instant::now());
            }
        });
        Mutex::new(Store::default())
    })
}

#[no_mangle]
pub extern "C" fn receipt_volume_ready() -> i32 {
    #[cfg(target_os = "linux")]
    if let Some(path) = volume() {
        return disk::sweep(path) as i32;
    }
    std::env::var_os("DEEPFLARE_IMAGE_RECEIPT_DIR").is_none() as i32
}

// Called only through the server-owned ctypes adapter. Every key points to
// exactly 32 readable bytes. Data and output buffers remain owned by the caller.
#[no_mangle]
pub unsafe extern "C" fn receipt_reserve(key: *const Key) -> i32 {
    if key.is_null() {
        return -1;
    }
    #[cfg(target_os = "linux")]
    if let Some(path) = volume() {
        return disk::reserve(path, &*key);
    }
    store()
        .lock()
        .map_or(-1, |mut cache| cache.reserve(*key, Instant::now()))
}

#[no_mangle]
pub unsafe extern "C" fn receipt_finish(key: *const Key, data: *const u8, len: usize) -> i32 {
    if key.is_null() || data.is_null() || len > ITEM_LIMIT {
        return 0;
    }
    #[cfg(target_os = "linux")]
    if let Some(path) = volume() {
        return disk::finish(path, &*key, std::slice::from_raw_parts(data, len));
    }
    store().lock().map_or(0, |mut cache| {
        cache.finish(
            *key,
            std::slice::from_raw_parts(data, len),
            Instant::now(),
            BYTE_LIMIT,
        ) as i32
    })
}

#[no_mangle]
pub unsafe extern "C" fn receipt_forget(key: *const Key) {
    // An interrupted provider call may already have been charged. Keep its
    // duplicate guard until expiry even when its result cannot be recovered.
    #[cfg(target_os = "linux")]
    if let Some(path) = volume() {
        if !key.is_null() {
            disk::forget(path, &*key);
        }
        return;
    }
    if !key.is_null() {
        if let Ok(mut cache) = store().lock() {
            if let Some(entry) = cache.entries.get_mut(&*key) {
                if entry.result.is_none() {
                    entry.spent = true;
                }
            }
        }
    }
}

// A null output asks for the length. A second call copies only on an exact
// match. Eviction or expiration between calls yields MISSING.
#[no_mangle]
pub unsafe extern "C" fn receipt_read(key: *const Key, out: *mut u8, capacity: usize) -> isize {
    if key.is_null() {
        return MISSING;
    }
    #[cfg(target_os = "linux")]
    if let Some(path) = volume() {
        let buf = if out.is_null() {
            None
        } else if capacity > ITEM_LIMIT {
            return MISSING;
        } else {
            Some(std::slice::from_raw_parts_mut(out, capacity))
        };
        return disk::read(path, &*key, buf);
    }
    let Ok(mut cache) = store().lock() else {
        return MISSING;
    };
    cache.expire(Instant::now());
    match cache.entries.get(&*key) {
        None => MISSING,
        Some(Entry { spent: true, .. }) => MISSING,
        Some(Entry { result: None, .. }) => PENDING,
        Some(Entry {
            result: Some(bytes),
            ..
        }) => {
            if !out.is_null() {
                if capacity != bytes.len() {
                    return MISSING;
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
            }
            bytes.len() as isize
        }
    }
}

#[cfg(target_os = "linux")]
pub enum VolumeReceipt {
    Missing,
    Pending,
    Ready(Vec<u8>),
}

#[cfg(target_os = "linux")]
pub fn read_volume_receipt(directory: &std::path::Path, key: &[u8; 32]) -> VolumeReceipt {
    let size = disk::read(directory, key, None);
    if size == PENDING {
        return VolumeReceipt::Pending;
    }
    if size <= 0 || size as usize > ITEM_LIMIT {
        return VolumeReceipt::Missing;
    }
    let mut data = vec![0; size as usize];
    if disk::read(directory, key, Some(&mut data)) == size {
        VolumeReceipt::Ready(data)
    } else {
        VolumeReceipt::Missing
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_expiry_and_capacity() {
        let mut s = Store::default();
        let t = Instant::now();
        for id in 0..ENTRY_LIMIT {
            assert_eq!(s.reserve([id as u8; 32], t), 1);
        }
        assert_eq!(s.reserve([1; 32], t), 0);
        assert_eq!(s.reserve([200; 32], t), -1);
        assert!(s.finish([1; 32], b"first", t, 8));
        assert!(s.finish([2; 32], b"second", t, 8));
        assert!(!s.entries.contains_key(&[1; 32]));
        assert!(!s.finish([2; 32], b"replace", t, 8));
        s.expire(t + READY_TTL);
        assert!(!s.entries.contains_key(&[2; 32]));
        assert!(s.entries.contains_key(&[3; 32]));
        s.expire(t + PENDING_TTL);
        assert!(s.entries.is_empty());
    }
}
