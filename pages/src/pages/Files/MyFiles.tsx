/**
 * 我的文件 — 用户个人文件空间
 *
 * 逻辑：
 *  1. 从系统公开设置读取 user_home_dir（默认 /home/）
 *  2. 拼接 /home/<用户名>/ 作为用户根目录
 *  3. 嵌入式文件浏览器，与主 FileManager 体验一致，但 basePath 锁定
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Table, Button, Breadcrumb, Dropdown, Modal, Input, Upload,
  Typography, Tooltip, Empty, Skeleton, message, Space,
} from 'antd';
import {
  FolderOutlined, FileOutlined, HomeOutlined, ReloadOutlined,
  UploadOutlined, FolderAddOutlined, DeleteOutlined, EditOutlined,
  CopyOutlined, ScissorOutlined, ShareAltOutlined, MoreOutlined,
  DownloadOutlined, AppstoreOutlined, UnorderedListOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { useAuthStore } from '../../store';
import api from '../../posts/api';

const { Text } = Typography;
const { confirm } = Modal;

interface FileItem {
  filePath: string;
  fileName: string;
  fileSize: number;
  fileType: number;
  timeModify?: string;
  thumbnails?: string;
}

const MyFiles: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuthStore();

  if (!user) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description="请先登录" />
      </div>
    );
  }

  const homeDir = `/home/${user.users_name || 'user'}/`;

  return (
    <div className="animate-fade-in-up" style={{ padding: 24 }}>
      <Card style={{ borderRadius: 14 }}>
        <Space style={{ marginBottom: 16 }}>
          <HomeOutlined />
          <Typography.Text strong>我的文件：{homeDir}</Typography.Text>
        </Space>
        <Empty description="暂无文件" />
      </Card>
    </div>
  );
};

export default MyFiles;
