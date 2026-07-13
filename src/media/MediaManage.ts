/**
 * 媒体库管理服务（重写版）
 *
 * 核心改进（相比旧版）：
 *   1. 扫描结果持久化到 D1（media_items 表），不再实时扫描
 *   2. 增量扫描：只插入新文件，不重复入库
 *   3. 扫描进度写入 KV，前端可轮询
 *   4. 集成 MediaScraper，支持按批刮削
 *   5. 查询基于 D1，毫秒级响应
 */
import { Context } from 'hono';
import { MountManage } from '../mount/MountManage';
import { SavesManage } from '../saves/SavesManage';
import { MediaScraper } from './MediaScraper';
import {
    MediaType, MediaItem, ScanPath, ScanProgress, MediaPage,
    AlbumGroup, MediaResult, MEDIA_EXTENSIONS, detectMediaType,
} from './MediaObject';

// KV 中扫描进度的键前缀
const SCAN_PROGRESS_KEY = 'media_scan_progress';

// ────────────────────────────────────────────────────────────
// 辅助：直接操作 D1（SavesManage 抽象层过于高层，这里直接用 D1）
// ────────────────────────────────────────────────────────────

function getD1(c: Context): any {
    return (c.env as any)?.D1_DATA;
}

async function d1Run(c: Context, sql: string, params: any[] = []): Promise<any> {
    const db = getD1(c);
    if (!db) throw new Error('D1_DATA 未绑定');
    return db.prepare(sql).bind(...params).run();
}

async function d1All(c: Context, sql: string, params: any[] = []): Promise<any[]> {
    const db = getD1(c);
    if (!db) return [];
    const result = await db.prepare(sql).bind(...params).all();
    return result?.results || [];
}

async function d1First(c: Context, sql: string, params: any[] = []): Promise<any> {
    const db = getD1(c);
    if (!db) return null;
    return db.prepare(sql).bind(...params).first();
}

function now(): string {
    return new Date().toISOString();
}

// ────────────────────────────────────────────────────────────
// 主类
// ────────────────────────────────────────────────────────────

export class MediaManage {
    private c: Context;

    constructor(c: Context) {
        this.c = c;
    }

    // ════════════════════════════════════════════════════════
    // 扫描路径管理
    // ════════════════════════════════════════════════════════

    /** 获取所有扫描路径 */
    async listScanPaths(mediaType?: MediaType): Promise<MediaResult<ScanPath[]>> {
        try {
            const sql = mediaType
                ? `SELECT * FROM media_scan_paths WHERE media_type = ? ORDER BY id`
                : `SELECT * FROM media_scan_paths ORDER BY id`;
            const rows = await d1All(this.c, sql, mediaType ? [mediaType] : []);
            return { flag: true, text: 'ok', data: rows };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    /** 添加扫描路径 */
    async addScanPath(path: Omit<ScanPath, 'id'>): Promise<MediaResult<{ id: number }>> {
        try {
            const res = await d1Run(this.c,
                `INSERT INTO media_scan_paths (media_type, scan_path, is_enabled, scan_depth)
                 VALUES (?, ?, ?, ?)`,
                [path.media_type, path.scan_path, path.is_enabled ?? 1, path.scan_depth ?? 5]
            );
            return { flag: true, text: '添加成功', data: { id: res.meta?.last_row_id } };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    /** 删除扫描路径（同时删除其下所有条目） */
    async removeScanPath(id: number): Promise<MediaResult> {
        try {
            await d1Run(this.c, `DELETE FROM media_items WHERE scan_path_id = ?`, [id]);
            await d1Run(this.c, `DELETE FROM media_scan_paths WHERE id = ?`, [id]);
            return { flag: true, text: '删除成功' };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    // ════════════════════════════════════════════════════════
    // 扫描逻辑
    // ════════════════════════════════════════════════════════

    /** 读取当前扫描进度（从 KV） */
    async getScanProgress(): Promise<ScanProgress> {
        try {
            const kv = (this.c.env as any)?.KV_DATA;
            if (!kv) return { status: 'idle', total_found: 0, total_new: 0, current_dir: '' };
            const raw = await kv.get(SCAN_PROGRESS_KEY);
            return raw ? JSON.parse(raw) : { status: 'idle', total_found: 0, total_new: 0, current_dir: '' };
        } catch {
            return { status: 'idle', total_found: 0, total_new: 0, current_dir: '' };
        }
    }

    /** 写入扫描进度（到 KV，TTL 1 小时） */
    private async setScanProgress(progress: ScanProgress): Promise<void> {
        try {
            const kv = (this.c.env as any)?.KV_DATA;
            if (kv) await kv.put(SCAN_PROGRESS_KEY, JSON.stringify(progress), { expirationTtl: 3600 });
        } catch { /* 忽略 KV 错误 */ }
    }

    /**
     * 启动扫描指定路径（单个 ScanPath）
     * 注意：CF Workers 单次请求 30s 限制，大目录需多次调用或使用 ctx.waitUntil()
     */
    async scanPath(scanPathId: number): Promise<MediaResult<{ found: number; new_count: number }>> {
        // 读取扫描路径配置
        const pathRow: ScanPath | null = await d1First(this.c,
            `SELECT * FROM media_scan_paths WHERE id = ?`, [scanPathId]);
        if (!pathRow) return { flag: false, text: '扫描路径不存在' };

        const progress: ScanProgress = {
            status: 'running',
            scan_path_id: scanPathId,
            total_found: 0,
            total_new: 0,
            current_dir: pathRow.scan_path,
            started_at: now(),
        };
        await this.setScanProgress(progress);

        try {
            const files = await this.recursiveScan(
                pathRow.scan_path, pathRow.media_type, pathRow.scan_path,
                pathRow.scan_depth ?? 5, progress
            );

            // 批量插入（忽略已存在的 file_path）
            let newCount = 0;
            for (const file of files) {
                try {
                    await d1Run(this.c,
                        `INSERT OR IGNORE INTO media_items
                         (media_type, scan_path_id, file_name, file_path, file_size, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [file.media_type, scanPathId, file.file_name, file.file_path,
                         file.file_size ?? 0, now(), now()]
                    );
                    newCount++;
                } catch { /* file_path 冲突，跳过 */ }
            }

            // 更新 scan_path 的 last_scan 和 item_count
            const total: any = await d1First(this.c,
                `SELECT COUNT(*) as cnt FROM media_items WHERE scan_path_id = ?`, [scanPathId]);
            await d1Run(this.c,
                `UPDATE media_scan_paths SET last_scan = ?, item_count = ? WHERE id = ?`,
                [now(), total?.cnt ?? 0, scanPathId]
            );

            progress.status = 'done';
            progress.total_new = newCount;
            progress.finished_at = now();
            await this.setScanProgress(progress);

            return { flag: true, text: '扫描完成', data: { found: files.length, new_count: newCount } };
        } catch (e: any) {
            progress.status = 'error';
            progress.error = e.message;
            await this.setScanProgress(progress);
            return { flag: false, text: e.message };
        }
    }

    /** 递归扫描目录（挂载虚拟路径），收集媒体文件信息 */
    private async recursiveScan(
        rootPath: string, mediaType: MediaType, currentPath: string,
        depth: number, progress: ScanProgress
    ): Promise<Partial<MediaItem>[]> {
        if (depth <= 0) return [];
        const results: Partial<MediaItem>[] = [];

        try {
            progress.current_dir = currentPath;
            await this.setScanProgress(progress);

            const mountManage = new MountManage(this.c);
            const driveLoad = await mountManage.loader(currentPath, true, true);
            if (!driveLoad?.[0]) return results;

            const relative = currentPath.replace(driveLoad[0].router, '') || '/';
            const listing = await driveLoad[0].listFile({ path: relative });
            if (!listing?.fileList) return results;

            for (const file of listing.fileList) {
                const filePath = currentPath.replace(/\/$/, '') + '/' + file.fileName;
                if ((file as any).fileType === 0 || file.fileName.endsWith('/')) {
                    // 目录：递归
                    const sub = await this.recursiveScan(rootPath, mediaType, filePath, depth - 1, progress);
                    results.push(...sub);
                } else {
                    // 文件：判断是否属于目标媒体类型
                    const detected = detectMediaType(file.fileName);
                    if (detected === mediaType) {
                        progress.total_found++;
                        results.push({
                            media_type: mediaType,
                            file_name: file.fileName,
                            file_path: filePath,
                            file_size: (file as any).fileSize ?? 0,
                                                });
                    }
                }
            }
            return results;
        } catch {
            return results;
        }
    }

    // ════════════════════════════════════════════════════════
    // 刮削逻辑
    // ════════════════════════════════════════════════════════

    /**
     * 批量刮削（从 media_items 取未刮削的，每次最多 batchSize 条）
     * @returns 刮削成功数 / 失败数
     */
    async scrapeBatch(scanPathId?: number, batchSize = 10): Promise<MediaResult<{ ok: number; fail: number }>> {
        try {
            const sql = scanPathId
                ? `SELECT id, media_type, file_name FROM media_items WHERE is_scraped = 0 AND scan_path_id = ? LIMIT ?`
                : `SELECT id, media_type, file_name FROM media_items WHERE is_scraped = 0 LIMIT ?`;
            const rows = scanPathId
                ? await d1All(this.c, sql, [scanPathId, batchSize])
                : await d1All(this.c, sql, [batchSize]);

            const scraper = new MediaScraper(this.c);
            const results = await scraper.scratchBatch(rows, batchSize);

            let ok = 0, fail = 0;
            for (const { id, result } of results) {
                if (result.success) {
                    await d1Run(this.c,
                        `UPDATE media_items SET
                         scraped_name=?, cover=?, description=?, release_date=?,
                         rating=?, genre=?, album_name=?, album_artist=?,
                         track_number=?, duration=?, video_type=?, season=?, episode=?,
                         is_scraped=1, scrape_source=?, external_id=?, updated_at=?
                         WHERE id=?`,
                        [
                            result.scraped_name ?? null, result.cover ?? null,
                            result.description ?? null, result.release_date ?? null,
                            result.rating ?? 0, result.genre ?? null,
                            result.album_name ?? null, result.album_artist ?? null,
                            result.track_number ?? null, result.duration ?? null,
                            result.video_type ?? null, result.season ?? null,
                            result.episode ?? null,
                            result.source ?? 'unknown', result.external_id ?? null,
                            now(), id,
                        ]
                    );
                    ok++;
                } else {
                    // 标记为"已尝试但失败"，避免重复尝试
                    await d1Run(this.c,
                        `UPDATE media_items SET is_scraped=2, scrape_source=?, updated_at=? WHERE id=?`,
                        [result.source ?? 'failed', now(), id]
                    );
                    fail++;
                }
            }
            return { flag: true, text: `刮削完成：成功 ${ok} 条，失败 ${fail} 条`, data: { ok, fail } };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    // ════════════════════════════════════════════════════════
    // 查询接口（公开 API 用）
    // ════════════════════════════════════════════════════════

    /** 分页列出媒体条目 */
    async listItems(params: {
        media_type?: MediaType;
        scan_path_id?: number;
        keyword?: string;
        page?: number;
        page_size?: number;
        only_scraped?: boolean;
    }): Promise<MediaResult<MediaPage>> {
        const { media_type, scan_path_id, keyword, page = 1, page_size = 48, only_scraped } = params;
        try {
            const conditions: string[] = [];
            const values: any[] = [];

            if (media_type) { conditions.push(`media_type = ?`); values.push(media_type); }
            if (scan_path_id) { conditions.push(`scan_path_id = ?`); values.push(scan_path_id); }
            if (keyword?.trim()) {
                conditions.push(`(file_name LIKE ? OR scraped_name LIKE ?)`);
                values.push(`%${keyword}%`, `%${keyword}%`);
            }
            if (only_scraped) { conditions.push(`is_scraped = 1`); }

            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const countRow: any = await d1First(this.c,
                `SELECT COUNT(*) as cnt FROM media_items ${where}`, values);
            const total = countRow?.cnt ?? 0;

            const offset = (page - 1) * page_size;
            const rows = await d1All(this.c,
                `SELECT * FROM media_items ${where} ORDER BY scraped_name, file_name LIMIT ? OFFSET ?`,
                [...values, page_size, offset]
            );

            return { flag: true, text: 'ok', data: { content: rows, total, page, page_size } };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    /** 获取单条媒体详情 */
    async getItem(id: number): Promise<MediaResult<MediaItem>> {
        try {
            const row = await d1First(this.c, `SELECT * FROM media_items WHERE id = ?`, [id]);
            if (!row) return { flag: false, text: '条目不存在' };
            return { flag: true, text: 'ok', data: row };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    /** 获取专辑列表（音乐专属） */
    async listAlbums(scanPathId?: number): Promise<MediaResult<AlbumGroup[]>> {
        try {
            const sql = scanPathId
                ? `SELECT album_name, album_artist, cover, COUNT(*) as track_count
                   FROM media_items WHERE media_type='music' AND album_name IS NOT NULL AND scan_path_id=?
                   GROUP BY album_name, album_artist ORDER BY album_name`
                : `SELECT album_name, album_artist, cover, COUNT(*) as track_count
                   FROM media_items WHERE media_type='music' AND album_name IS NOT NULL
                   GROUP BY album_name, album_artist ORDER BY album_name`;
            const rows = await d1All(this.c, sql, scanPathId ? [scanPathId] : []);
            return { flag: true, text: 'ok', data: rows as any };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    /** 清空指定类型或全部媒体条目 */
    async clearItems(mediaType?: MediaType, scanPathId?: number): Promise<MediaResult> {
        try {
            if (scanPathId) {
                await d1Run(this.c, `DELETE FROM media_items WHERE scan_path_id = ?`, [scanPathId]);
            } else if (mediaType) {
                await d1Run(this.c, `DELETE FROM media_items WHERE media_type = ?`, [mediaType]);
            } else {
                await d1Run(this.c, `DELETE FROM media_items`, []);
            }
            return { flag: true, text: '清除成功' };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }

    /** 统计各类型数量 */
    async stats(): Promise<MediaResult<Record<MediaType, number>>> {
        try {
            const rows = await d1All(this.c,
                `SELECT media_type, COUNT(*) as cnt FROM media_items GROUP BY media_type`, []);
            const data: Record<string, number> = { video: 0, music: 0, image: 0, book: 0 };
            for (const r of rows) data[r.media_type] = r.cnt;
            return { flag: true, text: 'ok', data: data as any };
        } catch (e: any) {
            return { flag: false, text: e.message };
        }
    }
}
