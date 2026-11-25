//! Linux local-volume receipts. The directory is exclusively owned by the model
//! service. flock serializes reservations, cleanup and atomic publication across
//! processes. A zero-length file is a durable in-flight reservation.
use super::{Key, BYTE_LIMIT, ENTRY_LIMIT, ITEM_LIMIT, MISSING, PENDING, PENDING_TTL, READY_TTL};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
    fn geteuid() -> u32;
}

struct Volume {
    path: PathBuf,
    dir: File, // Holds the exclusive lock until dropped.
    count: usize,
    used_bytes: usize,
    ready: Vec<(SystemTime, PathBuf, usize)>,
}

impl Volume {
    fn open(path: &Path, now: SystemTime) -> io::Result<Self> {
        match DirBuilder::new().mode(0o700).create(path) {
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
            _ => {}
        }
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.uid() != unsafe { geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let dir = File::open(path)?;
        if unsafe { flock(dir.as_raw_fd(), 2) } != 0 {
            // LOCK_EX
            return Err(io::Error::last_os_error());
        }
        let mut volume = Self {
            path: path.to_owned(),
            dir,
            count: 0,
            used_bytes: 0,
            ready: Vec::new(),
        };
        for item in fs::read_dir(path)? {
            let item = item?;
            let name = item.file_name();
            let name = name.to_str().unwrap_or("");
            if name == "publishing" {
                fs::remove_file(item.path())?;
                continue;
            }
            let digest = name.strip_prefix("spent-").unwrap_or(name);
            let spent = digest != name;
            if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let meta = fs::symlink_metadata(item.path())?;
            if !meta.is_file()
                || meta.nlink() != 1
                || meta.mode() & 0o077 != 0
                || meta.uid() != unsafe { geteuid() }
                || meta.len() > ITEM_LIMIT as u64
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let pending = meta.len() == 0 && !spent;
            let ttl = if pending { PENDING_TTL } else { READY_TTL };
            if now.duration_since(meta.modified()?).unwrap_or_default() >= ttl {
                fs::remove_file(item.path())?;
            } else {
                volume.count += 1;
                if spent && meta.len() > 0 {
                    // A crash between rename and truncate leaves a complete
                    // file here. Reclaim it before admitting another write.
                    File::options().write(true).open(item.path())?.set_len(0)?;
                } else if !pending && !spent {
                    volume.used_bytes += meta.len() as usize;
                    volume
                        .ready
                        .push((meta.modified()?, item.path(), meta.len() as usize));
                }
            }
        }
        Ok(volume)
    }

    fn file(&self, key: &Key) -> PathBuf {
        self.path
            .join(key.iter().map(|b| format!("{b:02x}")).collect::<String>())
    }

    fn reserve(&self, key: &Key) -> io::Result<i32> {
        let path = self.file(key);
        if path.try_exists()? || spent_path(&path).try_exists()? {
            return Ok(0);
        }
        if self.count >= ENTRY_LIMIT {
            return Ok(-1);
        }
        new_file(&path)?.sync_all()?;
        self.dir.sync_all()?;
        Ok(1)
    }

    fn finish(&mut self, key: &Key, payload: &[u8], byte_limit: usize) -> io::Result<()> {
        let path = self.file(key);
        if payload.is_empty()
            || payload.len() > ITEM_LIMIT.min(byte_limit)
            || path.metadata()?.len() != 0
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.ready.sort_unstable_by_key(|e| std::cmp::Reverse(e.0));
        while self.used_bytes > byte_limit - payload.len() {
            let (_, oldest, size) = self.ready.pop().ok_or(io::ErrorKind::InvalidData)?;
            let spent = spent_path(&oldest);
            fs::rename(&oldest, &spent)?;
            File::options().write(true).open(spent)?.set_len(0)?;
            self.used_bytes -= size;
        }
        let tmp = self.path.join("publishing");
        let mut f = new_file(&tmp)?;
        f.write_all(payload)?;
        f.sync_all()?;
        fs::rename(tmp, path)?;
        self.dir.sync_all()
    }

    fn forget_pending(&self, key: &Key) -> io::Result<()> {
        let path = self.file(key);
        let file = File::open(&path)?;
        if file.metadata()?.len() == 0 {
            // The provider may have consumed the full request deadline. Start the
            // duplicate guard at the failure, not at the original reservation.
            file.set_modified(SystemTime::now())?;
            file.sync_all()?;
            fs::rename(&path, spent_path(&path))?;
            self.dir.sync_all()?;
        }
        Ok(())
    }

    fn read(&self, key: &Key, out: Option<&mut [u8]>) -> io::Result<isize> {
        let mut f = File::open(self.file(key))?;
        let size = f.metadata()?.len() as usize;
        if size == 0 {
            return Ok(PENDING);
        }
        if let Some(buf) = out {
            if buf.len() != size {
                return Ok(MISSING);
            }
            f.read_exact(buf)?;
        }
        Ok(size as isize)
    }
}

fn spent_path(path: &Path) -> PathBuf {
    path.with_file_name(format!(
        "spent-{}",
        path.file_name().unwrap().to_string_lossy()
    ))
}

fn new_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
}

pub fn sweep(path: &Path) -> bool {
    Volume::open(path, SystemTime::now()).is_ok()
}
pub fn reserve(path: &Path, key: &Key) -> i32 {
    Volume::open(path, SystemTime::now())
        .and_then(|v| v.reserve(key))
        .unwrap_or(-1)
}
pub fn finish(path: &Path, key: &Key, data: &[u8]) -> i32 {
    Volume::open(path, SystemTime::now())
        .and_then(|mut v| v.finish(key, data, BYTE_LIMIT))
        .is_ok() as i32
}
pub fn forget(path: &Path, key: &Key) {
    let _ = Volume::open(path, SystemTime::now()).and_then(|v| v.forget_pending(key));
}
pub fn read(path: &Path, key: &Key, out: Option<&mut [u8]>) -> isize {
    Volume::open(path, SystemTime::now())
        .and_then(|v| v.read(key, out))
        .unwrap_or(MISSING)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_limits_permissions_expiry_and_interrupted_publish() {
        let now = SystemTime::now();
        let dir = std::env::temp_dir().join(format!(
            "df-native-receipt-{}-{:?}",
            std::process::id(),
            now.duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let open = || Volume::open(&dir, now).unwrap();
        for id in 0..ENTRY_LIMIT {
            assert_eq!(open().reserve(&[id as u8; 32]).unwrap(), 1);
        }
        assert_eq!(open().reserve(&[245; 32]).unwrap(), -1);
        assert_eq!(open().reserve(&[0; 32]).unwrap(), 0);
        let k1 = [0; 32];
        let k2 = [1; 32];
        open().finish(&k1, b"first", 8).unwrap();
        open().finish(&k2, b"second", 8).unwrap();
        assert_eq!(open().reserve(&k1).unwrap(), 0);
        assert!(open().read(&k1, None).is_err());
        assert_eq!(open().used_bytes, 6);
        assert!(open().finish(&[2; 32], b"oversized", 8).is_err());
        let mut data = [0; 6];
        open().read(&k2, Some(&mut data)).unwrap();
        assert_eq!(&data, b"second");
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(open().file(&k2).metadata().unwrap().mode() & 0o777, 0o600);
        new_file(&dir.join("publishing"))
            .unwrap()
            .write_all(b"incomplete")
            .unwrap();
        assert_eq!(open().read(&[2; 32], None).unwrap(), PENDING);
        assert!(!dir.join("publishing").exists());
        assert_eq!(
            Volume::open(&dir, SystemTime::now() + READY_TTL)
                .unwrap()
                .count,
            ENTRY_LIMIT - 2
        );
        assert_eq!(
            Volume::open(&dir, SystemTime::now() + PENDING_TTL)
                .unwrap()
                .count,
            0
        );
        let slow = [199; 32];
        assert_eq!(open().reserve(&slow).unwrap(), 1);
        File::open(open().file(&slow))
            .unwrap()
            .set_modified(now - READY_TTL - std::time::Duration::from_secs(1))
            .unwrap();
        open().forget_pending(&slow).unwrap();
        assert!(open().read(&slow, None).is_err());
        assert_eq!(open().reserve(&slow).unwrap(), 0);
        assert_eq!(
            Volume::open(&dir, SystemTime::now() + READY_TTL)
                .unwrap()
                .count,
            0
        );
        fs::remove_dir(dir).unwrap();
    }
}
