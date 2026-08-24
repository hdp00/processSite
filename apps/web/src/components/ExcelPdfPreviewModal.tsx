import { Alert, Descriptions, Modal, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import type { ExcelPdfConversionResult } from "../utils/excelToPdf";
import "./excel-pdf-preview-modal.css";

export function ExcelPdfPreviewModal({
  sourceName,
  result,
  converting,
  confirming,
  error,
  onCancel,
  onConfirm,
}: {
  sourceName?: string;
  result?: ExcelPdfConversionResult;
  converting: boolean;
  confirming: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    if (!result) {
      setPreviewUrl(undefined);
      return;
    }
    const nextUrl = URL.createObjectURL(result.file);
    setPreviewUrl(nextUrl);
    return () => {
      window.setTimeout(() => URL.revokeObjectURL(nextUrl), 500);
    };
  }, [result]);

  return (
    <Modal
      className="excel-pdf-preview-modal"
      open={Boolean(sourceName)}
      width="min(1040px, calc(100vw - 48px))"
      title="Excel 转 PDF 预览"
      okText="确认并上传 PDF"
      cancelText="取消"
      okButtonProps={{ disabled: !result || converting || Boolean(error), loading: confirming }}
      cancelButtonProps={{ disabled: confirming }}
      mask={{ closable: !confirming }}
      closable={!confirming}
      destroyOnHidden
      onCancel={onCancel}
      onOk={onConfirm}
    >
      {converting ? <div className="excel-pdf-converting"><Spin size="large" description="正在解析 Excel 并生成 PDF" /></div> : null}
      {error ? <Alert className="excel-pdf-error" type="error" showIcon title="转换失败" description={error} /> : null}
      {result ? (
        <>
          <Descriptions
            className="excel-pdf-meta"
            bordered
            size="small"
            column={3}
            items={[
              { key: "source", label: "来源文件", children: sourceName },
              { key: "sheets", label: "可见工作表", children: `${result.worksheetCount} 个` },
              { key: "pages", label: "生成页数", children: `${result.generatedPages} 页` },
              { key: "target", label: "上传文件", span: 3, children: result.file.name },
            ]}
          />
          {previewUrl ? <iframe className="excel-pdf-preview-frame" src={`${previewUrl}#toolbar=1&navpanes=0`} title={`PDF 预览：${result.file.name}`} /> : null}
          <Typography.Text className="excel-pdf-confirm-hint" type="secondary">请检查分页和内容，确认后系统仅上传此 PDF。</Typography.Text>
        </>
      ) : null}
    </Modal>
  );
}
