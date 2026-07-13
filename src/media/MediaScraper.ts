/**
 * 媒体刮削引擎
 *
 * 视频  → TMDB API（需要在 wrangler.jsonc vars 中配置 TMDB_API_KEY）
 *           若未配置，降级使用文件名解析
 * 音乐  → iTunes Search API（免费，无需 key）
 * 书籍  → Open Library API（免费，无需 key）
 * 图片  → 不刮削（直接使用网盘缩略图）
 *
 * CF Workers 兼容：全部使用全局 fetch()，无 Node.js 依赖
 */
import type { Context } from 'hono';
import type { MediaType, ScrapeResult } from './MediaObject';

const FETCH_TIMEOUT = 8000; // 8 秒超时，保证在 Worker 30s 限制内完成

/** 带超时的 fetch */
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

/** 从文件名中提取查询关键词（去掉扩展名、年份、分辨率等噪音） */
function cleanFileName(fileName: string): string {
    return fileName
        .replace(/\.\w{2,5}$/, '')              // 去扩展名
        .replace(/\b(19|20)\d{2}\b/g, '')        // 去年份
        .replace(/\b(1080p|720p|4K|BluRay|WEBRip|HEVC|x264|x265|HDR)\b/gi, '')
        .replace(/[\._\-]+/g, ' ')               // 下划线/点/横线转空格
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// ────────────────────────────────────────────────────────────
// 视频刮削：TMDB
// ────────────────────────────────────────────────────────────

async function scrapeVideo(fileName: string, tmdbApiKey: string): Promise<ScrapeResult> {
    const query = encodeURIComponent(cleanFileName(fileName));
    // 先尝试电影搜索
    const movieUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&query=${query}&language=zh-CN`;
    const tvUrl    = `https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&query=${query}&language=zh-CN`;

    try {
        const movieRes = await fetchWithTimeout(movieUrl);
        if (movieRes.ok) {
            const data: any = await movieRes.json();
            const item = data.results?.[0];
            if (item) {
                return {
                    success: true,
                    source: 'tmdb',
                    external_id: String(item.id),
                    scraped_name: item.title || item.original_title,
                    cover: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
                    description: item.overview,
                    release_date: item.release_date,
                    rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : 0,
                    genre: item.genre_ids?.join(','),
                    video_type: 'movie',
                };
            }
        }
        // 再尝试电视剧
        const tvRes = await fetchWithTimeout(tvUrl);
        if (tvRes.ok) {
            const data: any = await tvRes.json();
            const item = data.results?.[0];
            if (item) {
                return {
                    success: true,
                    source: 'tmdb',
                    external_id: String(item.id),
                    scraped_name: item.name || item.original_name,
                    cover: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
                    description: item.overview,
                    release_date: item.first_air_date,
                    rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : 0,
                    video_type: 'tv',
                };
            }
        }
    } catch { /* 网络超时或 API 错误，回退到仅文件名 */ }

    return { success: false };
}

// ────────────────────────────────────────────────────────────
// 音乐刮削：iTunes Search API（免费）
// ────────────────────────────────────────────────────────────

async function scrapeMusic(fileName: string): Promise<ScrapeResult> {
    const query = encodeURIComponent(cleanFileName(fileName));
    const url = `https://itunes.apple.com/search?term=${query}&media=music&limit=1&lang=zh_cn`;

    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return { success: false };
        const data: any = await res.json();
        const item = data.results?.[0];
        if (!item) return { success: false };

        return {
            success: true,
            source: 'itunes',
            external_id: String(item.trackId),
            scraped_name: item.trackName,
            cover: item.artworkUrl100?.replace('100x100bb', '500x500bb'), // 高分辨率封面
            description: item.longDescription || item.shortDescription,
            release_date: item.releaseDate?.substring(0, 10),
            rating: 0,
            genre: item.primaryGenreName,
            album_name: item.collectionName,
            album_artist: item.artistName,
            track_number: item.trackNumber,
            duration: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : undefined,
        };
    } catch {
        return { success: false };
    }
}

// ────────────────────────────────────────────────────────────
// 书籍刮削：Open Library API（免费）
// ────────────────────────────────────────────────────────────

async function scrapeBook(fileName: string): Promise<ScrapeResult> {
    const query = encodeURIComponent(cleanFileName(fileName));
    const url = `https://openlibrary.org/search.json?q=${query}&limit=1&fields=key,title,author_name,first_publish_year,subject,cover_i`;

    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return { success: false };
        const data: any = await res.json();
        const item = data.docs?.[0];
        if (!item) return { success: false };

        return {
            success: true,
            source: 'openlibrary',
            external_id: item.key?.replace('/works/', '') || '',
            scraped_name: item.title,
            cover: item.cover_i
                ? `https://covers.openlibrary.org/b/id/${item.cover_i}-L.jpg`
                : undefined,
            description: item.author_name?.join(', '),
            release_date: item.first_publish_year ? `${item.first_publish_year}-01-01` : undefined,
            genre: item.subject?.slice(0, 3).join(', '),
        };
    } catch {
        return { success: false };
    }
}

// ────────────────────────────────────────────────────────────
// 统一入口
// ────────────────────────────────────────────────────────────

export class MediaScraper {
    private tmdbApiKey: string;

    constructor(c: Context) {
        this.tmdbApiKey = (c.env as any)?.TMDB_API_KEY || '';
    }

    /**
     * 对单个文件执行刮削
     * @param mediaType  媒体类型
     * @param fileName   文件名（含扩展名）
     */
    async scrape(mediaType: MediaType, fileName: string): Promise<ScrapeResult> {
        switch (mediaType) {
            case 'video':
                if (!this.tmdbApiKey) {
                    // 未配置 TMDB key，返回"未刮削但不报错"
                    return { success: false, source: 'no_tmdb_key' };
                }
                return scrapeVideo(fileName, this.tmdbApiKey);

            case 'music':
                return scrapeMusic(fileName);

            case 'book':
                return scrapeBook(fileName);

            case 'image':
                // 图片不需要刮削，直接标记成功（使用网盘缩略图）
                return { success: true, source: 'thumbnail' };

            default:
                return { success: false };
        }
    }

    /** 批量刮削（用于 /api/admin/media/scrape/start，一次最多处理 N 条） */
    async scratchBatch(
        items: Array<{ id: number; media_type: MediaType; file_name: string }>,
        batchSize = 10,
    ): Promise<Array<{ id: number; result: ScrapeResult }>> {
        const out: Array<{ id: number; result: ScrapeResult }> = [];
        for (let i = 0; i < Math.min(items.length, batchSize); i++) {
            const item = items[i];
            const result = await this.scrape(item.media_type, item.file_name);
            out.push({ id: item.id, result });
        }
        return out;
    }
}
