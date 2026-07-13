import { RouterProvider } from 'react-router-dom';
import { ConfigProvider, App as AntdApp, Result, Button, Typography, Spin } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useState, useEffect } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import { router } from './router.new';
import { useThemeStore, useLangStore } from './store';
import { getThemeConfig } from './theme/antdTheme';
import './i18n';

const { Paragraph, Text } = Typography;

type SystemStatus = 'loading' | 'ok' | 'jwt_missing' | 'error';

/** 启动时检查系统健康状态 */
async function checkSystemHealth(): Promise<SystemStatus> {
  try {
    const res = await fetch('/api/system/health');
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      if ((body as any)?.message === 'JWT_SECRET_NOT_CONFIGURED') return 'jwt_missing';
    }
    if (!res.ok) return 'error';
    return 'ok';
  } catch {
    return 'error';
  }
}

export default function App() {
  const [status, setStatus] = useState<SystemStatus>('loading');
  const themeMode = useThemeStore(s => s.themeMode);
  const lang = useLangStore(s => s.language);

  useEffect(() => {
    checkSystemHealth().then(setStatus);
  }, []);

  const theme = getThemeConfig(themeMode);
  const locale = lang === 'zh' ? zhCN : enUS;

  if (status === 'loading') {
    return (
      <ConfigProvider theme={theme} locale={locale}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
          <Result icon={<Spin size="large" />} title="正在加载..." />
        </div>
      </ConfigProvider>
    );
  }

  if (status === 'jwt_missing') {
    return (
      <ConfigProvider theme={theme} locale={locale}>
        <Result
          icon={<WarningOutlined style={{ color: '#faad14' }} />}
          status="warning"
          title="系统未配置 JWT 密钥"
          subTitle={
            <Paragraph>
              请在 Cloudflare Workers 环境变量中设置 <Text code>JWT_SECRET</Text>。
            </Paragraph>
          }
        />
      </ConfigProvider>
    );
  }

  return (
    <ErrorBoundary>
      <ConfigProvider theme={theme} locale={locale}>
        <AntdApp>
          <RouterProvider router={router} />
        </AntdApp>
      </ConfigProvider>
    </ErrorBoundary>
  );
}
