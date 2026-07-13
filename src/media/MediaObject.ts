/**
 * 媒体库对象类型定义
 * 与 schema.sql media_items / media_scan_paths 表对应
 */

// ────────────────────────────────────────────────────────────
// 枚举 & 常量
// ────────────────────────────────────────────────────────────

export type MediaType = 'video' | 'music' | 'image' | 'book';

export const MEDIA_EXTENSIONS: Record<MediaType, string[]> = {
    video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v', 'rmvb', 'rm', '3gp', 'mpg', 'mpeg'],
    music: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'wma', 'ape', 'alac', 'm4a', 'opus', 'aiff'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'heic', 'heif', 'avif'],
    book:  ['pdf', 'epub', 'mobi', 'azw3', 'djvu', 'cbr', 'cbz', 'fb2', 'txt', 'docx'],
};

/** 根据文件名推断媒体类型，匹配失败返回 null */
export function detectMediaType(fileName: string): MediaType | null {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    for (const [type, exts] of Object.entries(MEDIA_EXTENSIONS) as [MediaType, string[]][]) {
        if (exts.includes(ext)) return type;
    }
    return null;
}

// ────────────────────────────────────────────────────────────
// 数据库行模型
// ────────────────────────────────────────────────────────────

/** media_scan_paths 表行 */
export interface ScanPath {
    id?: number;
    media_type: MediaType;
    scan_path: string;
    is_enabled: number;       // 1 = 启用，0 = 禁用
    scan_depth: number;       // 最大递归深度，默认 5
    last_scan?: string;       // ISO8601
    item_count?: number;
}

/** media_items 表行 */
export interface MediaItem {
    id?: number;
    media_type: MediaType;
    scan_path_id: number;
    file_name: string;
    file_path: string;
    file_size?: number;
    mime_type?: string;
    // 刮削元数据
    scraped_name?: string;
    cover?: string;
    description?: string;
    release_date?: string;
    rating?: number;
    genre?: string;
    // 音乐专属
    album_name?: string;
    album_artist?: string;
    track_number?: number;
    duration?: number;
    lyrics?: string;
    // 视频专属
    video_type?: 'movie' | 'tv';
    season?: number;
    episode?: number;
    // 状态
    is_scraped?: number;      // 0 = 未刮削，1 = 已刮削
    scrape_source?: string;   // tmdb / itunes / openlibrary / none
    external_id?: string;
    created_at: string;
    updated_at: string;
}

// ────────────────────────────────────────────────────────────
// 刮削引擎返回类型
// ────────────────────────────────────────────────────────────

export interface ScrapeResult {
    success: boolean;
    source?: string;
    external_id?: string;
    scraped_name?: string;
    cover?: string;
    description?: string;
    release_date?: string;
    rating?: number;
    genre?: string;
    // 音乐
    album_name?: string;
    album_artist?: string;
    track_number?: number;
    duration?: number;
    // 视频
    video_type?: 'movie' | 'tv';
    season?: number;
    episode?: number;
}

// ────────────────────────────────────────────────────────────
// API 响应 & 操作结果
// ────────────────────────────────────────────────────────────

export interface MediaResult<T = any> {
    flag: boolean;
    text: string;
    data?: T;
}

/** 扫描进度（存在 KV 中） */
export interface ScanProgress {
    status: 'idle' | 'running' | 'done' | 'error';
    scan_path_id?: number;
    total_found: number;
    total_new: number;
    current_dir: string;
    started_at?: string;
    finished_at?: string;
    error?: string;
}

/** 分页媒体列表（与 Go 后端 PageData 格式一致：content + total） */
export interface MediaPage {
    content: MediaItem[];
    total: number;
    page: number;
    page_size: number;
}

/** 专辑聚合（音乐用） */
export interface AlbumGroup {
    album_name: string;
    album_artist: string;
    cover: string;
    track_count: number;
    tracks: MediaItem[];
}
