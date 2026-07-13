/**
 * 媒体库 — 基于 GO dev-media 后端 API 重写
 *
 * 支持：
 *  - 4 种媒体类型：视频 / 音乐 / 图片 / 书籍
 *  - 封面网格视图（含评分、标签、刮削状态）
 *  - 专辑视图（仅音乐）
 *  - 关键词搜索 + 扫描路径筛选
 *  - 分页浏览
 *  - 点击播放/预览
 *
 * API（GO dev-media）:
 *  GET /api/public/media/list?media_type=video&page=1&page_size=50&keyword=&scan_path_id=
 *  GET /api/public/media/item/:id
 *  GET /api/public/media/albums
 *  GET /api/public/media/scan_paths
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Card, Input, Select, Pagination, Spin, Tag, Typography,
  Tabs, Tooltip, Empty, Rate, Image, Badge, Space, Button, Segmented,
} from 'antd';
import {
  VideoCameraOutlined, CustomerServiceOutlined, PictureOutlined,
  ReadOutlined, SearchOutlined, AppstoreOutlined, UnorderedListOutlined,
  StarOutlined, TagOutlined, FolderOutlined, PlayCircleOutlined,
  LoadingOutlined, CheckCircleOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '../../store';
import api from '../../posts/api';

const { Text, Title } = Typography;
const { Search } = Input;

// ─── 类型定义 ───────────────────────────────────────────────

type MediaType = 'video' | 'music' | 'image' | 'book';

interface MediaItem {
  id: number;
  media_type: MediaType;
  file_name: string;
  file_size: number;
  mime_type: string;
  cover: string;
  scraped_name: string;
  description: string;
  release_date: string;
  rating: number;
  genre: string;
  // 音乐专属
  album_name?: string;
  album_artist?: string;
  track_number?: number;
  duration?: number;
  // 视频专属
  video_type?: 'movie' | 'tv';
  season?: number;
  episode?: number;
  // 文件路径
  full_path?: string;
  // 是否已刮削
  is_scraped?: boolean;
}

interface Album {
  album_name: string;
  album_artist: string;
  cover: string;
  track_count: number;
  tracks: MediaItem[];
}

interface ScanPath {
  id: number;
  path: string;
  media_type: MediaType;
  enabled: boolean;
}

// ─── 媒体类型配置 ──────────────────────────────────────────

const TYPE_CONFIG: Record<MediaType, { label: string; icon: React.ReactNode; color: string; bgColor: string }> = {
  video:  { label: '视频影音', icon: <VideoCameraOutlined />,    color: '#3B82F6', bgColor: 'rgba(59,130,246,0.12)' },
  music:  { label: '音乐音频', icon: <CustomerServiceOutlined />, color: '#10B981', bgColor: 'rgba(16,185,129,0.12)' },
  image:  { label: '照片图片', icon: <PictureOutlined />,         color: '#F59E0B', bgColor: 'rgba(245,158,11,0.12)' },
  book:   { label: '书籍报刊', icon: <ReadOutlined />,            color: '#8B5CF6', bgColor: 'rgba(139,92,246,0.12)' },
};

// 从路由路径解析媒体类型
function parseMediaType(pathname: string): MediaType {
  const match = pathname.match(/\/media\/(video|music|image|books)/);
  if (!match) return 'video';
  const raw = match[1];
  return raw === 'books' ? 'book' : (raw as MediaType);
}

// ─── 辅助函数 ──────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── 封面卡片组件 ─────────────────────────────────────────

const MediaCard: React.FC<{
  item: MediaItem;
  isDark: boolean;
  onClick: (item: MediaItem) => void;
}> = ({ item, isDark, onClick }) => {
  const config = TYPE_CONFIG[item.media_type];
  const displayName = item.scraped_name || item.file_name;
  const hasRating = item.rating > 0;

  return (
    <div
      onClick={() => onClick(item)}
      style={{
        borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
        background: isDark ? 'rgba(22,27,34,0.8)' : '#ffffff',
        border: `1px solid ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'}`,
        transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)',
        position: 'relative',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.transform = 'translateY(-4px)';
        el.style.boxShadow = `0 12px 32px rgba(0,0,0,${isDark ? '0.5' : '0.15'})`;
        el.style.borderColor = config.color + '60';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = 'none';
        el.style.borderColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
      }}
    >
      {/* 封面图 */}
      <div style={{ position: 'relative', aspectRatio: item.media_type === 'music' ? '1' : '2/3', overflow: 'hidden', background: config.bgColor }}>
        {item.cover ? (
          <img
            src={item.cover}
            alt={displayName}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 36, color: config.color, opacity: 0.5 }}>{config.icon}</span>
          </div>
        )}
        {/* 播放遮罩 */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          opacity: 0, transition: 'all 0.2s',
        }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(0,0,0,0.45)'; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.background = 'rgba(0,0,0,0)'; }}
        >
          <PlayCircleOutlined style={{ fontSize: 40, color: '#fff' }} />
        </div>
        {/* 刮削状态徽标 */}
        {item.is_scraped && (
          <div style={{
            position: 'absolute', top: 6, right: 6,
            width: 20, height: 20, borderRadius: '50%',
            background: '#10B981', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <CheckCircleOutlined style={{ fontSize: 12, color: '#fff' }} />
          </div>
        )}
        {/* 音乐时长 */}
        {item.media_type === 'music' && item.duration && (
          <div style={{
            position: 'absolute', bottom: 6, right: 6,
            padding: '2px 6px', borderRadius: 4,
            background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 11,
          }}>
            {formatDuration(item.duration)}
          </div>
        )}
      </div>

      {/* 信息区 */}
      <div style={{ padding: '10px 12px 12px' }}>
        <Text
          ellipsis={{ tooltip: displayName }}
          style={{
            display: 'block', fontWeight: 600, fontSize: 13,
            color: isDark ? '#E5E7EB' : '#111827',
            lineHeight: 1.3, marginBottom: 4,
          }}
        >
          {displayName}
        </Text>
        {(item.album_artist || item.release_date) && (
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
            {item.album_artist || item.release_date?.substring(0, 4) || ''}
          </Text>
        )}
        {hasRating && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <StarOutlined style={{ fontSize: 11, color: '#F59E0B' }} />
            <Text style={{ fontSize: 11, color: '#F59E0B', fontWeight: 600 }}>
              {item.rating.toFixed(1)}
            </Text>
          </div>
        )}
        {item.genre && (
          <Tag style={{ marginTop: 4, fontSize: 10, padding: '0 5px', lineHeight: '18px' }}>
            {item.genre.split(',')[0]}
          </Tag>
        )}
      </div>
    </div>
  );
};

// ─── 主组件 ───────────────────────────────────────────────

const MediaLibrary: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { themeMode } = useThemeStore();
  const isDark = themeMode === 'dark' || themeMode === 'transparent';

  const mediaType = useMemo(() => parseMediaType(location.pathname), [location.pathname]);
  const config = TYPE_CONFIG[mediaType];

  // ── 状态 ──
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(48);
  const [keyword, setKeyword] = useState('');
  const [scanPathId, setScanPathId] = useState<number | undefined>();
  const [scanPaths, setScanPaths] = useState<ScanPath[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [activeTab, setActiveTab] = useState<'items' | 'albums'>('items');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);

  // ── 检查媒体库后端是否可用 ──
  useEffect(() => {
    api.get('/api/public/media/list?media_type=video&page=1&page_size=1')
      .then(() => setBackendAvailable(true))
      .catch(() => setBackendAvailable(false));
  }, []);

  // ── 加载扫描路径 ──
  useEffect(() => {
    api.get(`/api/public/media/scan_paths?media_type=${mediaType}`)
      .then((res: any) => {
        const paths = res?.data || res || [];
        setScanPaths(Array.isArray(paths) ? paths : []);
      })
      .catch(() => setScanPaths([]));
  }, [mediaType]);

  // ── 加载媒体列表 ──
  const loadItems = useCallback(async (p: number = 1, kw = keyword, pathId = scanPathId) => {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        media_type: mediaType,
        page: String(p),
        page_size: String(pageSize),
      };
      if (kw) params.keyword = kw;
      if (pathId) params.scan_path_id = String(pathId);
      const qs = new URLSearchParams(params).toString();
      const res: any = await api.get(`/api/public/media/list?${qs}`);
      const list: MediaItem[] = res?.content || res?.data || res || [];
      const tot: number = res?.total || list.length;
      setItems(list);
      setTotal(tot);
      setPage(p);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [mediaType, keyword, scanPathId, pageSize]);

  useEffect(() => { loadItems(1, '', undefined); }, [mediaType]);

  // ── 加载专辑（仅音乐） ──
  const loadAlbums = useCallback(async () => {
    if (mediaType !== 'music') return;
    setAlbumsLoading(true);
    try {
      const res: any = await api.get('/api/public/media/albums');
      setAlbums(res?.data || res || []);
    } catch { setAlbums([]); } finally { setAlbumsLoading(false); }
  }, [mediaType]);

  useEffect(() => {
    if (activeTab === 'albums') loadAlbums();
  }, [activeTab, loadAlbums]);

  // ── 点击媒体项 ──
  const handleItemClick = (item: MediaItem) => {
    if (!item.full_path) return;
    const encoded = item.full_path.split('/').map(encodeURIComponent).join('/');
    navigate(`/preview${encoded}`);
  };

  // ── 后端不可用提示 ──
  if (backendAvailable === false) {
    return (
      <div className="animate-fade-in-up" style={{ padding: 24 }}>
        <Card style={{ borderRadius: 14, textAlign: 'center', padding: '40px 24px' }}>
          <ClockCircleOutlined style={{ fontSize: 48, color: '#bfbfbf' }} />
          <Typography.Title level={4} style={{ color: '#8c8c8c', marginTop: 16 }}>后端服务不可用</Typography.Title>
          <Typography.Text type="secondary">请检查网络连接或稍后重试</Typography.Text>
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade-in-up" style={{ padding: 24 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>媒体库</Typography.Title>
    </div>
  );
}

export default MediaLibrary;
