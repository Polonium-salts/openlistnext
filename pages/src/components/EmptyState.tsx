/**
 * EmptyState — 品牌化空状态组件
 * 替代 Ant Design 默认 <Empty />，与 OpenList 设计风格统一
 *
 * 支持类型：files（文件）、users（用户）、data（数据）、search（搜索）、default
 */
import React from 'react';
import { Button, Typography } from 'antd';
import {
  FolderOpenOutlined, TeamOutlined, DatabaseOutlined,
  SearchOutlined, InboxOutlined,
} from '@ant-design/icons';
import { useThemeStore } from '../store';

const { Text, Title } = Typography;

interface EmptyStateProps {
  type?: 'files' | 'users' | 'data' | 'search' | 'default';
  title?: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  style?: React.CSSProperties;
}

const PRESETS = {
  files: {
    icon: FolderOpenOutlined,
    iconColor: '#F59E0B',
    title: '此目录为空',
    description: '还没有任何文件，点击上方按钮上传或创建文件夹',
  },
  users: {
    icon: TeamOutlined,
    iconColor: '#3B82F6',
    title: '暂无用户',
    description: '还没有任何用户，点击"新建用户"创建第一个用户',
  },
  data: {
    icon: DatabaseOutlined,
    iconColor: '#8B5CF6',
    title: '暂无数据',
    description: '当前没有可显示的数据',
  },
  search: {
    icon: SearchOutlined,
    iconColor: '#10B981',
    title: '没有找到匹配结果',
    description: '试试修改搜索关键词，或清除筛选条件',
  },
  default: {
    icon: InboxOutlined,
    iconColor: '#6B7280',
    title: '暂无内容',
    description: '这里还没有任何内容',
  },
};

const EmptyState: React.FC<EmptyStateProps> = ({
  type = 'default',
  title,
  description,
  action,
  style,
}) => {
  const { themeMode } = useThemeStore();
  const isDark = themeMode === 'dark' || themeMode === 'transparent';
  const preset = PRESETS[type];
  const IconComponent = preset.icon;

  return (
    <div
      className="animate-fade-in"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '60px 32px',
        textAlign: 'center',
        ...style,
      }}
    >
      {/* 图标容器（带渐变光圈） */}
      <div style={{ position: 'relative', marginBottom: 20 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 20,
          background: isDark
            ? `rgba(${preset.iconColor === '#F59E0B' ? '245,158,11' : preset.iconColor === '#3B82F6' ? '59,130,246' : '139,92,246'},0.12)`
            : `${preset.iconColor}18`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `1px solid ${preset.iconColor}28`,
          boxShadow: `0 0 24px ${preset.iconColor}18`,
          transition: 'all 0.3s',
        }}>
          <IconComponent style={{ fontSize: 34, color: preset.iconColor }} />
        </div>
        {/* 装饰点 */}
        <div style={{
          position: 'absolute', top: -4, right: -4,
          width: 10, height: 10, borderRadius: '50%',
          background: preset.iconColor, opacity: 0.4,
        }} />
      </div>

      {/* 标题 */}
      <Title level={5} style={{
        margin: '0 0 8px',
        color: isDark ? '#E5E7EB' : '#374151',
        fontWeight: 600,
        letterSpacing: '-0.01em',
      }}>
        {title || preset.title}
      </Title>

      {/* 描述 */}
      <Text style={{
        color: isDark ? '#6B7280' : '#9CA3AF',
        fontSize: 13,
        lineHeight: 1.6,
        maxWidth: 280,
        display: 'block',
      }}>
        {description || preset.description}
      </Text>

      {/* 操作按钮 */}
      {action && (
        <Button
          type="primary"
          size="middle"
          onClick={action.onClick}
          style={{
            marginTop: 20,
            background: 'linear-gradient(135deg, #3B82F6, #6366F1)',
            border: 'none',
            borderRadius: 8,
            height: 36,
            fontWeight: 500,
          }}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
};

export default EmptyState;
