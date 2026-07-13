/**
 * 媒体库管理页面（管理员）
 *
 * 功能：
 *  - 管理扫描路径（添加、删除、启用/禁用）
 *  - 手动触发扫描
 *  - 实时查看扫描进度
 *  - 批量刮削（调用外部 API 获取封面/元数据）
 *  - 数据统计
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Table, Button, Modal, Input, Select, Form, Space,
  Tag, Typography, Progress, Statistic, Row, Col, Tooltip,
  message, Popconfirm, Badge, Alert, Divider,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, PlayCircleOutlined,
  SyncOutlined, VideoCameraOutlined, CustomerServiceOutlined,
  PictureOutlined, ReadOutlined, FolderOutlined,
  CheckCircleOutlined, LoadingOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import api from '../../posts/api';
import type { ColumnsType } from 'antd/es/table';

const { Text, Title } = Typography;

type MediaType = 'video' | 'music' | 'image' | 'book';

interface ScanPath {
  id: number;
  media_type: MediaType;
  scan_path: string;
  is_enabled: number;
  scan_depth: number;
  last_scan?: string;
  item_count?: number;
}

interface ScanProgress {
  status: 'idle' | 'running' | 'done' | 'error';
  total_found: number;
  total_new: number;
  current_dir: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
}

interface MediaStats {
  video: number;
  music: number;
  image: number;
  book: number;
}

const MEDIA_LABELS: Record<MediaType, { label: string; icon: React.ReactNode; color: string }> = {
  video: { label: '视频影音', icon: <VideoCameraOutlined />, color: '#3B82F6' },
  music: { label: '音乐音频', icon: <CustomerServiceOutlined />, color: '#10B981' },
  image: { label: '照片图片', icon: <PictureOutlined />, color: '#F59E0B' },
  book:  { label: '书籍报刊', icon: <ReadOutlined />, color: '#8B5CF6' },
};

const AdminMediaLibrary: React.FC = () => {
  const [scanPaths, setScanPaths] = useState<ScanPath[]>([]);
  const [stats, setStats] = useState<MediaStats>({ video: 0, music: 0, image: 0, book: 0 });
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [progressPolling, setProgressPolling] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [selectedPathId, setSelectedPathId] = useState<number | null>(null);
  const [form] = Form.useForm();

  // 加载扫描路径列表
  const loadPaths = useCallback(async () => {
    try {
      const res: any = await api.get('/api/admin/media/scan_paths');
      setScanPaths(res?.data || res || []);
    } catch { setScanPaths([]); }
  }, []);

  // 加载统计
  const loadStats = useCallback(async () => {
    try {
      const res: any = await api.get('/api/public/media/stats');
      setStats({ video: 0, music: 0, image: 0, book: 0, ...(res?.data || res || {}) });
    } catch { /* 忽略 */ }
  }, []);

  // 拉取扫描进度
  const fetchProgress = useCallback(async () => {
    try {
      const res: any = await api.get('/api/admin/media/scan/progress');
      const prog: ScanProgress = res?.data || res;
      setProgress(prog);
      if (prog.status === 'running') return true; // 继续轮询
      // 扫描结束，刷新数据
      if (prog.status === 'done') { loadPaths(); loadStats(); }
      return false; // 停止轮询
    } catch { return false; }
  }, [loadPaths, loadStats]);

  useEffect(() => {
    loadPaths();
    loadStats();
    fetchProgress();
  }, [loadPaths, loadStats, fetchProgress]);

  // 轮询进度
  useEffect(() => {
    if (!progressPolling) return;
    const timer = setInterval(async () => {
      const shouldContinue = await fetchProgress();
      if (!shouldContinue) {
        setProgressPolling(false);
        clearInterval(timer);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [progressPolling, fetchProgress]);

  // 添加扫描路径
  const handleAdd = async () => {
    const values = await form.validateFields();
    setAddLoading(true);
    try {
      await api.post('/api/admin/media/scan_paths/add', {
        media_type: values.media_type,
        scan_path: values.scan_path,
        scan_depth: values.scan_depth ?? 5,
      });
      message.success('扫描路径添加成功');
      setAddOpen(false);
      form.resetFields();
      loadPaths();
    } catch (e: any) {
      message.error(e.message || '添加失败');
    } finally {
      setAddLoading(false);
    }
  };

  // 删除扫描路径
  const handleDelete = async (id: number) => {
    try {
      await api.post('/api/admin/media/scan_paths/remove', { id });
      message.success('删除成功');
      loadPaths();
      loadStats();
    } catch (e: any) { message.error(e.message); }
  };

  // 触发扫描
  const handleScan = async (pathId: number) => {
    try {
      setSelectedPathId(pathId);
      await api.post('/api/admin/media/scan/start', { scan_path_id: pathId });
      message.success('扫描已启动，正在后台运行');
      setProgressPolling(true);
      fetchProgress();
    } catch (e: any) { message.error(e.message); }
  };

  // 触发批量刮削
  const handleScrape = async (pathId?: number) => {
    setScrapeLoading(true);
    try {
      const res: any = await api.post('/api/admin/media/scrape/start', {
        scan_path_id: pathId,
        batch_size: 20,
      });
      const d = res?.data || res;
      message.success(`刮削完成：成功 ${d?.ok ?? 0} 条，失败 ${d?.fail ?? 0} 条`);
      loadStats();
    } catch (e: any) { message.error(e.message); }
    finally { setScrapeLoading(false); }
  };

  // 表格列
  const columns: ColumnsType<ScanPath> = [
    {
      title: '媒体类型', dataIndex: 'media_type', key: 'media_type', width: 110,
      render: (t: MediaType) => {
        const cfg = MEDIA_LABELS[t];
        return <Tag color={cfg?.color} icon={cfg?.icon} style={{ border: 'none' }}>{cfg?.label}</Tag>;
      },
    },
    {
      title: '扫描路径', dataIndex: 'scan_path', key: 'scan_path',
      render: (p: string) => (
        <Space><FolderOutlined style={{ color: '#6B7280' }} /><Text code style={{ fontSize: 12 }}>{p}</Text></Space>
      ),
    },
    {
      title: '深度', dataIndex: 'scan_depth', key: 'scan_depth', width: 70,
      render: (d: number) => <Text type="secondary">{d}</Text>,
    },
    {
      title: '文件数', dataIndex: 'item_count', key: 'item_count', width: 80,
      render: (n: number) => <Text strong>{n ?? 0}</Text>,
    },
    {
      title: '上次扫描', dataIndex: 'last_scan', key: 'last_scan', width: 160,
      render: (t: string) => t
        ? <Text type="secondary" style={{ fontSize: 12 }}>{new Date(t).toLocaleString()}</Text>
        : <Text type="secondary">从未扫描</Text>,
    },
    {
      title: '操作', key: 'action', width: 200,
      render: (_, record) => (
        <Space size={6}>
          <Button size="small" type="primary" icon={<PlayCircleOutlined />}
            onClick={() => handleScan(record.id)}
            loading={progressPolling && selectedPathId === record.id}>
            扫描
          </Button>
          <Button size="small" icon={<SyncOutlined />}
            onClick={() => handleScrape(record.id)}
            loading={scrapeLoading}>
            刮削
          </Button>
          <Popconfirm title="确认删除此扫描路径及其所有条目？" okType="danger"
            onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="animate-fade-in-up">
      {/* 统计卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {(Object.entries(MEDIA_LABELS) as [MediaType, any][]).map(([type, cfg]) => (
          <Col xs={12} sm={6} key={type}>
            <Card style={{ borderRadius: 12 }} styles={{ body: { padding: '16px 20px' } }}>
              <Statistic
                title={<span style={{ fontSize: 13 }}>{cfg.label}</span>}
                value={stats[type] ?? 0}
                prefix={<span style={{ color: cfg.color }}>{cfg.icon}</span>}
                valueStyle={{ fontSize: 24, fontWeight: 700 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* 扫描进度 */}
      {progress && progress.status === 'running' && (
        <Alert
          type="info"
          icon={<LoadingOutlined spin />}
          showIcon
          message={
            <div>
              <Text strong>扫描中...</Text>
              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                已发现 {progress.total_found} 个文件，新增 {progress.total_new} 个
              </Text>
              <br />
              <Text type="secondary" style={{ fontSize: 11 }}>当前目录：{progress.current_dir}</Text>
            </div>
          }
          style={{ marginBottom: 16, borderRadius: 10 }}
        />
      )}
      {progress && progress.status === 'done' && (
        <Alert type="success" showIcon
          message={`扫描完成：共发现 ${progress.total_found} 个文件，新增 ${progress.total_new} 个`}
          closable
          style={{ marginBottom: 16, borderRadius: 10 }}
          onClose={() => setProgress(null)}
        />
      )}
      {progress && progress.status === 'error' && (
        <Alert type="error" showIcon
          message={`扫描出错：${progress.error}`}
          closable style={{ marginBottom: 16, borderRadius: 10 }}
          onClose={() => setProgress(null)}
        />
      )}

      {/* 扫描路径管理 */}
      <Card
        title={
          <Space>
            <FolderOutlined />
            <span>扫描路径管理</span>
            <Badge count={scanPaths.length} style={{ backgroundColor: '#3B82F6' }} />
          </Space>
        }
        extra={
          <Space>
            <Tooltip title="对所有路径的未刮削条目进行批量刮削">
              <Button icon={<SyncOutlined />} loading={scrapeLoading}
                onClick={() => handleScrape()}>
                全局刮削
              </Button>
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />}
              onClick={() => setAddOpen(true)}
              style={{ background: 'linear-gradient(135deg,#3B82F6,#6366F1)', border: 'none' }}>
              添加路径
            </Button>
          </Space>
        }
        style={{ borderRadius: 12 }}
      >
        <Alert
          type="info" showIcon
          message={
            <Text style={{ fontSize: 12 }}>
              提示：视频刮削需配置 <Text code>TMDB_API_KEY</Text> 环境变量（在 wrangler.jsonc 的 vars 中）。
              音乐使用 iTunes API，书籍使用 Open Library API，均无需配置。
            </Text>
          }
          style={{ marginBottom: 16, borderRadius: 8 }}
        />
        <Table
          dataSource={scanPaths} columns={columns}
          rowKey="id" size="middle" pagination={false}
          locale={{ emptyText: '暂无扫描路径，点击"添加路径"开始配置' }}
        />
      </Card>

      {/* 添加路径对话框 */}
      <Modal
        title="添加扫描路径" open={addOpen}
        onOk={handleAdd} onCancel={() => { setAddOpen(false); form.resetFields(); }}
        okText="添加" cancelText="取消" confirmLoading={addLoading}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="media_type" label="媒体类型"
            rules={[{ required: true, message: '请选择媒体类型' }]}>
            <Select placeholder="选择媒体类型">
              {(Object.entries(MEDIA_LABELS) as [MediaType, any][]).map(([t, cfg]) => (
                <Select.Option key={t} value={t}>
                  <Space>{cfg.icon} {cfg.label}</Space>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="scan_path" label="扫描路径（虚拟挂载路径）"
            rules={[{ required: true, message: '请输入路径' }]}
            extra="例如：/movies 或 /music/库名，必须是已挂载的路径">
            <Input prefix={<FolderOutlined />} placeholder="/movies" />
          </Form.Item>
          <Form.Item name="scan_depth" label="最大扫描深度" initialValue={5}
            extra="目录递归深度，建议 3-8，过大会影响扫描速度">
            <Input type="number" min={1} max={20} style={{ width: 120 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default AdminMediaLibrary;
