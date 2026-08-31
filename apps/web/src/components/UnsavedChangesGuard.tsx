import { Button, Modal, Typography, message } from "antd";
import { useCallback, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";

interface UnsavedChangesGuardOptions {
  dirty: boolean;
  onSave?: () => boolean | void | Promise<boolean | void>;
  title?: string;
  description?: string;
}

export function useUnsavedChangesGuard({
  dirty,
  onSave,
  title = "当前页面有未保存修改",
  description = "离开后，尚未保存的修改将丢失。",
}: UnsavedChangesGuardOptions) {
  const bypassNextNavigation = useRef(false);
  const [saving, setSaving] = useState(false);
  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }) => {
    if (bypassNextNavigation.current) {
      bypassNextNavigation.current = false;
      return false;
    }
    return dirty && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`;
  }, [dirty]));

  useBeforeUnload(useCallback((event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  }, [dirty]));

  const allowNextNavigation = useCallback(() => {
    bypassNextNavigation.current = true;
  }, []);

  const saveAndLeave = async () => {
    if (!onSave || blocker.state !== "blocked") return;
    setSaving(true);
    try {
      const result = await onSave();
      if (result === false) return;
      blocker.proceed();
    } catch {
      message.error("保存失败，已留在当前页面");
    } finally {
      setSaving(false);
    }
  };

  const guard = <Modal
    open={blocker.state === "blocked"}
    title={title}
    closable={false}
    mask={{ closable: false }}
    keyboard={false}
    footer={[
      <Button key="stay" onClick={() => blocker.state === "blocked" && blocker.reset()}>留在当前页</Button>,
      <Button key="discard" danger onClick={() => blocker.state === "blocked" && blocker.proceed()}>放弃修改并离开</Button>,
      onSave ? <Button key="save" type="primary" loading={saving} onClick={() => void saveAndLeave()}>保存并离开</Button> : null,
    ]}
  >
    <Typography.Paragraph style={{ marginBottom: 0 }}>{description}</Typography.Paragraph>
  </Modal>;

  return { guard, allowNextNavigation };
}
