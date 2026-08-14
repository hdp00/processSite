import {
  ApartmentOutlined,
  ArrowRightOutlined,
  FileProtectOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Checkbox, Form, Input, message, Select, Space, Tag, Typography } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { personas, usePrototypeStore, type PersonaId } from "../state/usePrototypeStore";

interface LoginValues {
  username: string;
  password: string;
  remember?: boolean;
}

const usernameMap: Record<string, PersonaId> = {
  superadmin: "superadmin",
  wangmin: "wangmin",
  zhangwei: "zhangwei",
  lina: "lina",
  zhaolei: "zhaolei",
  admin: "admin",
  hejing: "hejing",
};

export function LoginPage() {
  const navigate = useNavigate();
  const login = usePrototypeStore((state) => state.login);
  const [form] = Form.useForm<LoginValues>();
  const [submitting, setSubmitting] = useState(false);
  const [demoPersona, setDemoPersona] = useState<PersonaId>("lina");

  const submit = async (values: LoginValues) => {
    setSubmitting(true);
    await new Promise((resolve) => window.setTimeout(resolve, 420));
    if (values.username.trim().toLowerCase() === "disabled") {
      message.error("该账号已停用，请联系管理员");
      setSubmitting(false);
      return;
    }
    const personaId = usernameMap[values.username.trim().toLowerCase()] ?? demoPersona;
    login(personaId);
    message.success("登录成功");
    navigate("/tasks", { replace: true });
  };

  const fillDemo = (personaId: PersonaId) => {
    setDemoPersona(personaId);
    form.setFieldsValue({ username: personaId, password: "1", remember: true });
  };

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-brand">
          <span className="brand-mark brand-mark-large">FP</span>
          <span>
            <strong>FlowPilot</strong>
            <small>企业流程审核中心</small>
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
            <Typography.Paragraph type="secondary">使用公司本地账号进入系统</Typography.Paragraph>
          </div>

          <Form<LoginValues>
            form={form}
            layout="vertical"
            initialValues={{ username: "lina", password: "1", remember: true }}
            onFinish={submit}
            requiredMark={false}
          >
            <Form.Item
              label="账号"
              name="username"
              rules={[{ required: true, whitespace: true, message: "请输入账号" }]}
            >
              <Input size="large" prefix={<UserOutlined />} placeholder="请输入本地账号" autoComplete="username" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
              extra="首版允许单字符密码；生产系统仍会进行不可逆哈希存储。"
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

          <div className="demo-login">
            <div className="demo-login-title"><span />选择演示身份<span /></div>
            <Space.Compact block>
              <Select
                value={demoPersona}
                onChange={(value: PersonaId) => fillDemo(value)}
                options={personas.map((item) => ({ value: item.id, label: `${item.name} · ${item.role}` }))}
                style={{ flex: 1 }}
              />
              <Button onClick={() => fillDemo(demoPersona)}>填入账号</Button>
            </Space.Compact>
            <Typography.Text type="secondary">演示密码均为：1</Typography.Text>
          </div>
        </div>
      </section>
    </main>
  );
}
