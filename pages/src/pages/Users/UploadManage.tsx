/**
 * 上传管理页面 — 本地文件上传到指定目录
 * 修复：beforeUpload 现在真正调用 /api/fs/put 上传文件
 */
import React, { useState } from 'react';
import {
  Card, Upload, Button, Table, Progress, Typography,
  Space, Tag, message, Input, Select,
} from 'antd';
import {
  CloudUploadOutlined, InboxOutlined, DeleteOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import api from '../../posts/api';
import { useAuthStore } from '../../store';

const { Title, Text } = Typography;
const { Dragger } = Upload;

interface UploadTask {
  id: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'uploading' | 'success' | 'error' | 'pending';
  targetPath: string;
  errorMsg?: string;
}

const formatSize = (v: number) => {
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const UploadManage: React.FC = () => {
  const { user } = useAuthStore();
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [targetPath, setTargetPath] = useState('/');

  /** 更新指定任务的状态 */
  const updateTask = (id: string, patch: Partial<UploadTask>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  };

  /** 上传单个文件到后端 */
  const uploadFile = async (file: File, taskId: string) => {
    updateTask(taskId, { status: 'uploading', progress: 0 });
    const uploadPath = (targetPath.replace(/\/$/, '') || '') + '/' + file.name;
    try {
      // XMLHttpRequest 支持上传进度
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/fs/put');

        // 认证 token
        const authRaw = localStorage.getItem('openlist-auth');
        if (authRaw) {
          try {
            const parsed = JSON.parse(authRaw);
            const token = parsed?.state?.token;
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          } catch { /* 忽略 */ }
        }

        xhr.setRequestHeader('File-Path', encodeURIComponent(uploadPath));
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('Content-Length', String(file.size));

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            updateTask(taskId, { progress: Math.round((e.loaded / e.total) * 100) });
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
        };
        xhr.onerror = () => reject(new Error('网络错误'));
        xhr.send(file);
      });

      updateTask(taskId, { status: 'success', progress: 100 });
      message.success(`${file.name} 上传成功`);
    } catch (err: any) {
      updateTask(taskId, { status: 'error', errorMsg: err.message });
      message.error(`${file.name} 上传失败: ${err.message}`);
    }
  };

  /** 拖拽 / 点击选择文件 */
  const handleBeforeUpload = (file: File) => {
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const newTask: UploadTask = {
      id: taskId,
      fileName: file.name,
      fileSize: file.size,
      progress: 0,
      status: 'pending',
      targetPath: targetPath,
    };
    setTasks(prev => [...prev, newTask]);
    // 异步开始上传
    uploadFile(file, taskId);
    return false; // 阻止 antd Upload 自动上传
  };

  const columns = [
    { title: '文件名', dataIndex: 'fileName', key: 'fileName',
      render: (name: string) => (
        <Space>
          <FolderOutlined />
          <Text>{name}</Text>
        </Space>
      ),
    },
    { title: '大小', dataIndex: 'fileSize', key: 'fileSize', render: (v: number) => formatSize(v) },
    { title: '进度', dataIndex: 'progress', key: 'progress',
      render: (v: number, row: UploadTask) => (
        <Progress percent={v} status={row.status === 'error' ? 'exception' : row.status === 'success' ? 'success' : 'active'} />
      )
    },
    { title: '状态', dataIndex: 'status', key: 'status',
      render: (v: string) => {
        const map: Record<string, string> = { pending: 'processing', uploading: 'processing', success: 'success', error: 'error' };
        const label: Record<string, string> = { pending: '等待中', uploading: '上传中', success: '已完成', error: '失败' };
        return <Tag color={map[v] || 'default'}>{label[v] || v}</Tag>;
      }
    },
    { title: '操作', key: 'action',
      render: (_: any, row: UploadTask) => (
        <Button size="small" danger icon={<DeleteOutlined />}
          onClick={() => setTasks(prev => prev.filter(t => t.id !== row.id))} />
      )
    },
  ];

  return (
    <div className="animate-fade-in-up" style={{ padding: 24 }}>
      <Card style={{ borderRadius: 14, marginBottom: 16 }}>
        <Title level={5} style={{ marginTop: 0 }}>目标路径</Title>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            prefix={<FolderOutlined />}
            value={targetPath}
            onChange={(e) => setTargetPath(e.target.value)}
            placeholder="输入上传目标路径，如 /home/user/"
          />
        </Space.Compact>
      </Card>

      <Card style={{ borderRadius: 14, marginBottom: 16 }}>
        <Dragger beforeUpload={handleBeforeUpload} multiple showUploadList={false}>
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽文件到此区域上传</p>
          <p className="ant-upload-hint">支持单次或批量上传</p>
        </Dragger>
      </Card>

      {tasks.length > 0 && (
        <Card style={{ borderRadius: 14 }}>
          <Title level={5} style={{ marginTop: 0 }}>上传任务</Title>
          <Table dataSource={tasks} columns={columns} rowKey="id" pagination={false} size="small" />
        </Card>
      )}
    </div>
  );
};

export default UploadManage;
