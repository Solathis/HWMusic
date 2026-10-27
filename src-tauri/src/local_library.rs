//! 本地曲库：选文件、读元数据、存索引、按 id 提供音频/封面/歌词。
//!
//! 路径只存在这里：渲染层与 sidecar 只见到 128 位随机十六进制 id，协议只按 id 查索引。
//! 格式白名单在导入时就拦：WebView2 放不出来的格式导进来只会变成"点了没反应"。

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview};

use crate::bridge::CoreError;
use crate::commands::require_main_webview;
use crate::MAIN_WINDOW_LABEL;

/// 索引文件名（数据根下；与 `settings.json` 平级但**分开**：一份是会漂的库，一份是用户的配置）。
pub const LIBRARY_FILE_NAME: &str = "local-library.json";

/// 自定义 URI 协议的 scheme（渲染层 `src/shared/local-track.ts` 的 `LOCAL_MEDIA_SCHEME` 是镜像）。
pub const PROTOCOL_SCHEME: &str = "hwlocal";

/// 能导入的格式（与 `src/shared/local-track.ts` 的 `LOCAL_AUDIO_FORMATS` 同源）。
pub const SUPPORTED_FORMATS: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav"];

/// 歌词来源的字节上限（与 sidecar 的 `LYRICS_SOURCE_MAX_BYTES` 同一口径）。
pub const LYRICS_SOURCE_MAX_BYTES: u64 = 512 * 1024;

/// 文件夹导入的深度上限（含起点那一层）。
pub const MAX_FOLDER_DEPTH: u32 = 3;

/// 文件夹导入的文件数上限。
pub const MAX_FOLDER_FILES: usize = 2000;

/// id 的十六进制长度（128 位）。
pub const TRACK_ID_LEN: usize = 32;

// ---------------------------------------------------------------------------
// 纯函数（协议、路径、Range、来源守卫）——不碰磁盘，所以能整片单测
// ---------------------------------------------------------------------------

/// 扩展名 → 白名单里的规范写法（认不出就 `None`）。
pub fn supported_format(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    SUPPORTED_FORMATS.iter().copied().find(|known| *known == extension)
}

/// 拒绝导入时的理由（说清"是哪种格式、只支持哪些"，别只说"不支持"）。
pub fn rejection_reason(path: &Path) -> String {
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if extension.is_empty() {
        return format!(
            "没有扩展名，认不出是什么音频（只支持 {}）",
            SUPPORTED_FORMATS.join("/")
        );
    }
    format!(
        "格式 .{extension} 无法在播放器里播放（只支持 {}）",
        SUPPORTED_FORMATS.join("/")
    )
}

/// 文件名的展示形态（拒绝回执里用它，不带目录——用户认的是文件名）。
pub fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 造一个不可猜的曲目 id：16 字节系统随机数 → 32 位小写十六进制。
pub fn new_track_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // 随机源不可用是"这台机器出问题了"，不能悄悄降级成可预测的 id；用时间戳兜底只为不 panic，并记进日志。
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        log::error!("系统随机源不可用，曲目 id 退化为时间戳（这一次的 id 可猜）");
        bytes[..16.min(16)].copy_from_slice(&nanos.to_le_bytes()[..16.min(16)]);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// id 形状校验（32 位小写十六进制）。
pub fn is_track_id(value: &str) -> bool {
    value.len() == TRACK_ID_LEN && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 协议路径里的那两种形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolRequest {
    /// `/<id>`：音频文件（支持 Range）
    Audio(String),
    /// `/<id>/cover`：内嵌封面
    Cover(String),
}

/// 解析协议路径，只认 `/{id}` 与 `/{id}/cover` 两种形状，别的一律 `None`（对外是 404）。
pub fn parse_protocol_path(path: &str) -> Option<ProtocolRequest> {
    let trimmed = path.strip_prefix('/')?;
    if trimmed.is_empty() || trimmed.ends_with('/') {
        return None;
    }
    let mut parts = trimmed.split('/');
    let id = parts.next()?;
    if !is_track_id(id) {
        return None;
    }
    match parts.next() {
        None => Some(ProtocolRequest::Audio(id.to_string())),
        Some("cover") if parts.next().is_none() => Some(ProtocolRequest::Cover(id.to_string())),
        Some(_) => None,
    }
}

/// 来源 webview 守卫：只服务**主窗**；歌词窗（只渲染歌词，不取本地封面/音频）、内嵌的官方登录页
/// 与浮动控件一律拒绝。
pub fn source_allowed(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

/// Range 头的解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// 没有 Range（或认不出的 Range）：回整份 200
    Full,
    /// `bytes=start-end`（已夹进文件长度）
    Partial { start: u64, end: u64 },
    /// 起点越界：回 416
    Unsatisfiable,
}

/// 解析单区间 `Range` 头；看不懂的写法回 `Full`，猜区间会让播放器拖到某个位置就卡住。
pub fn parse_range(header: Option<&str>, length: u64) -> RangeOutcome {
    let Some(raw) = header else { return RangeOutcome::Full };
    let Some(spec) = raw.trim().strip_prefix("bytes=") else {
        return RangeOutcome::Full;
    };
    if spec.contains(',') {
        return RangeOutcome::Full;
    }
    let Some((start_text, end_text)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    let start_text = start_text.trim();
    let end_text = end_text.trim();

    if start_text.is_empty() {
        // 后缀区间（`bytes=-1024`）：取最后这么多字节
        let Ok(suffix) = end_text.parse::<u64>() else {
            return RangeOutcome::Full;
        };
        if suffix == 0 || length == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        let start = length.saturating_sub(suffix);
        return RangeOutcome::Partial { start, end: length - 1 };
    }

    let Ok(start) = start_text.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if length == 0 || start >= length {
        return RangeOutcome::Unsatisfiable;
    }
    let end = if end_text.is_empty() {
        length - 1
    } else {
        match end_text.parse::<u64>() {
            Ok(value) => value.min(length - 1),
            Err(_) => length - 1,
        }
    };
    if end < start {
        return RangeOutcome::Unsatisfiable;
    }
    RangeOutcome::Partial { start, end }
}

/// 宿主算给渲染层的协议基址（Windows 上 webview 只认 `http://<scheme>.localhost` 形态）。
pub fn protocol_base() -> &'static str {
    if cfg!(windows) {
        "http://hwlocal.localhost"
    } else {
        "hwlocal://localhost"
    }
}

/// 路径的去重键：Windows 上大小写不敏感（同一份文件换个大小写还是同一份）。
pub fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// 文件指纹里用的时间戳（毫秒；取不到算 0 = 未知）。
fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn size_of(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

/// 索引里的一条（**含路径**：只有这里存）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Track {
    pub id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artists: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    pub format: String,
    pub imported_at_ms: u64,
    pub size: u64,
    pub modified_at_ms: u64,
    pub has_cover: bool,
}

impl Track {
    /// 回给渲染层的那一面：**没有 path**（这就是"渲染层拿不到路径"的落点）。
    pub fn view(&self, available: bool) -> Value {
        let duration = self.duration_seconds.filter(|value| value.is_finite() && *value > 0.0);
        json!({
            "id": self.id,
            "title": self.title,
            "artists": self.artists,
            "album": self.album,
            "duration": duration,
            "format": self.format,
            "importedAt": self.imported_at_ms,
            "available": available,
            "hasCover": self.has_cover,
        })
    }

    /// 文件还在不在（只判"是不是一个存在的文件"，不判内容——内容变了那是另一件事）。
    pub fn available(&self) -> bool {
        Path::new(&self.path).is_file()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LibraryFile {
    version: u32,
    #[serde(default)]
    tracks: Vec<Track>,
}

/// 进程内的索引缓存：协议每次 Range 请求都要查一次 id，每次都读一遍 JSON 太傻。
struct Cache {
    root: PathBuf,
    tracks: Vec<Track>,
}

static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<Cache>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

fn lock_cache() -> std::sync::MutexGuard<'static, Option<Cache>> {
    cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 读索引（缓存优先）。坏文件按"空库"处理：一个手改坏的 JSON 不该让本地歌曲整块消失。
pub fn load_index(root: &Path) -> Vec<Track> {
    {
        let guard = lock_cache();
        if let Some(cached) = guard.as_ref() {
            if cached.root == root {
                return cached.tracks.clone();
            }
        }
    }
    let path = root.join(LIBRARY_FILE_NAME);
    let tracks: Vec<Track> = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LibraryFile>(&bytes).ok())
        .map(|file| {
            // 只留形状合法的记录：id 不对的条目永远匹配不到协议请求，留着只会是噪声
            file.tracks.into_iter().filter(|track| is_track_id(&track.id)).collect()
        })
        .unwrap_or_default();
    *lock_cache() = Some(Cache {
        root: root.to_path_buf(),
        tracks: tracks.clone(),
    });
    tracks
}

/// 原子写索引（临时文件 + rename）：写一半被杀进程只会留下一个临时文件，索引本身要么旧要么新。
pub fn save_index(root: &Path, tracks: &[Track]) -> Result<(), CoreError> {
    fs::create_dir_all(root).map_err(|source| {
        CoreError::new("internal", format!("本地曲库目录建不出来：{source}"))
    })?;
    let file = LibraryFile {
        version: 1,
        tracks: tracks.to_vec(),
    };
    let payload = serde_json::to_vec_pretty(&file)
        .map_err(|source| CoreError::new("internal", format!("本地曲库序列化失败：{source}")))?;
    let target = root.join(LIBRARY_FILE_NAME);
    let temporary = root.join(format!("{LIBRARY_FILE_NAME}.{}.tmp", std::process::id()));
    fs::write(&temporary, &payload).map_err(|source| {
        CoreError::new("internal", format!("本地曲库写不进去：{source}"))
    })?;
    if let Err(source) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(CoreError::new(
            "internal",
            format!("本地曲库替换失败：{source}"),
        ));
    }
    *lock_cache() = Some(Cache {
        root: root.to_path_buf(),
        tracks: tracks.to_vec(),
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

/// 一次读取拿到的元数据（读不到的就是 `None`，绝不编）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioMetadata {
    pub title: Option<String>,
    pub artists: Option<String>,
    pub album: Option<String>,
    pub duration_seconds: Option<f64>,
    pub has_cover: bool,
}

fn text_of(value: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 读一首音频的标签（lofty）。**任何失败都只影响元数据，不影响导入**：
/// 标签坏了的文件照样能播，用户要的是"能听"，不是"标签必须完美"。
pub fn read_audio(path: &Path) -> AudioMetadata {
    let tagged = match lofty::read_from_path(path) {
        Ok(tagged) => tagged,
        Err(_) => return AudioMetadata::default(),
    };
    let properties = tagged.properties();
    let duration = properties.duration().as_secs_f64();

    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let Some(tag) = tag else {
        return AudioMetadata {
            duration_seconds: (duration > 0.0).then_some(duration),
            ..AudioMetadata::default()
        };
    };

    AudioMetadata {
        title: text_of(tag.title()),
        artists: text_of(tag.artist()),
        album: text_of(tag.album()),
        duration_seconds: (duration > 0.0).then_some(duration),
        has_cover: !tag.pictures().is_empty(),
    }
}

/// 标题兜底：读不到标签就用文件名（去掉扩展名）——比"未知歌曲"有用得多。
pub fn display_title(path: &Path, metadata: &AudioMetadata) -> String {
    metadata
        .title
        .clone()
        .or_else(|| {
            path.file_stem()
                .map(|value| value.to_string_lossy().trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| file_name_of(path))
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/// 一条被拒绝的导入（回执里要能说清"哪个文件、为什么"）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RejectedImport {
    pub name: String,
    pub reason: String,
}

/// 一次导入的结论。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImportOutcome {
    pub added: usize,
    pub updated: usize,
    pub rejected: Vec<RejectedImport>,
    /// 文件夹里因为深度/数量上限被跳过的文件数
    pub truncated: usize,
}

/// 把用户选的东西摊平成候选文件列表（文件原样收下，目录递归但有上限）。
pub fn collect_candidates(paths: &[PathBuf]) -> (Vec<PathBuf>, Vec<RejectedImport>, usize) {
    let mut files = Vec::new();
    let mut rejected = Vec::new();
    let mut truncated = 0;

    for path in paths {
        if path.is_file() {
            files.push(path.clone());
            continue;
        }
        if !path.is_dir() {
            rejected.push(RejectedImport {
                name: file_name_of(path),
                reason: "文件或文件夹不存在".to_string(),
            });
            continue;
        }
        walk_folder(path, 0, &mut files, &mut truncated);
    }
    (files, rejected, truncated)
}

/// 有上限的递归遍历：深度 3 层、最多 2000 个文件。
fn walk_folder(dir: &Path, depth: u32, files: &mut Vec<PathBuf>, truncated: &mut usize) {
    if depth >= MAX_FOLDER_DEPTH {
        *truncated += 1;
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            *truncated += 1;
            return;
        }
    };
    let mut children: Vec<PathBuf> = entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()).collect();
    children.sort();
    for child in children {
        if files.len() >= MAX_FOLDER_FILES {
            *truncated += 1;
            return;
        }
        if child.is_dir() {
            walk_folder(&child, depth + 1, files, truncated);
        } else if supported_format(&child).is_some() {
            files.push(child);
        }
    }
}

/// 导入一批路径（不弹对话框，测试直接传路径）。
/// 同一路径键的旧记录只更新元数据并保留 id——id 变了，队列与歌词缓存里的引用就全断了。
pub fn import_paths(root: &Path, paths: &[PathBuf]) -> Result<(Vec<Track>, ImportOutcome), CoreError> {
    let mut tracks = load_index(root);
    let mut outcome = ImportOutcome::default();

    let (candidates, mut rejected, truncated) = collect_candidates(paths);
    outcome.rejected.append(&mut rejected);
    outcome.truncated = truncated;

    let mut index: BTreeMap<String, usize> = tracks
        .iter()
        .enumerate()
        .map(|(position, track)| (path_key(Path::new(&track.path)), position))
        .collect();

    for candidate in candidates {
        let Some(format) = supported_format(&candidate) else {
            outcome.rejected.push(RejectedImport {
                name: file_name_of(&candidate),
                reason: rejection_reason(&candidate),
            });
            continue;
        };
        let key = path_key(&candidate);
        let metadata = read_audio(&candidate);
        let title = display_title(&candidate, &metadata);
        let size = size_of(&candidate);
        let modified = modified_ms(&candidate);

        match index.get(&key).copied() {
            Some(position) => {
                let track = &mut tracks[position];
                track.title = Some(title);
                track.artists = metadata.artists.clone();
                track.album = metadata.album.clone();
                track.duration_seconds = metadata.duration_seconds;
                track.format = format.to_string();
                track.size = size;
                track.modified_at_ms = modified;
                track.has_cover = metadata.has_cover;
                outcome.updated += 1;
            }
            None => {
                let track = Track {
                    id: new_track_id(),
                    path: candidate.to_string_lossy().into_owned(),
                    title: Some(title),
                    artists: metadata.artists.clone(),
                    album: metadata.album.clone(),
                    duration_seconds: metadata.duration_seconds,
                    format: format.to_string(),
                    imported_at_ms: now_ms(),
                    size,
                    modified_at_ms: modified,
                    has_cover: metadata.has_cover,
                };
                index.insert(key, tracks.len());
                tracks.push(track);
                outcome.added += 1;
            }
        }
    }

    save_index(root, &tracks)?;
    Ok((tracks, outcome))
}

/// 从索引里移除一条（**不删文件**）。
pub fn remove_track(root: &Path, id: &str) -> Result<(Vec<Track>, bool), CoreError> {
    let mut tracks = load_index(root);
    let before = tracks.len();
    tracks.retain(|track| track.id != id);
    let removed = tracks.len() != before;
    if removed {
        save_index(root, &tracks)?;
    }
    Ok((tracks, removed))
}

/// 按 id 找曲目（协议与歌词两条路都走它）。
pub fn find_track(root: &Path, id: &str) -> Option<Track> {
    if !is_track_id(id) {
        return None;
    }
    load_index(root)
        .into_iter()
        .find(|track| track.id == id)
}

/// 渲染层给过来的曲目 id 可能是 `local:<hex>`（也可能只是 `<hex>`）：两种都认。
pub fn track_id_of_argument(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix("local:").unwrap_or(trimmed);
    is_track_id(hex).then(|| hex.to_string())
}

// ---------------------------------------------------------------------------
// 封面与歌词（按 id，不按路径）
// ---------------------------------------------------------------------------

/// 内嵌封面：`(字节, MIME)`。没有封面就 `None`（协议回 404，界面显示占位图）。
pub fn cover_bytes(path: &Path) -> Option<(Vec<u8>, String)> {
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let picture = tag.pictures().first()?;
    let mime = picture
        .mime_type()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    Some((picture.data().to_vec(), mime))
}

/// 歌词来源的标记（回执里带它，用户看得见这句词从哪来）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LyricsSourceKind {
    /// 同目录同名 `.lrc`
    Lrc,
    /// 同目录同名 `.txt`
    Txt,
    /// 内嵌歌词标签
    Embedded,
}

impl LyricsSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LyricsSourceKind::Lrc => "lrc",
            LyricsSourceKind::Txt => "txt",
            LyricsSourceKind::Embedded => "embedded",
        }
    }
}

/// 读一份歌词文件（超过上限就 `None`：宁可没有歌词，也不把一份 40 MB 的文本塞给渲染层）。
fn read_lyrics_file(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > LYRICS_SOURCE_MAX_BYTES {
        return None;
    }
    fs::read(path).ok().filter(|bytes| !bytes.is_empty())
}

/// 本地曲目的歌词字节：同名 `.lrc` → 同名 `.txt` → 内嵌歌词标签。
/// 外挂文件是用户自己放的、能改，所以优先于打包进文件的内嵌标签。
pub fn lyrics_bytes(path: &Path) -> Option<(Vec<u8>, LyricsSourceKind)> {
    for (extension, kind) in [("lrc", LyricsSourceKind::Lrc), ("txt", LyricsSourceKind::Txt)] {
        let candidate = path.with_extension(extension);
        if let Some(bytes) = read_lyrics_file(&candidate) {
            return Some((bytes, kind));
        }
    }

    let tagged = lofty::read_from_path(path).ok()?;
    // 遍历**所有**标签而不是只取 primary：一个文件里可能同时有 RIFF INFO 与 ID3v2，用户写的词常在后者里。
    // 两个 key 都要试：ID3v2 的 USLT 只映射成 `UnsyncLyrics`，`Lyrics` 在 ID3v2 里读不出来。
    let text = tagged
        .tags()
        .iter()
        .find_map(|tag| {
            tag.get_string(ItemKey::Lyrics)
                .or_else(|| tag.get_string(ItemKey::UnsyncLyrics))
        })
        .map(|value| value.trim().to_string())?;
    if text.is_empty() || text.len() as u64 > LYRICS_SOURCE_MAX_BYTES {
        return None;
    }
    Some((text.into_bytes(), LyricsSourceKind::Embedded))
}

/// 宿主侧取歌词（`host:local-lyrics-source` 的应答）：`{bytes, source, name?}`。
pub fn lyrics_payload(root: &Path, raw_id: &str) -> Result<Value, CoreError> {
    let Some(id) = track_id_of_argument(raw_id) else {
        return Err(CoreError::new(
            "invalid_payload",
            "宿主要求 host:local-lyrics-source 的 trackId 形状不对（要 32 位十六进制）",
        ));
    };
    let Some(track) = find_track(root, &id) else {
        // 没在库里 = 没导入过：这在宿主侧不该有第二份解释，但也不必当成错误
        return Ok(Value::Null);
    };
    let path = PathBuf::from(&track.path);
    let Some((bytes, kind)) = lyrics_bytes(&path) else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "bytes": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "source": kind.as_str(),
        "name": file_name_of(&path),
    }))
}

// ---------------------------------------------------------------------------
// 协议处理
// ---------------------------------------------------------------------------

/// 一次协议请求的处理结果（与 tauri 的 Response 解耦，便于单测）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolOutcome {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ProtocolOutcome {
    fn not_found() -> Self {
        Self {
            status: 404,
            headers: vec![("content-type".to_string(), "text/plain; charset=utf-8".to_string())],
            body: b"not found".to_vec(),
        }
    }

    /// 数据根都拿不到时的答复（对请求方与"没有这个 id"同一个答案）。
    pub fn not_found_for_data_root() -> Self {
        Self::not_found()
    }

    fn error(status: u16, text: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type".to_string(), "text/plain; charset=utf-8".to_string())],
            body: text.as_bytes().to_vec(),
        }
    }
}

fn mime_of_path(path: &Path) -> &'static str {
    match supported_format(path) {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("m4a") | Some("aac") => "audio/mp4",
        Some("ogg") => "audio/ogg",
        Some("opus") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// 协议路径 → 响应（**只按 id 查索引**；未知 id、坏路径、越界范围、非主窗来源一律结构化失败）。
///
/// 音频支持 Range（206 + `Content-Range`，越界 416）；封面没有内嵌图 → 404（界面用占位图，不是裂图）。
pub fn handle_protocol(
    root: &Path,
    source_label: &str,
    path: &str,
    range_header: Option<&str>,
) -> ProtocolOutcome {
    if !source_allowed(source_label) {
        log::warn!("本地曲库协议拒绝了来源 webview：{source_label}");
        return ProtocolOutcome::not_found();
    }
    let Some(request) = parse_protocol_path(path) else {
        return ProtocolOutcome::not_found();
    };

    let id = match &request {
        ProtocolRequest::Audio(id) | ProtocolRequest::Cover(id) => id.clone(),
    };
    let Some(track) = find_track(root, &id) else {
        return ProtocolOutcome::not_found();
    };
    let track_path = PathBuf::from(&track.path);
    if !track_path.is_file() {
        return ProtocolOutcome::not_found();
    }

    match request {
        ProtocolRequest::Cover(_) => match cover_bytes(&track_path) {
            Some((bytes, mime)) => ProtocolOutcome {
                status: 200,
                headers: vec![
                    ("content-type".to_string(), mime),
                    // 封面会被 AMLL 拿去 getImageData 取色：没有 CORS 头的话画布会被标记为 tainted
                    ("access-control-allow-origin".to_string(), "*".to_string()),
                    ("cache-control".to_string(), "no-store".to_string()),
                ],
                body: bytes,
            },
            None => ProtocolOutcome::not_found(),
        },
        ProtocolRequest::Audio(_) => serve_audio(&track_path, range_header),
    }
}

fn serve_audio(path: &Path, range_header: Option<&str>) -> ProtocolOutcome {
    let length = match fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => return ProtocolOutcome::not_found(),
    };
    let mime = mime_of_path(path);
    let mut headers = vec![
        ("content-type".to_string(), mime.to_string()),
        ("accept-ranges".to_string(), "bytes".to_string()),
        ("access-control-allow-origin".to_string(), "*".to_string()),
        ("cache-control".to_string(), "no-store".to_string()),
    ];

    match parse_range(range_header, length) {
        RangeOutcome::Unsatisfiable => {
            headers.push(("content-range".to_string(), format!("bytes */{length}")));
            ProtocolOutcome {
                status: 416,
                headers,
                body: Vec::new(),
            }
        }
        RangeOutcome::Partial { start, end } => {
            let mut bytes = Vec::new();
            let read = read_span(path, start, end - start + 1, &mut bytes);
            if read.is_err() {
                return ProtocolOutcome::error(500, "read failed");
            }
            headers.push((
                "content-range".to_string(),
                format!("bytes {start}-{end}/{length}"),
            ));
            headers.push(("content-length".to_string(), bytes.len().to_string()));
            ProtocolOutcome {
                status: 206,
                headers,
                body: bytes,
            }
        }
        RangeOutcome::Full => {
            let bytes = fs::read(path).unwrap_or_default();
            headers.push(("content-length".to_string(), bytes.len().to_string()));
            ProtocolOutcome {
                status: 200,
                headers,
                body: bytes,
            }
        }
    }
}

fn read_span(path: &Path, start: u64, length: u64, out: &mut Vec<u8>) -> std::io::Result<()> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    out.resize(length as usize, 0);
    file.read_exact(out)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令（全部经主窗来源守卫）
// ---------------------------------------------------------------------------

fn data_root(app: &AppHandle) -> Result<PathBuf, CoreError> {
    crate::webview_data_root(app).map_err(|error| {
        CoreError::new("internal", format!("本地曲库没有数据目录：{error}"))
    })
}

fn logged(command: &str, error: CoreError) -> CoreError {
    log::warn!("{command} 未完成：{error}");
    error
}

/// 快照的公共形状：`{tracks, available}`（`available` 说的是数据目录在不在）。
fn snapshot(tracks: &[Track]) -> Value {
    let views: Vec<Value> = tracks.iter().map(|track| track.view(track.available())).collect();
    json!({ "tracks": views, "available": true })
}

/// 选文件 / 选文件夹：在阻塞线程池上等，主线程全程不被占住（Windows 模态对话框会锁死事件循环）。
/// 不走渲染层的 `plugin:dialog|*`，那需要在 capabilities 里给页面对话框权限。
pub async fn pick_paths(app: AppHandle, folder: bool) -> Vec<PathBuf> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file();
        let picked = if folder {
            dialog.blocking_pick_folders()
        } else {
            dialog
                .add_filter("音频文件", SUPPORTED_FORMATS)
                .blocking_pick_files()
        };
        picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 协议基址（渲染层拼地址用；**别在渲染层写死**：Windows 与 mac/Linux 形态不同）。
#[tauri::command]
pub fn core_local_base_url(webview: Webview) -> Result<Value, CoreError> {
    require_main_webview(webview.label()).map_err(|error| logged("core_local_base_url", error))?;
    Ok(json!({ "baseUrl": protocol_base() }))
}

/// 曲库快照（每条带 `available`：文件还在不在）。
#[tauri::command]
pub fn core_local_list(webview: Webview) -> Result<Value, CoreError> {
    require_main_webview(webview.label()).map_err(|error| logged("core_local_list", error))?;
    let root = data_root(webview.app_handle()).map_err(|error| logged("core_local_list", error))?;
    Ok(snapshot(&load_index(&root)))
}

/// 导入：`paths` 缺省时开系统对话框（`folder: true` 是选文件夹）。
/// async 是为了等用户选完：用对话框的回调形态 await 一个答复槽，主线程始终不被占住。
#[tauri::command]
pub async fn core_local_import(
    webview: Webview,
    paths: Option<Vec<String>>,
    folder: Option<bool>,
) -> Result<Value, CoreError> {
    require_main_webview(webview.label()).map_err(|error| logged("core_local_import", error))?;
    let root = data_root(webview.app_handle()).map_err(|error| logged("core_local_import", error))?;

    let from_dialog = paths.is_none();
    let selected: Vec<PathBuf> = match paths {
        Some(list) => list.into_iter().map(PathBuf::from).collect(),
        None => {
            let app = webview.app_handle().clone();
            pick_paths(app, folder == Some(true)).await
        }
    };

    // 用户在对话框里按了取消：什么都没发生，回执里说清楚（不是错误）
    if selected.is_empty() && from_dialog {
        return Ok(json!({
            "added": 0,
            "updated": 0,
            "rejected": [],
            "truncated": 0,
            "tracks": snapshot(&load_index(&root))["tracks"],
        }));
    }

    let (tracks, outcome) =
        import_paths(&root, &selected).map_err(|error| logged("core_local_import", error))?;
    log::info!(
        "本地曲库导入：新增 {}、更新 {}、拒绝 {}",
        outcome.added,
        outcome.updated,
        outcome.rejected.len()
    );
    Ok(json!({
        "added": outcome.added,
        "updated": outcome.updated,
        "rejected": outcome.rejected,
        "truncated": outcome.truncated,
        "tracks": snapshot(&tracks)["tracks"],
        "available": true,
    }))
}

/// 从曲库移除一条（**不删文件**：用户的原文件不是我们的东西）。
#[tauri::command]
pub fn core_local_remove(webview: Webview, id: String) -> Result<Value, CoreError> {
    require_main_webview(webview.label()).map_err(|error| logged("core_local_remove", error))?;
    let root = data_root(webview.app_handle()).map_err(|error| logged("core_local_remove", error))?;
    let target = track_id_of_argument(&id).ok_or_else(|| {
        CoreError::new("invalid_payload", "core_local_remove 的 id 形状不对（要 32 位十六进制）")
    })?;
    let (tracks, removed) =
        remove_track(&root, &target).map_err(|error| logged("core_local_remove", error))?;
    Ok(json!({
        "removed": removed,
        "tracks": snapshot(&tracks)["tracks"],
        "available": true,
    }))
}

/// 宿主侧读歌词（`host:local-lyrics-source`）：`track_id` 已由载荷校验过（32 位十六进制），
/// 这里按 id 查索引并返回原始字节的 base64。
pub fn lyrics_source_for_track(app: &AppHandle, track_id: &str) -> Result<Value, CoreError> {
    let root = data_root(app)?;
    lyrics_payload(&root, track_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// 夹具的根目录：优先系统临时目录，不可写时落到仓库的 `.tmp/`（`.gitignore` 已覆盖它）。
    ///
    /// 要真写一次探测：沙箱里 `temp_dir()` 可能指向"存在但不可写"的目录，而 `create_dir_all` 照样返回 Ok。
    fn temp_dir(tag: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let leaf = format!("hwmusic-r65-{tag}-{}-{unique}", std::process::id());
        for base in [
            std::env::temp_dir(),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(".tmp").join("rust-r65"),
        ] {
            let dir = base.join(&leaf);
            if fs::create_dir_all(&dir).is_err() {
                continue;
            }
            let probe = dir.join("probe");
            if fs::write(&probe, b"ok").is_ok() {
                let _ = fs::remove_file(&probe);
                return dir;
            }
        }
        panic!("没有可写的临时目录（系统临时目录与仓库 .tmp 都写不进去）");
    }

    /// 现场生成一段很短的 WAV（8 kHz / 8 bit / 单声道）。**不提交任何真实音乐。**
    fn write_wav(path: &Path, seconds: u32) {
        let sample_rate: u32 = 8000;
        let data_len = sample_rate * seconds;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        bytes.extend(std::iter::repeat(0x80u8).take(data_len as usize));
        fs::write(path, bytes).expect("夹具 WAV 写不进去");
    }

    /// 用 lofty 给夹具写标签（标题/歌手/专辑/歌词/封面各一份）。
    ///
    /// 歌词必须写成 **USLT 帧**（`UnsynchronizedTextFrame`，要语言与描述）；它读回只映射成 `ItemKey::UnsyncLyrics`。
    fn write_tags(path: &Path, title: &str, artist: &str, album: &str, lyrics: Option<&str>, cover: bool) {
        use lofty::id3::v2::UnsynchronizedTextFrame;
        use lofty::iff::wav::WavFile;
        use lofty::tag::items::ENGLISH;
        use lofty::TextEncoding;

        let mut file = fs::File::open(path).expect("夹具打不开");
        let mut wav = WavFile::read_from(&mut file, lofty::config::ParseOptions::new())
            .expect("夹具读不进 lofty");
        let mut tag = wav.id3v2().cloned().unwrap_or_default();
        tag.set_title(title.to_string());
        tag.set_artist(artist.to_string());
        tag.set_album(album.to_string());
        if let Some(text) = lyrics {
            tag.insert(UnsynchronizedTextFrame::new(TextEncoding::UTF8, ENGLISH, "", text.to_string()).into());
        }
        if cover {
            // 1×1 的 PNG 头（内容不重要：这里验的是"字节原样送到协议那一侧"）
            let png: Vec<u8> = vec![
                0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H',
                b'D', b'R',
            ];
            let picture = Picture::unchecked(png)
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Png)
                .build();
            tag.insert_picture(picture);
        }
        wav.set_id3v2(tag);
        wav.save_to_path(path, WriteOptions::default())
            .expect("夹具标签写不进去");
    }

    /// 造一首带完整标签的夹具音轨，导入曲库，返回 (root, tracks, 该曲目的 id)。
    fn seeded(root: &Path, name: &str) -> (Vec<Track>, String) {
        let path = root.join(name);
        write_wav(&path, 1);
        write_tags(&path, "夜的第七章", "周杰伦", "依然范特西", Some("[00:01.00]内嵌词"), true);
        let (tracks, outcome) = import_paths(root, &[path]).expect("导入失败");
        assert_eq!(outcome.added, 1, "夹具应当导进去一首");
        let id = tracks[0].id.clone();
        (tracks, id)
    }

    #[test]
    fn 格式白名单只收能被_webview_播放的七种() {
        for format in SUPPORTED_FORMATS {
            assert_eq!(
                supported_format(Path::new(&format!("song.{format}"))),
                Some(*format),
                "{format} 必须在白名单里"
            );
        }
        // 大小写不敏感（Windows 上 `SONG.MP3` 与 `song.mp3` 是同一件事）
        assert_eq!(supported_format(Path::new("SONG.MP3")), Some("mp3"));

        for rejected in ["ape", "wma", "dff", "tak", "m4b"] {
            let path = PathBuf::from(format!("song.{rejected}"));
            assert_eq!(supported_format(&path), None, ".{rejected} 不该被收下");
            let reason = rejection_reason(&path);
            assert!(reason.contains(rejected), "拒绝理由要点出是哪种格式：{reason}");
            assert!(reason.contains("mp3"), "拒绝理由要说明支持什么：{reason}");
        }
        assert!(rejection_reason(Path::new("无扩展名")).contains("扩展名"));
    }

    #[test]
    fn 曲目_id_不可猜且与路径无关() {
        let first = new_track_id();
        let second = new_track_id();
        assert_eq!(first.len(), TRACK_ID_LEN);
        assert!(is_track_id(&first), "生成的 id 必须过自己的形状校验");
        assert_ne!(first, second, "两次生成不能撞");

        // 同一个路径两次导入的 id 不会"从路径算出来"：id 只由随机源决定
        let dir = temp_dir("id");
        let (_, first_id) = seeded(&dir, "a.wav");
        let other = dir.join("b.wav");
        write_wav(&other, 1);
        let (tracks, _) = import_paths(&dir, &[other]).expect("导入失败");
        assert_ne!(tracks[1].id, first_id);

        for bad in ["", "xyz", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef"] {
            assert!(!is_track_id(bad), "形状不对的 id 不许通过：{bad}");
            assert_eq!(find_track(&dir, bad), None, "坏 id 查不到东西");
        }
    }

    #[test]
    fn 元数据读得出标签_读不到时用文件名兜底() {
        let dir = temp_dir("meta");
        let tagged_path = dir.join("有标签.wav");
        write_wav(&tagged_path, 2);
        write_tags(&tagged_path, "以父之名", "周杰伦", "叶惠美", Some("[00:00.50]词"), true);

        let metadata = read_audio(&tagged_path);
        assert_eq!(metadata.title.as_deref(), Some("以父之名"));
        assert_eq!(metadata.artists.as_deref(), Some("周杰伦"));
        assert_eq!(metadata.album.as_deref(), Some("叶惠美"));
        assert!(metadata.has_cover, "写了封面就要认出来");
        let duration = metadata.duration_seconds.expect("生成的两秒 WAV 应当有时长");
        assert!((duration - 2.0).abs() < 0.1, "时长读出来是 {duration} 秒");

        // 没有标签：标题回落到文件名（去扩展名），不编一个"未知歌曲"
        let bare = dir.join("没有标签的歌.wav");
        write_wav(&bare, 1);
        let bare_metadata = read_audio(&bare);
        assert_eq!(bare_metadata.title, None);
        assert_eq!(display_title(&bare, &bare_metadata), "没有标签的歌");
        assert!(bare_metadata.duration_seconds.is_some());
    }

    #[test]
    fn 索引原子写入且同一路径重复导入只更新不新增() {
        let dir = temp_dir("index");
        let (tracks, id) = seeded(&dir, "song.wav");
        let index_path = dir.join(LIBRARY_FILE_NAME);
        assert!(index_path.is_file(), "索引文件应当落在数据根下");
        assert_eq!(tracks.len(), 1);

        // 没有残留临时文件（原子写要么成功、要么只留下一个临时文件；成功时不该有）
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不该留下临时文件：{leftovers:?}");

        // 再导入同一个文件：added 0 / updated 1，id 不变（队列与歌词缓存里的引用不能断）
        let path = dir.join("song.wav");
        let (again, outcome) = import_paths(&dir, &[path]).expect("重复导入失败");
        assert_eq!(outcome.added, 0);
        assert_eq!(outcome.updated, 1);
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, id);

        // Windows 上换个大小写还是同一份文件
        if cfg!(windows) {
            let (third, third_outcome) = import_paths(&dir, &[dir.join("SONG.WAV")]).expect("大小写导入失败");
            assert_eq!(third.len(), 1, "大小写不同的同一份文件不该变成两条");
            assert_eq!(third_outcome.added, 0);
        }
    }

    #[test]
    fn 文件丢失时标记不可用但仍可移除() {
        let dir = temp_dir("missing");
        let (_, id) = seeded(&dir, "gone.wav");
        fs::remove_file(dir.join("gone.wav")).expect("删夹具失败");

        let track = find_track(&dir, &id).expect("记录应当还在（文件丢了不等于记录没了）");
        assert!(!track.available(), "文件不在就要标成不可用");
        assert_eq!(track.view(track.available())["available"], json!(false));
        assert!(track.view(true).get("path").is_none(), "回给渲染层的记录里不许有路径");

        let (tracks, removed) = remove_track(&dir, &id).expect("移除失败");
        assert!(removed);
        assert!(tracks.is_empty());
        let (_, removed_again) = remove_track(&dir, &id).expect("重复移除失败");
        assert!(!removed_again, "第二次移除要如实回 false");
    }

    #[test]
    fn 协议对未知_id_与坏路径一律_404() {
        let dir = temp_dir("proto");
        let (_, id) = seeded(&dir, "song.wav");

        // 未导入的 id（形状合法但库里没有）
        let unknown = "f".repeat(32);
        assert_eq!(handle_protocol(&dir, MAIN_WINDOW_LABEL, &format!("/{unknown}"), None).status, 404);

        // 坏路径：没有 id、段数不对、id 形状不对、带多余片段
        for path in [
            "/".to_string(),
            "/short".to_string(),
            format!("/{id}/cover/extra"),
            format!("/{id}/audio"),
            format!("/{}/", id),
            format!("/{}/cover/", id),
        ] {
            assert_eq!(
                handle_protocol(&dir, MAIN_WINDOW_LABEL, &path, None).status,
                404,
                "坏路径必须 404：{path}"
            );
        }
        // 正常形态能拿到 200
        assert_eq!(handle_protocol(&dir, MAIN_WINDOW_LABEL, &format!("/{id}"), None).status, 200);
    }

    #[test]
    fn 协议按来源_webview_拦截_登录页一律拒绝() {
        let dir = temp_dir("source");
        let (_, id) = seeded(&dir, "song.wav");
        let path = format!("/{id}");

        assert!(source_allowed(MAIN_WINDOW_LABEL));
        for denied in ["login", "login-return", "login-theme", "lyrics-settings", "lyrics", ""] {
            assert!(!source_allowed(denied), "{denied} 不该被放行");
            // 不予区分：对外只有一种答复（404），不告诉它"其实有这个 id、只是不给你"
            assert_eq!(
                handle_protocol(&dir, denied, &path, None).status,
                404,
                "{denied} 必须被拦下"
            );
        }
    }

    #[test]
    fn range_支持拖动进度_越界回_416() {
        // 纯函数部分：三种写法 + 坏写法按整份
        assert_eq!(parse_range(None, 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("bytes=0-9"), 100), RangeOutcome::Partial { start: 0, end: 9 });
        assert_eq!(parse_range(Some("bytes=90-"), 100), RangeOutcome::Partial { start: 90, end: 99 });
        assert_eq!(parse_range(Some("bytes=-10"), 100), RangeOutcome::Partial { start: 90, end: 99 });
        assert_eq!(
            parse_range(Some("bytes=0-999"), 100),
            RangeOutcome::Partial { start: 0, end: 99 },
            "越界的 end 夹进文件长度"
        );
        assert_eq!(parse_range(Some("bytes=100-200"), 100), RangeOutcome::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), RangeOutcome::Full, "多区间按整份回");
        assert_eq!(parse_range(Some("items=0-1"), 100), RangeOutcome::Full);
        assert_eq!(parse_range(Some("bytes=abc-def"), 100), RangeOutcome::Full);

        // 端到端：夹具 WAV 上真的取一段
        let dir = temp_dir("range");
        let (_, id) = seeded(&dir, "song.wav");
        let total = fs::metadata(dir.join("song.wav")).unwrap().len();

        let partial = handle_protocol(&dir, MAIN_WINDOW_LABEL, &format!("/{id}"), Some("bytes=0-99"));
        assert_eq!(partial.status, 206);
        assert_eq!(partial.body.len(), 100);
        assert!(
            partial
                .headers
                .iter()
                .any(|(name, value)| name == "content-range" && value == &format!("bytes 0-99/{total}")),
            "206 必须带 Content-Range"
        );
        assert!(partial.headers.iter().any(|(name, _)| name == "accept-ranges"));

        let beyond = handle_protocol(&dir, MAIN_WINDOW_LABEL, &format!("/{id}"), Some("bytes=99999999-"));
        assert_eq!(beyond.status, 416);
    }

    #[test]
    fn 歌词来源优先级_同名_lrc_优先于_txt_优先于内嵌() {
        let dir = temp_dir("lyrics");
        let path = dir.join("song.wav");
        write_wav(&path, 1);
        write_tags(&path, "标题", "歌手", "专辑", Some("[00:03.00]内嵌"), false);
        let (tracks, _) = import_paths(&dir, &[path.clone()]).expect("导入失败");
        let id = tracks[0].id.clone();

        // ① 内嵌
        let payload = lyrics_payload(&dir, &id).expect("读歌词失败");
        assert_eq!(payload["source"], json!("embedded"));
        let embedded = payload["bytes"].as_str().unwrap().to_string();

        // ② 加一份 .txt：比内嵌优先
        fs::write(dir.join("song.txt"), "[00:02.00]文本词").unwrap();
        let payload = lyrics_payload(&dir, &format!("local:{id}")).expect("读歌词失败");
        assert_eq!(payload["source"], json!("txt"), "载荷带 local: 前缀也要认");

        // ③ 再加一份 .lrc：最优先
        fs::write(dir.join("song.lrc"), "[00:01.00]外挂词").unwrap();
        let payload = lyrics_payload(&dir, &id).expect("读歌词失败");
        assert_eq!(payload["source"], json!("lrc"));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload["bytes"].as_str().unwrap())
            .expect("回执必须是 base64");
        assert_eq!(String::from_utf8(bytes).unwrap(), "[00:01.00]外挂词");

        // 都不是歌词文件（比如只是一段二进制）也照样回字节：编码识别在 sidecar 那一侧
        assert!(!embedded.is_empty(), "内嵌歌词要能读出来");

        // 未导入的 id：回 null（不是错误）
        assert_eq!(lyrics_payload(&dir, &"f".repeat(32)).unwrap(), Value::Null);
        // 形状不对：结构化错误
        let failure = lyrics_payload(&dir, "not-an-id").unwrap_err();
        assert_eq!(failure.kind.as_deref(), Some("invalid_payload"));
    }

    #[test]
    fn 歌词字节上限_超过就不给() {
        let dir = temp_dir("lyrics-cap");
        let path = dir.join("song.wav");
        write_wav(&path, 1);
        let (tracks, _) = import_paths(&dir, &[path]).expect("导入失败");
        let id = tracks[0].id.clone();

        let oversized = vec![b'a'; LYRICS_SOURCE_MAX_BYTES as usize + 1];
        fs::write(dir.join("song.lrc"), &oversized).unwrap();
        assert_eq!(
            lyrics_payload(&dir, &id).unwrap(),
            Value::Null,
            "超过 512 KiB 的歌词文件不读（宁可没有歌词）"
        );

        let exact = vec![b'a'; LYRICS_SOURCE_MAX_BYTES as usize];
        fs::write(dir.join("song.lrc"), &exact).unwrap();
        assert!(lyrics_payload(&dir, &id).unwrap()["bytes"].is_string(), "正好到上限仍然读");
    }

    #[test]
    fn 封面按_id_提供内嵌图并带_mime() {
        let dir = temp_dir("cover");
        let (_, id) = seeded(&dir, "song.wav");

        let cover = handle_protocol(&dir, MAIN_WINDOW_LABEL, &format!("/{id}/cover"), None);
        assert_eq!(cover.status, 200);
        assert_eq!(cover.body.len(), 16, "原字节透传（不做任何图像处理）");
        assert!(
            cover
                .headers
                .iter()
                .any(|(name, value)| name == "content-type" && value == "image/png"),
            "MIME 来自标签"
        );
        // AMLL 背景会把封面拿去取色：没有 CORS 头画布会被标记为 tainted
        assert!(cover
            .headers
            .iter()
            .any(|(name, value)| name == "access-control-allow-origin" && value == "*"));

        // 没有封面的那一首：404（界面用占位图，不是裂图）
        let bare = dir.join("bare.wav");
        write_wav(&bare, 1);
        let (tracks, _) = import_paths(&dir, &[bare]).expect("导入失败");
        let bare_id = tracks.iter().find(|track| !track.has_cover).unwrap().id.clone();
        assert_eq!(
            handle_protocol(&dir, MAIN_WINDOW_LABEL, &format!("/{bare_id}/cover"), None).status,
            404
        );
    }

    #[test]
    fn 文件夹导入有深度与数量上限() {
        let dir = temp_dir("folder");
        let level1 = dir.join("l1");
        let level2 = level1.join("l2");
        let level3 = level2.join("l3");
        let level4 = level3.join("l4");
        fs::create_dir_all(&level4).unwrap();
        write_wav(&level4.join("deep.wav"), 1);
        write_wav(&level2.join("ok.wav"), 1);
        fs::write(dir.join("notes.txt"), "不是音频").unwrap();

        let (files, rejected, truncated) = collect_candidates(&[dir.clone()]);
        assert!(
            files.iter().any(|path| path.ends_with("ok.wav")),
            "上限之内那一层要收"
        );
        assert!(
            !files.iter().any(|path| path.ends_with("deep.wav")),
            "超过深度上限的不收"
        );
        assert_eq!(truncated, 1, "被深度上限挡下的目录要计入 truncated");
        assert!(rejected.is_empty(), "文件夹里的非音频文件不算被拒（跳过即可）");

        // 不存在的路径：结构化拒绝（说得出是哪个）
        let (_, rejected, _) = collect_candidates(&[dir.join("nope.wav")]);
        assert_eq!(rejected.len(), 1);
        assert!(rejected[0].reason.contains("不存在"));
    }
}
