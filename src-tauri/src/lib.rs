use serde::Deserialize;
use std::path::Path;
use std::process::Command;
use tauri::Manager;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─────────────────────────────────────────────
// 外部コマンド起動ヘルパー（コンソール点滅抑止）
//   decorations:false の GUI アプリでは、ffmpeg/taskkill 等を起動するたびに
//   黒いコンソールウィンドウが一瞬点滅する。Windows では CREATE_NO_WINDOW を
//   付与してこれを防ぐ。
// ─────────────────────────────────────────────
fn new_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// ─────────────────────────────────────────────
// FFmpeg パス解決（共通ヘルパー） — Bug 1 修正
// ─────────────────────────────────────────────
fn find_ffmpeg(app_handle: &tauri::AppHandle) -> String {
    // 0) バンドルされたリソース（インストール後の本番環境）
    //    tauri.conf.json の bundle.resources に "../ffmpeg.exe" を指定して同梱する。
    //    Tauri は親ディレクトリ参照(../)を "_up_" にサニタイズする場合があるため両方を探す。
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        for candidate in ["ffmpeg.exe", "_up_/ffmpeg.exe"] {
            let p = resource_dir.join(candidate);
            if p.exists() {
                return p.to_string_lossy().to_string();
            }
        }
    }
    // 1) アプリ実行ファイルと同じディレクトリにある ffmpeg.exe
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            let candidate = dir.join("ffmpeg.exe");
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    // 2) カレントディレクトリ
    if Path::new("./ffmpeg.exe").exists() {
        return "./ffmpeg.exe".to_string();
    }
    // 3) 一つ上のディレクトリ（開発時用）
    if Path::new("../ffmpeg.exe").exists() {
        return "../ffmpeg.exe".to_string();
    }
    // 4) プロジェクトルート（Tauri dev 実行時の構造）
    if Path::new("../../ffmpeg.exe").exists() {
        return "../../ffmpeg.exe".to_string();
    }
    // 5) PATH に入っていることを期待
    "ffmpeg".to_string()
}

// ─────────────────────────────────────────────
// 一時ファイルパス解決ヘルパー（アプリキャッシュディレクトリ）
// ─────────────────────────────────────────────
fn get_temp_paths(app_handle: &tauri::AppHandle, video_path: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // パス文字列のハッシュ値を用いて一意かつ決定論的なファイル名を生成
    let mut hasher = DefaultHasher::new();
    video_path.hash(&mut hasher);
    let hash_val = hasher.finish();

    // アプリのキャッシュディレクトリ（WebView2サンドボックス制限外）内にアプリ専用のディレクトリを作成
    let temp_dir = app_handle
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("multicam_sync_editor");
    let _ = std::fs::create_dir_all(&temp_dir);

    // 元ファイル名を取得
    let original_path = Path::new(video_path);
    let file_stem = original_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");

    let wav_name = format!("{}_{:x}.extracted.wav", file_stem, hash_val);
    let proxy_name = format!("{}_{:x}.proxy.mp4", file_stem, hash_val);

    (temp_dir.join(wav_name), temp_dir.join(proxy_name))
}

// 再生用フル品質 PCM(WAV) のパスを解決する（チャンク再生エンジンが任意バイト範囲を読む用）
fn get_playback_audio_path(app_handle: &tauri::AppHandle, video_path: &str) -> std::path::PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    video_path.hash(&mut hasher);
    let hash_val = hasher.finish();
    let temp_dir = app_handle
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("multicam_sync_editor");
    let _ = std::fs::create_dir_all(&temp_dir);
    let file_stem = Path::new(video_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    temp_dir.join(format!("{}_{:x}.playback.wav", file_stem, hash_val))
}

// 再生エンジン用に使うPCMフォーマット定数（フロントの AudioContext と一致させること）
pub const PLAYBACK_SAMPLE_RATE: u32 = 48000;
pub const PLAYBACK_CHANNELS: u16 = 2;

// ─────────────────────────────────────────────
// 音声抽出
// ─────────────────────────────────────────────
#[tauri::command]
async fn extract_audio(app_handle: tauri::AppHandle, video_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (wav_path, _) = get_temp_paths(&app_handle, &video_path);
        let wav_path_str = wav_path.to_string_lossy().to_string();

        // 既に抽出済みの wav ファイルがあれば再利用する（爆速キャッシュ）
        if wav_path.exists() && wav_path.metadata().map(|m| m.len()).unwrap_or(0) > 1000 {
            return Ok(wav_path_str);
        }

        let ffmpeg = find_ffmpeg(&app_handle);
        let output = new_command(&ffmpeg)
            .args([
                "-y",
                "-i", &video_path,
                "-vn",
                "-acodec", "pcm_s16le",
                "-ar", "8000", // 波形描画と同期専用なので低サンプリングレートで十分（爆速化）
                "-ac", "1",    // モノラルで十分
                &wav_path_str
            ])
            .output()
            .map_err(|e| format!("FFmpegの実行に失敗しました。FFmpegがインストールされているか確認してください: {}", e))?;

        if output.status.success() {
            Ok(wav_path_str)
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    })
    .await
    .map_err(|e| format!("タスクの実行に失敗しました: {}", e))?
}

// ─────────────────────────────────────────────
// 再生用フル品質 PCM(WAV) 抽出（チャンク再生エンジン用）
// 48kHz / ステレオ / s16le。任意バイト範囲を読んで AudioBuffer に詰める前提なので
// 非圧縮 PCM(WAV) を採用（チャンク復号不要・シーク自由）。結果はキャッシュする。
// 返り値: { path, sampleRate, channels, durationSeconds }
// ─────────────────────────────────────────────
#[derive(serde::Serialize)]
pub struct PlaybackAudioInfo {
    pub path: String,
    #[serde(rename = "sampleRate")]
    pub sample_rate: u32,
    pub channels: u16,
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: f64,
}

#[tauri::command]
async fn extract_playback_audio(app_handle: tauri::AppHandle, video_path: String) -> Result<PlaybackAudioInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out_path = get_playback_audio_path(&app_handle, &video_path);
        let out_str = out_path.to_string_lossy().to_string();

        // ヘッダを除いた PCM 1秒あたりのバイト数（再生位置→バイトオフセット換算用）
        let bytes_per_second = PLAYBACK_SAMPLE_RATE as u64 * PLAYBACK_CHANNELS as u64 * 2;

        // キャッシュ再利用
        if out_path.exists() {
            if let Ok(meta) = out_path.metadata() {
                if meta.len() > 44 {
                    let data_len = meta.len().saturating_sub(44);
                    let dur = data_len as f64 / bytes_per_second as f64;
                    return Ok(PlaybackAudioInfo {
                        path: out_str,
                        sample_rate: PLAYBACK_SAMPLE_RATE,
                        channels: PLAYBACK_CHANNELS,
                        duration_seconds: dur,
                    });
                }
            }
        }

        let ffmpeg = find_ffmpeg(&app_handle);
        let output = new_command(&ffmpeg)
            .args([
                "-y",
                "-i", &video_path,
                "-vn",
                "-acodec", "pcm_s16le",
                "-ar", &PLAYBACK_SAMPLE_RATE.to_string(),
                "-ac", &PLAYBACK_CHANNELS.to_string(),
                &out_str,
            ])
            .output()
            .map_err(|e| format!("FFmpegの実行に失敗しました: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let data_len = out_path.metadata().map(|m| m.len()).unwrap_or(0).saturating_sub(44);
        let dur = data_len as f64 / bytes_per_second as f64;
        Ok(PlaybackAudioInfo {
            path: out_str,
            sample_rate: PLAYBACK_SAMPLE_RATE,
            channels: PLAYBACK_CHANNELS,
            duration_seconds: dur,
        })
    })
    .await
    .map_err(|e| format!("タスクの実行に失敗しました: {}", e))?
}

// ─────────────────────────────────────────────
// PCM の任意バイト範囲読み出し（チャンク再生エンジン用）
// 生バイトを ArrayBuffer として返す（Vec<u8> を JSON 配列化すると激遅なので ipc::Response を使う）
// ─────────────────────────────────────────────
#[tauri::command]
async fn read_pcm_range(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path).map_err(|e| format!("PCMファイルを開けません: {}", e))?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| format!("シークに失敗: {}", e))?;
        let mut buf = vec![0u8; length as usize];
        let n = f.read(&mut buf).map_err(|e| format!("読み出しに失敗: {}", e))?;
        buf.truncate(n);
        Ok(tauri::ipc::Response::new(buf))
    })
    .await
    .map_err(|e| format!("タスクの実行に失敗しました: {}", e))?
}

// ─────────────────────────────────────────────
// 波形生成
// ─────────────────────────────────────────────
#[tauri::command]
async fn generate_waveform(wav_path: String, points_per_second: u32) -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = hound::WavReader::open(&wav_path)
            .map_err(|e| format!("Failed to open WAV file: {}", e))?;
            
        let spec = reader.spec();
        let channels = spec.channels as u32;
        let sample_rate = spec.sample_rate;
        
        let samples_per_point = (sample_rate * channels) / points_per_second;
        if samples_per_point == 0 {
            return Err("points_per_second is too large".to_string());
        }
        
        let mut peaks = Vec::new();
        let mut current_max: f32 = 0.0;
        let mut sample_count = 0;
        
        let max_val = i16::MAX as f32;
        
        for sample in reader.samples::<i16>() {
            let s = sample.unwrap_or(0);
            let abs_s = (s as f32 / max_val).abs();
            
            if abs_s > current_max {
                current_max = abs_s;
            }
            
            sample_count += 1;
            
            if sample_count >= samples_per_point {
                peaks.push(current_max);
                current_max = 0.0;
                sample_count = 0;
            }
        }
        
        if sample_count > 0 {
            peaks.push(current_max);
        }
        
        Ok(peaks)
    })
    .await
    .map_err(|e| format!("タスクの実行に失敗しました: {}", e))?
}

// ─────────────────────────────────────────────
// エンベロープ抽出（同期計算用）
// ─────────────────────────────────────────────
struct HighPassFilter {
    alpha: f32,
    prev_x: f32,
    prev_y: f32,
}

impl HighPassFilter {
    fn new(cutoff_hz: f32, sample_rate: f32) -> Self {
        let dt = 1.0 / sample_rate;
        let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
        let alpha = rc / (rc + dt);
        Self {
            alpha,
            prev_x: 0.0,
            prev_y: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.alpha * (self.prev_y + x - self.prev_x);
        self.prev_x = x;
        self.prev_y = y;
        y
    }
}

struct LowPassFilter {
    alpha: f32,
    prev_y: f32,
}

impl LowPassFilter {
    fn new(cutoff_hz: f32, sample_rate: f32) -> Self {
        let dt = 1.0 / sample_rate;
        let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
        let alpha = dt / (rc + dt);
        Self {
            alpha,
            prev_y: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.prev_y + self.alpha * (x - self.prev_y);
        self.prev_y = y;
        y
    }
}

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

// 実行中のエクスポート用 FFmpeg プロセスの PID（0 = なし）と、キャンセル要求フラグ。
// cancel_export から該当プロセスを kill し、export_video 側で「キャンセル起因の失敗」を判別する。
static EXPORT_PID: AtomicU32 = AtomicU32::new(0);
static EXPORT_CANCEL: AtomicBool = AtomicBool::new(false);

static ENVELOPE_CACHE: OnceLock<Mutex<HashMap<String, (Vec<f32>, u32)>>> = OnceLock::new();

fn get_envelope_cache() -> &'static Mutex<HashMap<String, (Vec<f32>, u32)>> {
    ENVELOPE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn extract_envelope(wav_path: &str, target_sample_rate: u32) -> Result<(Vec<f32>, u32), String> {
    let cache_key = format!("{}_{}", wav_path, target_sample_rate);
    
    // 1. キャッシュの検索
    if let Ok(cache) = get_envelope_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            println!("[Sync Optimization] Cache HIT for envelope of {}", wav_path);
            return Ok(cached.clone());
        }
    }

    println!("[Sync Optimization] Cache MISS for envelope of {}, extracting...", wav_path);
    let result = extract_envelope_impl(wav_path, target_sample_rate)?;

    // 2. キャッシュへの保存
    if let Ok(mut cache) = get_envelope_cache().lock() {
        cache.insert(cache_key, result.clone());
    }

    Ok(result)
}

fn extract_envelope_impl(wav_path: &str, target_sample_rate: u32) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(wav_path)
        .map_err(|e| format!("Failed to open WAV: {}", e))?;
    let spec = reader.spec();
    let original_sr = spec.sample_rate;
    let channels = spec.channels as u32;
    
    let step = (original_sr / target_sample_rate).max(1);
    let actual_target_sr = original_sr / step;
    
    let mut envelope = Vec::new();
    let mut max_in_window = 0.0f32;
    let mut count = 0;
    
    let max_val = i16::MAX as f32;
    
    // High-pass filter at 40Hz and Low-pass filter at 3000Hz (3kHz) optimized for music live performances
    // Preserves deep bass (kick/bass guitar) and vocal/snare mid range while filtering high-frequency noise
    let mut hp_filter = HighPassFilter::new(40.0, original_sr as f32);
    let mut lp_filter = LowPassFilter::new(3000.0, original_sr as f32);
    
    let mut samples_iter = reader.samples::<i16>();
    
    if channels == 1 {
        while let Some(sample) = samples_iter.next() {
            let s = sample.unwrap_or(0);
            let s_f32 = s as f32 / max_val;
            let hp_s = hp_filter.process(s_f32);
            let lp_s = lp_filter.process(hp_s);
            let abs_s = lp_s.abs();
            
            if abs_s > max_in_window {
                max_in_window = abs_s;
            }
            count += 1;
            if count >= step {
                envelope.push(max_in_window);
                max_in_window = 0.0;
                count = 0;
            }
        }
    } else if channels == 2 {
        while let Some(sample_l) = samples_iter.next() {
            let s = sample_l.unwrap_or(0);
            let _ = samples_iter.next(); // Skip right channel sample
            
            let s_f32 = s as f32 / max_val;
            let hp_s = hp_filter.process(s_f32);
            let lp_s = lp_filter.process(hp_s);
            let abs_s = lp_s.abs();
            
            if abs_s > max_in_window {
                max_in_window = abs_s;
            }
            count += 1;
            if count >= step {
                envelope.push(max_in_window);
                max_in_window = 0.0;
                count = 0;
            }
        }
    } else {
        // Fallback for multi-channel audio
        let mut ch = 0;
        while let Some(sample) = samples_iter.next() {
            let s = sample.unwrap_or(0);
            if ch == 0 {
                let s_f32 = s as f32 / max_val;
                let hp_s = hp_filter.process(s_f32);
                let lp_s = lp_filter.process(hp_s);
                let abs_s = lp_s.abs();
                
                if abs_s > max_in_window {
                    max_in_window = abs_s;
                }
                count += 1;
                if count >= step {
                    envelope.push(max_in_window);
                    max_in_window = 0.0;
                    count = 0;
                }
            }
            ch += 1;
            if ch >= channels {
                ch = 0;
            }
        }
    }
    
    if count > 0 {
        envelope.push(max_in_window);
    }
    
    Ok((envelope, actual_target_sr))
}


// ─────────────────────────────────────────────
// 自動同期オフセット計算（FFT相互相関）
// ─────────────────────────────────────────────
#[tauri::command]
async fn calculate_sync_offset(ref_path: String, target_path: String) -> Result<f32, String> {
    use rustfft::{FftPlanner, num_complex::Complex};
    use std::time::Instant;

    let start_total = Instant::now();
    let target_sr = 250;
    
    let start_ref = Instant::now();
    let (ref_env, ref_actual_sr) = extract_envelope(&ref_path, target_sr)?;
    println!("[Sync Profile] Extracting REF envelope took: {:?}", start_ref.elapsed());
    
    let start_target = Instant::now();
    let (target_env, _target_actual_sr) = extract_envelope(&target_path, target_sr)?;
    println!("[Sync Profile] Extracting TARGET envelope took: {:?}", start_target.elapsed());
    
    let start_fft_prep = Instant::now();
    let n = ref_env.len() + target_env.len() - 1;
    let fft_len = n.next_power_of_two();
    
    let mut ref_complex: Vec<Complex<f32>> = vec![Complex { re: 0.0, im: 0.0 }; fft_len];
    let mut target_complex: Vec<Complex<f32>> = vec![Complex { re: 0.0, im: 0.0 }; fft_len];
    
    for (i, &val) in ref_env.iter().enumerate() {
        ref_complex[i].re = val;
    }
    for (i, &val) in target_env.iter().enumerate() {
        target_complex[i].re = val;
    }
    println!("[Sync Profile] FFT preparation took: {:?}", start_fft_prep.elapsed());
    
    let start_fft = Instant::now();
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(fft_len);
    fft.process(&mut ref_complex);
    fft.process(&mut target_complex);
    
    for i in 0..fft_len {
        let conj = Complex { re: target_complex[i].re, im: -target_complex[i].im };
        ref_complex[i] = ref_complex[i] * conj;
    }
    
    let ifft = planner.plan_fft_inverse(fft_len);
    ifft.process(&mut ref_complex);
    println!("[Sync Profile] FFT + Correlation took: {:?}", start_fft.elapsed());
    
    let start_peak = Instant::now();
    let mut max_val = -1.0;
    let mut max_index = 0;
    for i in 0..fft_len {
        let val = ref_complex[i].norm();
        if val > max_val {
            max_val = val;
            max_index = i;
        }
    }
    
    let mut offset_samples = max_index as i64;
    if offset_samples >= ref_env.len() as i64 {
        offset_samples -= fft_len as i64;
    }
    
    let offset_seconds = offset_samples as f32 / ref_actual_sr as f32;
    println!("[Sync Profile] Peak finding took: {:?}", start_peak.elapsed());
    println!("[Sync Profile] Total sync calculation took: {:?}", start_total.elapsed());
    
    Ok(offset_seconds)
}

// ─────────────────────────────────────────────
// エクスポート用データ構造 — Bug 4,5 修正
// ─────────────────────────────────────────────

#[derive(Deserialize, Debug)]
pub struct ExportSettings {
    pub resolution: String,
    pub encoder: String,
    #[serde(rename = "rateControl", default)]
    pub rate_control: String, // "cbr" | "vbr" | "crf"
    pub bitrate: Option<String>,
    pub maxrate: Option<String>,
    #[serde(rename = "crfValue")]
    pub crf_value: Option<u32>,
    pub fps: Option<String>,
    pub loudnorm: bool,
    #[serde(rename = "audioQuality")]
    pub audio_quality: Option<String>,
    #[serde(rename = "outputPath")]
    pub output_path: String,
    #[serde(rename = "startTimeSeconds")]
    pub start_time: Option<f32>,
    #[serde(rename = "endTimeSeconds")]
    pub end_time: Option<f32>,
    #[serde(rename = "fadeIn", default)]
    pub fade_in: bool,
    #[serde(rename = "fadeInDuration", default)]
    pub fade_in_duration: f32,
    #[serde(rename = "fadeOut", default)]
    pub fade_out: bool,
    #[serde(rename = "fadeOutDuration", default)]
    pub fade_out_duration: f32,
}

#[derive(Deserialize, Debug)]
pub struct CutPointPayload {
    pub id: String,
    #[serde(rename = "timeSeconds")]
    pub time_seconds: f32,
    #[serde(rename = "cameraId")]
    pub camera_id: String,
    pub transition: String,
    #[serde(rename = "transitionDuration")]
    pub transition_duration: f32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CompPayload {
    pub threshold: f32, // dB
    pub ratio: f32,
    pub attack: f32,    // 秒
    pub release: f32,   // 秒
    pub knee: f32,      // dB
}

#[derive(Deserialize, Debug)]
pub struct TrackAudioStatePayload {
    pub volume: f32,
    pub pan: f32,
    #[serde(rename = "isMono")]
    pub is_mono: bool,
    #[serde(rename = "isMuted")]
    pub is_muted: bool,
    #[serde(default)]
    pub eq: Vec<f32>, // 各バンドのゲイン(dB)。インデックスは EQ_BANDS と対応
    #[serde(rename = "eqEnabled", default)]
    pub eq_enabled: bool,
    #[serde(default)]
    pub comp: Option<CompPayload>,
    #[serde(rename = "compEnabled", default)]
    pub comp_enabled: bool,
}

#[derive(Deserialize, Debug)]
pub struct MasterStatePayload {
    pub volume: f32,
    pub pan: f32,
    #[serde(rename = "isMono")]
    pub is_mono: bool,
    #[serde(default)]
    pub eq: Vec<f32>,
    #[serde(rename = "eqEnabled", default)]
    pub eq_enabled: bool,
    #[serde(default)]
    pub comp: Option<CompPayload>,
    #[serde(rename = "compEnabled", default)]
    pub comp_enabled: bool,
}

#[derive(Deserialize, Debug)]
pub struct ColorStatePayload {
    pub temperature: f32,
    pub tint: f32,
    pub exposure: f32,
    pub contrast: f32,
}

#[derive(Deserialize, Debug)]
pub struct TrackDataPayload {
    pub id: String,
    pub name: String,  // Bug 4 修正: 追加
    pub path: String,
    #[serde(rename = "wavPath")]
    pub wav_path: String,  // Bug 4 修正: 追加
    #[serde(default)]
    pub peaks: Vec<f32>,  // Bug 4 修正: 追加（default で空でもOK）
    #[serde(rename = "offsetSeconds")]
    pub offset_seconds: f32,
    #[serde(rename = "isRef")]
    pub is_ref: bool,  // Bug 5 修正: 追加
    #[serde(rename = "isAudioOnly", default)]
    pub is_audio_only: bool,
    #[serde(rename = "isLocked", default)]
    pub is_locked: bool,
    #[serde(rename = "audioOffsetSeconds", default)]
    pub audio_offset_seconds: f32,
    #[serde(rename = "audioState")]
    pub audio_state: TrackAudioStatePayload,
    #[serde(rename = "colorState")]
    pub color_state: Option<ColorStatePayload>,
}

#[derive(Deserialize, Debug)]
pub struct ExportPayload {
    pub tracks: Vec<TrackDataPayload>,
    pub cuts: Vec<CutPointPayload>,
    pub settings: ExportSettings,
    #[serde(default)]
    pub master: Option<MasterStatePayload>,
}

// EQ バンド定義（周波数, タイプ, Q）。
// ※ フロントエンド src/AudioEngine.ts の EQ_BANDS と必ず一致させること。
//   インデックスが audio_state.eq（ゲイン配列）と対応する。
const EQ_BANDS: &[(f32, &str, f32)] = &[
    (50.0,   "lowshelf",  0.7),
    (120.0,  "peaking",   1.0),
    (300.0,  "peaking",   1.0),
    (700.0,  "peaking",   1.0),
    (1600.0, "peaking",   1.0),
    (3500.0, "peaking",   1.0),
    (7000.0, "highshelf", 0.7),
];

/// EQ ゲイン配列から FFmpeg 音声フィルタ片（カンマ区切り）を生成する。有効なバンドのみ。
fn build_eq_filter(eq: &[f32]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (i, &(freq, ftype, q)) in EQ_BANDS.iter().enumerate() {
        let g = eq.get(i).copied().unwrap_or(0.0);
        if g.abs() < 0.05 { continue; } // ほぼ0dBのバンドはスキップ
        match ftype {
            "lowshelf"  => parts.push(format!("bass=g={:.2}:f={:.0}", g, freq)),
            "highshelf" => parts.push(format!("treble=g={:.2}:f={:.0}", g, freq)),
            _           => parts.push(format!("equalizer=f={:.0}:t=q:w={:.2}:g={:.2}", freq, q, g)),
        }
    }
    parts.join(",")
}

/// Web Audio DynamicsCompressor 相当のパラメータを FFmpeg acompressor へ変換する。
/// threshold は dB→linear、attack/release は秒→ms に変換する。
/// （knee の単位は互換性がないため FFmpeg 既定値に任せる。完全一致ではなく近似）
fn build_comp_filter(c: &CompPayload) -> String {
    let thr_lin = 10f32.powf(c.threshold / 20.0).clamp(0.000977, 1.0);
    let ratio = c.ratio.clamp(1.0, 20.0);
    let atk = (c.attack * 1000.0).clamp(0.01, 2000.0);
    let rel = (c.release * 1000.0).clamp(0.01, 9000.0);
    format!("acompressor=threshold={:.6}:ratio={:.2}:attack={:.2}:release={:.2}", thr_lin, ratio, atk, rel)
}

fn detect_best_encoder(ffmpeg: &str) -> String {
    let candidates = ["h264_nvenc", "h264_qsv", "h264_amf"];
    for encoder in &candidates {
        // 注: テストフレームは 256x256 を使う。NVENC は最小フレームサイズ制限があり、
        //     16x16 等の極小フレームだと "Frame Dimension less than the minimum supported value"
        //     で初期化に失敗し、NVENC が使えるのに誤って libx264 へフォールバックしてしまう。
        let ok = new_command(ffmpeg)
            .args([
                "-f", "lavfi", "-i", "color=c=black:s=256x256:r=1",
                "-frames:v", "1", "-c:v", encoder,
                "-f", "null", "-"
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return encoder.to_string();
        }
    }
    "libx264".to_string()
}

fn bufsize_2x(rate: &str) -> String {
    if let Some(n) = rate.strip_suffix('M').and_then(|s| s.parse::<f64>().ok()) {
        return format!("{:.0}M", n * 2.0);
    }
    if let Some(n) = rate.strip_suffix('k').and_then(|s| s.parse::<f64>().ok()) {
        return format!("{:.0}k", n * 2.0);
    }
    rate.to_string()
}

// ─────────────────────────────────────────────
// エクスポート — Bug 2,3,5,11 修正
// ─────────────────────────────────────────────
#[tauri::command]
async fn export_video(app_handle: tauri::AppHandle, payload: ExportPayload) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    use tauri::Emitter;

    let ffmpeg = find_ffmpeg(&app_handle);
    let _ = app_handle.emit("export-status", "動画情報を取得中...");
    let duration_track_idx = payload.tracks.iter().position(|t| !t.is_audio_only).unwrap_or(0);
    let total_duration = get_media_duration(&ffmpeg, &payload.tracks[duration_track_idx].path).unwrap_or(0.0);
    let _ = app_handle.emit("export-status", "フィルターグラフを構築中...");
    // -nostdin: GUI から起動した場合、標準入力が無効なハンドルになっており、
    // FFmpeg がキー入力待ち（対話モード）でブロックして「起動中」のまま固まることがあるため明示的に無効化する。
    let mut args = vec!["-y".to_string(), "-nostdin".to_string()];

    // ────────────────────────────
    // 書き出し範囲（In/Out 点）— 範囲指定がある場合は入力シーク(-ss)で「必要な区間だけ」を
    // デコード・処理する。これをしないと例えば40分素材の終盤3分を書き出す際に、先頭からの
    // 全区間をスケール/トランジション処理してしまい、激遅・進捗0%固定・音声エンコーダ初期化
    // 失敗（映像と音声の処理速度が極端に偏り、音声フレームがEOFまで届かない）を招く。
    // ────────────────────────────
    let use_trim = payload.settings.start_time.is_some() || payload.settings.end_time.is_some();
    let range_start: f32 = payload.settings.start_time.unwrap_or(0.0);
    let range_end: f32 = payload.settings.end_time.unwrap_or(total_duration as f32);
    let range_dur: f32 = (range_end - range_start).max(0.0);
    let shift: f32 = if use_trim { range_start } else { 0.0 };
    // 各入力のシーク量（その入力素材内の時間）。track_offset を引くことで、シーク後の
    // 相対時刻0が「マスタータイムライン上の range_start」に揃う。
    let input_seeks: Vec<f32> = payload.tracks.iter()
        .map(|t| if use_trim { (range_start - t.offset_seconds).max(0.0) } else { 0.0 })
        .collect();

    // ────────────────────────────
    // 1. 入力ファイル（範囲指定時は -ss で高速・正確シーク）
    // ────────────────────────────
    for (i, track) in payload.tracks.iter().enumerate() {
        if use_trim && input_seeks[i] > 0.001 {
            // -ss を -i の前に置くと、キーフレーム探索＋正確シークで該当時刻以降だけを読む
            args.push("-ss".to_string());
            args.push(format!("{:.3}", input_seeks[i]));
        }
        args.push("-i".to_string());
        args.push(track.path.clone());
    }

    let mut filter_complex = String::new();
    let mut cuts = payload.cuts;
    cuts.sort_by(|a, b| a.time_seconds.partial_cmp(&b.time_seconds).unwrap());

    // ────────────────────────────
    // H2 修正: 最初のカットが 0 秒より後にある場合の対処
    //   - プレビューでは [0, 最初のカット] 区間はデフォルト(REF)カメラで表示されるが、
    //     セグメントは各カット時刻から構築されるため、この先頭区間が出力から欠落する。
    //   - また xfade の offset は絶対時刻を用いており、これはセグメント連鎖が
    //     絶対時刻 0 から始まる場合のみ正しい。最初のカットが 0 でないとずれる。
    //   時刻 0 にデフォルトカメラの暗黙カットを挿入することで両方を一挙に解消する。
    // ────────────────────────────
    if !cuts.is_empty() && cuts[0].time_seconds > 0.001 {
        if let Some(default_cam) = payload.tracks.iter()
            .find(|t| t.is_ref && !t.is_audio_only)
            .or_else(|| payload.tracks.iter().find(|t| !t.is_audio_only))
            .map(|t| t.id.clone())
        {
            cuts.insert(0, CutPointPayload {
                id: "__intro__".to_string(),
                time_seconds: 0.0,
                camera_id: default_cam,
                transition: "cut".to_string(),
                transition_duration: 0.0,
            });
        }
    }

    // ────────────────────────────
    // 2. ビデオセグメント — Bug 2,3 修正 + 範囲指定の最適化
    //   範囲指定時は各セグメントを「入力シーク相対」でトリムし、出力タイムラインを
    //   0始まりに正規化する。区間外のセグメントは除外する。
    // ────────────────────────────
    let res_parts: Vec<&str> = payload.settings.resolution.split('x').collect();
    let (vw, vh) = if res_parts.len() == 2 { (res_parts[0], res_parts[1]) } else { ("1920", "1080") };
    let scale_base = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
        vw, vh, vw, vh
    );
    let fps_val = payload.settings.fps.as_deref()
        .filter(|&f| f != "source" && !f.is_empty())
        .unwrap_or("30");
    let scale_fmt = format!("{},fps={},format=yuv420p", scale_base, fps_val);

    if cuts.is_empty() {
        // カットが0件: 最初の有効なビデオトラックの映像をそのまま使う
        let ref_idx = payload.tracks.iter().position(|t| t.is_ref && !t.is_audio_only)
            .or_else(|| payload.tracks.iter().position(|t| !t.is_audio_only))
            .unwrap_or(0);
        let o = payload.tracks[ref_idx].offset_seconds;
        let s = input_seeks[ref_idx];
        let cf = payload.tracks[ref_idx].color_state.as_ref()
            .and_then(color_filter_string)
            .map(|f| format!("{},", f))
            .unwrap_or_default();
        if use_trim {
            let t0 = (range_start - o - s).max(0.0);
            let t1 = (range_end - o - s).max(0.0);
            filter_complex.push_str(&format!(
                "[{}:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,{}{}[vout];",
                ref_idx, t0, t1, cf, scale_fmt
            ));
        } else {
            filter_complex.push_str(&format!("[{}:v]{}{}[vout];", ref_idx, cf, scale_fmt));
        }
    } else {
        // 採用セグメント情報（範囲外を除外してからインデックスを振り直す）
        struct Seg {
            input_idx: usize,
            t_start: f32,
            t_end: f32,
            out_pos: f32,
            cf: String,
            in_trans: String,
            in_trans_dur: f32,
        }
        let mut segs: Vec<Seg> = Vec::new();
        for (idx, cut) in cuts.iter().enumerate() {
            let input_idx = payload.tracks.iter().position(|t| t.id == cut.camera_id).unwrap_or(0);
            let o = payload.tracks[input_idx].offset_seconds;
            let s = input_seeks[input_idx];

            // このセグメントのマスタータイムライン上の出力区間 [seg_a, seg_b]
            let seg_a = cut.time_seconds;
            let seg_b = if idx + 1 < cuts.len() {
                let nc = &cuts[idx + 1];
                let td = if nc.transition == "cut" { 0.01 } else { nc.transition_duration };
                nc.time_seconds + td // 次トランジション用に少し延ばす（重なり素材）
            } else if use_trim {
                range_end
            } else {
                total_duration as f32
            };

            // 範囲でクリップ
            let eff_a = if use_trim { seg_a.max(range_start) } else { seg_a };
            let eff_b = if use_trim { seg_b.min(range_end) } else { seg_b };
            if use_trim && eff_a >= eff_b - 0.0005 {
                continue; // 範囲外
            }

            let cf = payload.tracks[input_idx].color_state.as_ref()
                .and_then(color_filter_string)
                .map(|f| format!("{},", f))
                .unwrap_or_default();

            segs.push(Seg {
                input_idx,
                t_start: (eff_a - o - s).max(0.0),
                t_end: (eff_b - o - s).max(0.0),
                out_pos: (eff_a - shift).max(0.0),
                cf,
                in_trans: cut.transition.clone(),
                in_trans_dur: cut.transition_duration,
            });
        }

        // 念のため: 全除外なら ref をフォールバック
        if segs.is_empty() {
            let ref_idx = payload.tracks.iter().position(|t| !t.is_audio_only).unwrap_or(0);
            let o = payload.tracks[ref_idx].offset_seconds;
            let s = input_seeks[ref_idx];
            let t0 = (range_start - o - s).max(0.0);
            let t1 = (range_end - o - s).max(0.0);
            filter_complex.push_str(&format!(
                "[{}:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,{}[vout];",
                ref_idx, t0, t1, scale_fmt
            ));
        } else {
            for (k, seg) in segs.iter().enumerate() {
                filter_complex.push_str(&format!(
                    "[{}:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,{}{} [vseg{}];",
                    seg.input_idx, seg.t_start, seg.t_end, seg.cf, scale_fmt, k
                ));
            }
            if segs.len() == 1 {
                filter_complex.push_str("[vseg0]null[vout];");
            } else {
                let mut last_label = "[vseg0]".to_string();
                for k in 0..(segs.len() - 1) {
                    let nxt = &segs[k + 1];
                    let next_label = format!("[vseg{}]", k + 1);
                    let out_label = format!("[vtmp{}]", k);
                    let (transition, duration) = if nxt.in_trans == "cut" {
                        ("fade", 0.01)
                    } else {
                        let t_name = match nxt.in_trans.as_str() {
                            "crossfade" => "fade",
                            "dip_to_black" => "fadeblack",
                            "dip_to_white" => "fadewhite",
                            _ => "fade",
                        };
                        (t_name, nxt.in_trans_dur)
                    };
                    let out_ref = if k == segs.len() - 2 { "[vout]".to_string() } else { out_label.clone() };
                    filter_complex.push_str(&format!(
                        "{}{}xfade=transition={}:duration={:.3}:offset={:.3}{};",
                        last_label, next_label, transition, duration, nxt.out_pos, out_ref
                    ));
                    last_label = out_label;
                }
            }
        }
    }
    
    // ────────────────────────────
    // 3. オーディオミキシング（入力シーク・範囲指定を考慮）
    // ────────────────────────────
    let mut amix_labels = Vec::new();
    for (i, track) in payload.tracks.iter().enumerate() {
        if track.audio_state.is_muted { continue; }

        let st = &track.audio_state;
        // フィルタ段を順に積む（Web Audio の chain 順: comp -> EQ -> volume -> pan に合わせる）
        let mut stages: Vec<String> = Vec::new();

        // 出力タイムライン(0始まり)上での音声遅延を計算する。
        // use_trim 時は入力を range_start 付近までシーク済みなので、残差 = audio_offset 相当になる。
        let total_audio_offset = track.offset_seconds + track.audio_offset_seconds;
        let applied_offset = if use_trim {
            input_seeks[i] + total_audio_offset - range_start
        } else {
            total_audio_offset
        };
        let offset_ms = (applied_offset * 1000.0).round() as i64;
        if offset_ms > 0 {
            stages.push(format!("adelay={}|{}", offset_ms, offset_ms));
        } else if offset_ms < 0 {
            stages.push(format!("atrim=start={:.3}", -applied_offset));
            stages.push("asetpts=PTS-STARTPTS".to_string());
        }

        // コンプ（Web Audio では source 直後。生レベルに対して掛ける）
        if st.comp_enabled {
            if let Some(c) = &st.comp {
                stages.push(build_comp_filter(c));
            }
        }

        // EQ
        if st.eq_enabled {
            let eqf = build_eq_filter(&st.eq);
            if !eqf.is_empty() { stages.push(eqf); }
        }

        // パン（Web Audio: panner はフェーダーの前）
        let pan = st.pan;
        if pan.abs() > 0.01 {
            let left_gain = if pan > 0.0 { 1.0 - pan } else { 1.0 };
            let right_gain = if pan < 0.0 { 1.0 + pan } else { 1.0 };
            stages.push(format!("pan=stereo|c0={:.2}*c0|c1={:.2}*c1", left_gain, right_gain));
        }

        // モノ
        if st.is_mono {
            stages.push("aformat=channel_layouts=mono".to_string());
        }

        // 音量（フェーダーはチャンネルストリップの最後）
        stages.push(format!("volume={:.2}", st.volume));

        let label = format!("[a{}]", i);
        filter_complex.push_str(&format!("[{}:a]{}{};", i, stages.join(","), label));

        amix_labels.push(label);
    }

    // 各トラックを [amixed] に合算
    if amix_labels.is_empty() {
        filter_complex.push_str("anullsrc=r=44100:cl=stereo[amixed];");
    } else if amix_labels.len() == 1 {
        let single = amix_labels[0].clone();
        filter_complex = filter_complex.replacen(&format!("{};", single), "[amixed];", 1);
    } else {
        for label in &amix_labels {
            filter_complex.push_str(label);
        }
        filter_complex.push_str(&format!("amix=inputs={}:duration=longest[amixed];", amix_labels.len()));
    }

    // 範囲指定があれば 0..range_dur に揃える（入力シーク済みなので開始は概ね0、終端を確定させる）
    let mut a_label = "[amixed]".to_string();
    if use_trim {
        filter_complex.push_str(&format!(
            "[amixed]atrim=start=0:end={:.3},asetpts=PTS-STARTPTS[atrim];", range_dur
        ));
        a_label = "[atrim]".to_string();
    }

    // マスターチャンネル処理（Web Audio: sum -> EQ -> pan -> comp -> fader(mono+volume) の順）
    // フェーダー(音量)はチェーンの最後。マスターコンプはプリフェーダー。
    if let Some(m) = &payload.master {
        let mut stages: Vec<String> = Vec::new();
        if m.eq_enabled {
            let eqf = build_eq_filter(&m.eq);
            if !eqf.is_empty() { stages.push(eqf); }
        }
        let pan = m.pan;
        if pan.abs() > 0.01 {
            let lg = if pan > 0.0 { 1.0 - pan } else { 1.0 };
            let rg = if pan < 0.0 { 1.0 + pan } else { 1.0 };
            stages.push(format!("pan=stereo|c0={:.2}*c0|c1={:.2}*c1", lg, rg));
        }
        if m.comp_enabled {
            if let Some(c) = &m.comp {
                stages.push(build_comp_filter(c));
            }
        }
        // モノ → 音量（フェーダー）をチェーン最後に
        if m.is_mono {
            stages.push("aformat=channel_layouts=mono".to_string());
        }
        if (m.volume - 1.0).abs() > 0.01 {
            stages.push(format!("volume={:.2}", m.volume));
        }
        if !stages.is_empty() {
            filter_complex.push_str(&format!("{}{}[amaster];", a_label, stages.join(",")));
            a_label = "[amaster]".to_string();
        }
    }

    // ラウドネス正規化（loudnorm は内部で 192kHz 出力になり AAC が開けないため、出力側 -ar で 48kHz に戻す）
    if payload.settings.loudnorm {
        filter_complex.push_str(&format!("{}loudnorm=I=-14:LRA=11:TP=-1.0[aout]", a_label));
    } else if a_label != "[aout]" {
        // ラベルを [aout] に統一
        filter_complex.push_str(&format!("{}anull[aout]", a_label));
    }

    // 末尾のセミコロンを除去
    if filter_complex.ends_with(';') {
        filter_complex.pop();
    }

    // ────────────────────────────
    // 3.5. フェードイン・アウト（範囲指定時のみ。映像・音声とも既に 0 始まりに正規化済み）
    // ────────────────────────────
    let mut final_v_label = "[vout]".to_string();
    let mut final_a_label = "[aout]".to_string();

    if payload.settings.fade_in || payload.settings.fade_out {
        let fade_total = if use_trim { range_dur } else { total_duration as f32 };

        // ビデオフェードフィルタ
        let mut v_filters = Vec::new();
        if payload.settings.fade_in {
            v_filters.push(format!("fade=t=in:st=0:d={:.3}", payload.settings.fade_in_duration));
        }
        if payload.settings.fade_out {
            let fo_start = (fade_total - payload.settings.fade_out_duration).max(0.0);
            v_filters.push(format!("fade=t=out:st={:.3}:d={:.3}", fo_start, payload.settings.fade_out_duration));
        }
        if !v_filters.is_empty() {
            if !filter_complex.is_empty() && !filter_complex.ends_with(';') {
                filter_complex.push(';');
            }
            filter_complex.push_str(&format!("{}{}[vout_faded]", final_v_label, v_filters.join(",")));
            final_v_label = "[vout_faded]".to_string();
        }

        // オーディオフェードフィルタ
        let mut a_filters = Vec::new();
        if payload.settings.fade_in {
            a_filters.push(format!("afade=t=in:st=0:d={:.3}", payload.settings.fade_in_duration));
        }
        if payload.settings.fade_out {
            let fo_start = (fade_total - payload.settings.fade_out_duration).max(0.0);
            a_filters.push(format!("afade=t=out:st={:.3}:d={:.3}", fo_start, payload.settings.fade_out_duration));
        }
        if !a_filters.is_empty() {
            if !filter_complex.is_empty() && !filter_complex.ends_with(';') {
                filter_complex.push(';');
            }
            filter_complex.push_str(&format!("{}{}[aout_faded]", final_a_label, a_filters.join(",")));
            final_a_label = "[aout_faded]".to_string();
        }
    }

    args.push("-filter_complex".to_string());
    args.push(filter_complex);
    
    args.push("-map".to_string());
    args.push(final_v_label);
    args.push("-map".to_string());
    args.push(final_a_label);
    
    // ────────────────────────────
    // 4. エンコーダ設定
    // ────────────────────────────
    // 注: 解像度はフィルタグラフ内の scale で統一済みのため、出力側 -s は付けない
    //     （-s を付けると自動スケーラが再挿入され yuv444p 等になり互換性を損なうことがある）。
    //
    // base_args（入力・フィルタ・map まで）にエンコーダ依存の引数を足して完全なコマンドを作る。
    // ハードウェアエンコーダ失敗時に libx264 で再構築・再試行できるよう、生成をクロージャ化する。
    let base_args = args;
    let make_args = |encoder: &str| -> Vec<String> {
        let mut a = base_args.clone();
        a.push("-c:v".to_string());
        let codec = match encoder {
            "nvenc" | "h264_nvenc" => "h264_nvenc",
            "hevc_nvenc" => "hevc_nvenc",
            "h264_qsv" | "qsv" => "h264_qsv",
            "h264_amf" | "amf" => "h264_amf",
            "libx265" => "libx265",
            _ => "libx264",
        };
        a.push(codec.to_string());
        let is_nvenc = matches!(codec, "h264_nvenc" | "hevc_nvenc");

        // 出力ピクセルフォーマットを yuv420p に固定（互換性。xfade 後の 4:4:4 化を防ぐ）
        a.push("-pix_fmt".to_string());
        a.push("yuv420p".to_string());

        // レート制御
        match payload.settings.rate_control.as_str() {
            "crf" => {
                let crf = payload.settings.crf_value.unwrap_or(18);
                if is_nvenc {
                    a.push("-rc".to_string()); a.push("constqp".to_string());
                    a.push("-qp".to_string()); a.push(crf.to_string());
                } else {
                    a.push("-crf".to_string()); a.push(crf.to_string());
                    a.push("-preset".to_string()); a.push("slow".to_string());
                }
            }
            "vbr" => {
                if is_nvenc { a.push("-rc".to_string()); a.push("vbr".to_string()); }
                if let Some(ref br) = payload.settings.bitrate {
                    a.push("-b:v".to_string()); a.push(br.clone());
                }
                if let Some(ref mr) = payload.settings.maxrate {
                    a.push("-maxrate".to_string()); a.push(mr.clone());
                    a.push("-bufsize".to_string()); a.push(bufsize_2x(mr));
                }
            }
            _ => { // cbr (デフォルト)
                if is_nvenc { a.push("-rc".to_string()); a.push("cbr".to_string()); }
                let br = payload.settings.bitrate.as_deref().unwrap_or("8M");
                a.push("-b:v".to_string()); a.push(br.to_string());
                a.push("-maxrate".to_string()); a.push(br.to_string());
                a.push("-bufsize".to_string()); a.push(bufsize_2x(br));
            }
        }

        // 音声: AAC は loudnorm の 192kHz 出力を扱えないため -ar 48000 を付ける。ALAC(可逆)は元レート維持。
        match payload.settings.audio_quality.as_deref() {
            Some("high") => {
                a.push("-c:a".into()); a.push("aac".into());
                a.push("-b:a".into()); a.push("384k".into());
                a.push("-ar".into()); a.push("48000".into());
            }
            Some("lossless") => {
                a.push("-c:a".into()); a.push("alac".into());
            }
            _ => {
                a.push("-c:a".into()); a.push("aac".into());
                a.push("-b:a".into()); a.push("256k".into());
                a.push("-ar".into()); a.push("48000".into());
            }
        }

        // 進捗パース用に -progress pipe:1、最後に出力パス
        a.push("-progress".to_string());
        a.push("pipe:1".to_string());
        a.push(payload.settings.output_path.clone());
        a
    };

    // ────────────────────────────
    // デバッグログ: 実際の FFmpeg コマンド全体と stderr 全文を保存する。
    //   出力先と同じフォルダに <出力名>.export.log として書き出す。
    // ────────────────────────────
    let log_path = {
        let out = Path::new(&payload.settings.output_path);
        let stem = out.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
        let parent = out.parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir);
        parent.join(format!("{}.export.log", stem))
    };

    // 進捗計算用の総時間。範囲指定がある場合はその区間長に合わせる。
    let mut total_duration = total_duration;
    let p_start = payload.settings.start_time.unwrap_or(0.0) as f64;
    let p_end = payload.settings.end_time.map(|t| t as f64).unwrap_or(total_duration);
    if p_end > p_start {
        total_duration = p_end - p_start;
    }

    // 1回分の FFmpeg 実行（ログ記録・進捗転送・stderr吸い出し・0KB検出を含む）。
    // 戻り値: Ok=成功 / Err(None)=ユーザーキャンセル / Err(Some(tail))=失敗(stderr末尾)
    let run_attempt = |args: &[String], retry_label: Option<&str>| -> Result<(), Option<String>> {
        use std::io::Write;
        // ログにコマンドを記録（初回は新規作成、再試行は追記）
        let quoted_cmd = std::iter::once(format!("\"{}\"", ffmpeg))
            .chain(args.iter().map(|a| format!("\"{}\"", a)))
            .collect::<Vec<_>>()
            .join(" ");
        if let Some(label) = retry_label {
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&log_path) {
                let _ = write!(f, "\n\n=== {} で再試行 コマンド ===\n{}\n\n=== FFmpeg 出力 (stderr) ===\n", label, quoted_cmd);
            }
        } else {
            let _ = std::fs::write(
                &log_path,
                format!("=== FFmpeg コマンド ===\n{}\n\n=== FFmpeg 出力 (stderr) ===\n", quoted_cmd),
            );
        }

        EXPORT_CANCEL.store(false, Ordering::SeqCst);
        let _ = app_handle.emit("export-status", "FFmpegプロセスを起動中...");
        let mut child = match new_command(&ffmpeg)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return Err(Some(format!("FFmpegの実行に失敗しました: {}", e))),
        };

        let child_pid = child.id();
        EXPORT_PID.store(child_pid, Ordering::SeqCst);
        let _ = app_handle.emit("export-status", format!("FFmpegプロセス起動完了 (PID {}). 初期化中...", child_pid));

        // stderr を別スレッドで1行ずつ読み出し、診断のためフロントへ転送＋ログに追記。
        // 読まないと stderr パイプバッファ(約64KB)が一杯で FFmpeg がブロックしデッドロックする。
        let stderr_handle = child.stderr.take().map(|stderr| {
            let app_handle = app_handle.clone();
            let log_path = log_path.clone();
            std::thread::spawn(move || {
                let mut log_file = std::fs::OpenOptions::new().append(true).open(&log_path).ok();
                let mut buf = String::new();
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            let _ = app_handle.emit("export-status", format!("FFmpeg: {}", l));
                            if let Some(ref mut f) = log_file {
                                let _ = writeln!(f, "{}", l);
                            }
                            buf.push_str(&l);
                            buf.push('\n');
                        }
                        Err(_) => break,
                    }
                }
                buf
            })
        });

        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);
        let mut received_any_line = false;
        for line in reader.lines() {
            let line = line.unwrap_or_default();
            if !received_any_line {
                received_any_line = true;
                let _ = app_handle.emit("export-status", "エンコード中... 0%");
            }
            if line.starts_with("out_time_us=") {
                if let Ok(us) = line.trim_start_matches("out_time_us=").parse::<f64>() {
                    let current_secs = us / 1_000_000.0;
                    if total_duration > 0.0 {
                        let pct = (current_secs / total_duration * 100.0).min(99.0);
                        let _ = app_handle.emit("export-progress", pct as i32);
                    }
                }
            }
        }

        let status = match child.wait() {
            Ok(s) => s,
            Err(e) => return Err(Some(format!("FFmpeg wait error: {}", e))),
        };
        EXPORT_PID.store(0, Ordering::SeqCst);
        let stderr_output = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&log_path) {
            let _ = writeln!(f, "\n=== 終了ステータス ===\nexit code: {:?}", status.code());
        }

        let tail = || {
            let all: Vec<&str> = stderr_output.lines().collect();
            let s = all.len().saturating_sub(12);
            all[s..].join("\n")
        };

        if !status.success() {
            // ユーザーキャンセルで kill した場合は None を返す
            if EXPORT_CANCEL.swap(false, Ordering::SeqCst) {
                return Err(None);
            }
            return Err(Some(tail()));
        }
        // 終了コード0でも 0KB なら失敗扱い
        let out_size = std::fs::metadata(&payload.settings.output_path).map(|m| m.len()).unwrap_or(0);
        if out_size == 0 {
            return Err(Some(format!("出力ファイルが空（0KB）です。\n{}", tail())));
        }
        Ok(())
    };

    // ────────────────────────────
    // 5. エンコーダ決定 → 実行（HWエンコーダ失敗時は libx264 へ自動フォールバック）
    // ────────────────────────────
    let resolved_encoder = if payload.settings.encoder == "auto" {
        let _ = app_handle.emit("export-status", "エンコーダーを検出中...");
        detect_best_encoder(&ffmpeg)
    } else {
        payload.settings.encoder.clone()
    };
    let is_hw = matches!(
        resolved_encoder.as_str(),
        "nvenc" | "h264_nvenc" | "hevc_nvenc" | "h264_qsv" | "qsv" | "h264_amf" | "amf"
    );
    let _ = app_handle.emit("export-status", format!("ログ: {}", log_path.display()));

    // 成功時はログファイルを削除する（出力フォルダを汚さない）。失敗時のみ診断用に残し、
    // エラー画面からパスを参照できるようにする。
    match run_attempt(&make_args(&resolved_encoder), None) {
        Ok(()) => {
            let _ = std::fs::remove_file(&log_path);
            let _ = app_handle.emit("export-progress", 100);
            Ok(())
        }
        Err(None) => {
            let _ = std::fs::remove_file(&log_path);
            Err("EXPORT_CANCELLED".to_string())
        }
        Err(Some(tail)) => {
            // ハードウェアエンコーダで失敗した場合のみ libx264(CPU) で1回だけ再試行
            if is_hw {
                let _ = app_handle.emit(
                    "export-status",
                    "ハードウェアエンコードに失敗したため、CPU(libx264)で再試行します...",
                );
                match run_attempt(&make_args("libx264"), Some("libx264")) {
                    Ok(()) => {
                        let _ = std::fs::remove_file(&log_path);
                        let _ = app_handle.emit("export-progress", 100);
                        Ok(())
                    }
                    Err(None) => {
                        let _ = std::fs::remove_file(&log_path);
                        Err("EXPORT_CANCELLED".to_string())
                    }
                    Err(Some(tail2)) => Err(format!(
                        "FFmpegのエンコードに失敗しました（ハードウェア・CPU 両方）。\n{}\n\n詳細ログ: {}",
                        tail2, log_path.display()
                    )),
                }
            } else {
                Err(format!(
                    "FFmpegのエンコードに失敗しました。\n{}\n\n詳細ログ: {}",
                    tail, log_path.display()
                ))
            }
        }
    }
}

/// 実行中のエクスポート（FFmpeg プロセス）をキャンセルする
#[tauri::command]
fn cancel_export() {
    EXPORT_CANCEL.store(true, Ordering::SeqCst);
    let pid = EXPORT_PID.load(Ordering::SeqCst);
    if pid != 0 {
        // Windows: プロセスツリーごと強制終了する
        let _ = new_command("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }
}

/// ColorState からビデオフィルタ文字列を生成する（colorbalance + eq）。
/// 効果がない場合は None を返す。エクスポートと静止画書き出しで共有する。
fn color_filter_string(cs: &ColorStatePayload) -> Option<String> {
    let t = cs.temperature / 200.0;
    let tint = cs.tint / 200.0;
    let rm = (t + tint).clamp(-1.0, 1.0);
    let gm = (t / 2.0 - tint).clamp(-1.0, 1.0);
    let bm = (-t + tint).clamp(-1.0, 1.0);
    let br = cs.exposure / 200.0;
    let co = 1.0 + (cs.contrast / 100.0);

    let mut parts = Vec::new();
    if rm.abs() > 0.001 || gm.abs() > 0.001 || bm.abs() > 0.001 {
        parts.push(format!("colorbalance=rm={:.3}:gm={:.3}:bm={:.3}", rm, gm, bm));
    }
    if br.abs() > 0.001 || (co - 1.0).abs() > 0.001 {
        parts.push(format!("eq=brightness={:.3}:contrast={:.3}", br, co));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// 現在フレームを静止画として書き出す（元動画から1フレーム抽出＋カラーグレーディング適用）。
/// 出力形式は output_path の拡張子（.png / .jpg）で決まる。
#[tauri::command]
async fn export_frame(
    app_handle: tauri::AppHandle,
    source_path: String,
    time_seconds: f32,
    color: Option<ColorStatePayload>,
    output_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = find_ffmpeg(&app_handle);
        let local = time_seconds.max(0.0);

        let mut args: Vec<String> = vec![
            "-y".to_string(),
            "-ss".to_string(),
            format!("{:.3}", local),
            "-i".to_string(),
            source_path.clone(),
        ];

        if let Some(ref cs) = color {
            if let Some(vf) = color_filter_string(cs) {
                args.push("-vf".to_string());
                args.push(vf);
            }
        }

        args.push("-frames:v".to_string());
        args.push("1".to_string());
        // JPEG の場合は高画質に
        if output_path.to_lowercase().ends_with(".jpg") || output_path.to_lowercase().ends_with(".jpeg") {
            args.push("-q:v".to_string());
            args.push("2".to_string());
        }
        args.push(output_path.clone());

        let output = new_command(&ffmpeg)
            .args(&args)
            .output()
            .map_err(|e| format!("FFmpegの実行に失敗しました: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    })
    .await
    .map_err(|e| format!("タスクの実行に失敗しました: {}", e))?
}

/// 指定ファイルをエクスプローラーで表示する（ファイルを選択状態でフォルダを開く）
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("ファイルが見つかりません".to_string());
    }
    // explorer /select,<path> はファイルを選択した状態でフォルダを開く。
    // 成功時でも終了コードが 0 にならないことがあるため spawn のみ（status は見ない）。
    new_command("explorer")
        .arg(format!("/select,{}", path))
        .spawn()
        .map_err(|e| format!("フォルダを開けませんでした: {}", e))?;
    Ok(())
}

/// ffmpeg 自身を使って動画の長さ（秒）を取得するヘルパー
/// （ffprobe を別途同梱せずに済むよう、ffmpeg -i の stderr から "Duration:" をパースする）
fn get_media_duration(ffmpeg_path: &str, file_path: &str) -> Option<f64> {
    // 出力先を指定せずに `ffmpeg -i <file>` を実行すると、
    // メディア情報を stderr に出力した上で「出力ファイル未指定」エラーで終了する。
    // 終了コードは非ゼロになるが、Duration はこの stderr から取得できる。
    let output = new_command(ffmpeg_path)
        .args(["-i", file_path])
        .output()
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    // 例: "  Duration: 00:01:23.45, start: 0.000000, bitrate: ..."
    for line in stderr.lines() {
        if let Some(idx) = line.find("Duration:") {
            let rest = &line[idx + "Duration:".len()..];
            let dur_str = rest.trim().split(',').next()?.trim();
            if dur_str.eq_ignore_ascii_case("N/A") {
                return None;
            }
            let parts: Vec<&str> = dur_str.split(':').collect();
            if parts.len() == 3 {
                let h = parts[0].trim().parse::<f64>().ok()?;
                let m = parts[1].trim().parse::<f64>().ok()?;
                let s = parts[2].trim().parse::<f64>().ok()?;
                return Some(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    None
}

// ─────────────────────────────────────────────
// プロジェクトファイルの保存・読込
// ─────────────────────────────────────────────
#[tauri::command]
async fn save_project_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_project_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 指定されたパスのうち、実在しないものだけを返す（プロジェクトの可搬性チェック用）
#[tauri::command]
fn check_missing_files(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| !Path::new(p).exists())
        .collect()
}

// ─────────────────────────────────────────────
// アプリ起動
// ─────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      extract_audio,
      extract_playback_audio,
      read_pcm_range,
      generate_waveform,
      calculate_sync_offset,
      export_video,
      save_project_file,
      load_project_file,
      check_missing_files,
      cancel_export,
      reveal_in_explorer,
      export_frame
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
