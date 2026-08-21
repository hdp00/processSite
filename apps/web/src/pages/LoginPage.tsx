import {
  ApartmentOutlined,
  ArrowRightOutlined,
  FileProtectOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Form, Input, message, Tag, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { flowPilotApi } from "../api/flowPilotApi";
import { hydrateRemoteApplication } from "../api/remoteHydration";
import {
  readLastSuccessfulLoginUsername,
  saveLastSuccessfulLoginUsername,
} from "../utils/lastLoginUsername";
import { isBrowserMockMode } from "../utils/runtimeMode";

interface LoginValues {
  username: string;
  password: string;
  remember?: boolean;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [form] = Form.useForm<LoginValues>();
  const debugMode = isBrowserMockMode;
  const [initialUsername] = useState(() =>
    debugMode ? "superadmin" : readLastSuccessfulLoginUsername());
  const [submitting, setSubmitting] = useState(false);

  const submit = async (values: LoginValues) => {
    setSubmitting(true);
    let sessionEstablished = false;
    try {
      await flowPilotApi.auth.login(values.username, values.password);
      sessionEstablished = true;
      if (import.meta.env.VITE_API_MODE === "remote") await hydrateRemoteApplication();
      saveLastSuccessfulLoginUsername(values.username);
      message.success("登录成功");
      navigate("/tasks", { replace: true });
    } catch (error) {
      if (sessionEstablished && import.meta.env.VITE_API_MODE === "remote") {
        await flowPilotApi.auth.logout().catch(() => undefined);
      }
      message.error(error instanceof ApiError ? error.message : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-brand">
          <span className="brand-lockup">
            <span className="moons-wordmark" role="img" aria-label="MOONS'">
              <span className="moons-wordmark-name" aria-hidden="true">MOONS</span>
              <span className="moons-wordmark-apostrophe" aria-hidden="true">&apos;</span>
            </span>
            <small>FlowPilot · 企业流程审核中心</small>
          </span>
        </div>

        <div className="login-hero-copy">
          <Tag className="login-kicker" bordered={false}>公司内网专用</Tag>
          <Typography.Title>让每一次审核，<br />都清晰可追溯。</Typography.Title>
          <Typography.Paragraph>
            灵活配置表单与审批路径，让研发、质量、生产并行协作，
            把文档审核从“找人催办”变成透明、可控的流程。
          </Typography.Paragraph>
        </div>

        <div className="login-feature-grid">
          <div className="login-feature">
            <ApartmentOutlined />
            <span><strong>可视化编排</strong><small>拖拽节点，配置并行审核</small></span>
          </div>
          <div className="login-feature">
            <FileProtectOutlined />
            <span><strong>受控文档会签</strong><small>PDF 预览与版本留痕</small></span>
          </div>
          <div className="login-feature">
            <SafetyCertificateOutlined />
            <span><strong>权限即时生效</strong><small>流程权限组灵活维护</small></span>
          </div>
        </div>

        <p className="login-copyright">MOONS' Internal Systems · Prototype 0.1</p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="login-card-heading">
            <Typography.Text type="secondary">欢迎回来</Typography.Text>
            <Typography.Title level={2}>登录流程中心</Typography.Title>
            <Typography.Paragraph type="secondary">
              {debugMode ? "使用超级管理员进入演示环境" : "使用公司账号进入系统"}
            </Typography.Paragraph>
          </div>

          <Form<LoginValues>
            form={form}
            layout="vertical"
            initialValues={debugMode
              ? { username: initialUsername, password: "1", remember: true }
              : { username: initialUsername, password: "", remember: true }}
            onFinish={submit}
            requiredMark={false}
          >
            <Form.Item
              label="账号"
              name="username"
              rules={[{ required: true, whitespace: true, message: "请输入账号" }]}
            >
              <Input
                size="large"
                prefix={<UserOutlined />}
                placeholder="请输入账号"
                autoComplete="username"
                readOnly={debugMode}
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
              extra={debugMode ? "Debug 演示密码：1。登录后可在顶栏切换演示身份。" : undefined}
            >
              <Input.Password size="large" prefix={<LockOutlined />} placeholder="请输入密码" autoComplete="current-password" />
            </Form.Item>
            <div className="login-form-row">
              <Form.Item name="remember" valuePropName="checked" noStyle>
                <Checkbox>保持登录</Checkbox>
              </Form.Item>
              <Typography.Text type="secondary">内网账号</Typography.Text>
            </div>
            <Button
              className="login-submit"
              type="primary"
              size="large"
              htmlType="submit"
              loading={submitting}
              icon={<ArrowRightOutlined />}
              iconPosition="end"
            >
              登录
            </Button>
          </Form>

        </div>
      </section>
    </main>
  );
}
