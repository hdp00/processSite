import { attachmentNotificationHandlers } from "./attachmentsNotifications";
import { auditHandlers } from "./audit";
import { definitionHandlers } from "./definitions";
import { freeFlowHandlers } from "./freeFlows";
import { exportHandlers } from "./exports";
import { instanceTaskHandlers } from "./instancesTasks";
import { organizationHandlers } from "./organization";
import { systemDirectoryHandlers } from "./systemDirectory";

export const handlers = [
  ...systemDirectoryHandlers,
  ...organizationHandlers,
  ...definitionHandlers,
  ...instanceTaskHandlers,
  ...exportHandlers,
  ...freeFlowHandlers,
  ...attachmentNotificationHandlers,
  ...auditHandlers,
];
