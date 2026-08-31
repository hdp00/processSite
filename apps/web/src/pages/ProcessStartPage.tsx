import { Alert } from "antd";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { useProcessLaunchConfig } from "../components/ProcessLaunchConfigContext";
import { canPersonaLaunchDefinition, hasPersonaPermission } from "../state/rolePermissions";
import { resolveLockedProcessVersion } from "../state/processVersionResolver";
import { getPublishedVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { canUserViewInstance } from "../state/workflowAccess";
import { ConfiguredProcessStartPage } from "./ConfiguredProcessStartPage";
import "./launch-pages.css";

const resolveDefinitionId = (paramId: string | undefined, pathname: string) =>
  paramId ?? pathname.split("/").filter(Boolean).at(-1) ?? "";

export function ProcessStartPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { definitionId } = useParams<{ definitionId?: string }>();
  const resolvedDefinitionId = resolveDefinitionId(definitionId, location.pathname);
  const launchConfig = useProcessLaunchConfig();
  const cachedDefinition = useProcessDefinitionStore((state) =>
    state.definitions.find((candidate) => candidate.id === resolvedDefinitionId),
  );
  const definition = cachedDefinition
    ?? (launchConfig?.definition.id === resolvedDefinitionId ? launchConfig.definition : undefined);
  const personaId = usePrototypeStore((state) => state.personaId);
  const instances = usePrototypeStore((state) => state.instances);
  const effectiveVersion = launchConfig?.definition.id === resolvedDefinitionId
    ? launchConfig.version
    : getPublishedVersion(definition);
  const copySourceId = new URLSearchParams(location.search).get("copyFrom");
  const copyCandidate = copySourceId ? instances.find((instance) => instance.id === copySourceId) : undefined;
  const copySourceVersion = copyCandidate ? resolveLockedProcessVersion(definition, copyCandidate) : undefined;
  const canCopySource = Boolean(
    copyCandidate
    && copySourceVersion
    && copyCandidate.definitionId === definition?.id
    && copyCandidate.status === "已完成"
    && copyCandidate.workflowType !== "free"
    && hasPersonaPermission(personaId, "work-list:复制新建")
    && canPersonaLaunchDefinition(personaId, resolvedDefinitionId)
    && canUserViewInstance(personaId, copyCandidate),
  );

  if (!definition || definition.disabled || !effectiveVersion) {
    return (
      <div className="page-stack process-start-page">
        <Alert
          type="error"
          showIcon
          title="流程当前不可发起"
          description="没有找到可用的生效流程版本，或流程已经停用。"
          action={<AppBackButton onClick={() => navigate("/launch")} />}
        />
      </div>
    );
  }

  if (copySourceId && !canCopySource) {
    return (
      <div className="page-stack process-start-page">
        <Alert
          type="error"
          showIcon
          title="无法复制新建"
          description="来源流程必须为当前流程中已完成且你有权查看的实例，同时当前账号需要复制新建和流程发起权限。"
          action={<AppBackButton onClick={() => navigate(`/processes?definitionId=${encodeURIComponent(definition.id)}`)} />}
        />
      </div>
    );
  }

  return <ConfiguredProcessStartPage
    key={`${definition.id}:${copyCandidate?.id ?? "new"}`}
    definition={definition}
    version={effectiveVersion}
    copySource={canCopySource ? copyCandidate : undefined}
    copySourceVersion={canCopySource ? copySourceVersion : undefined}
    assigneeCandidatesByNode={launchConfig?.assigneeCandidatesByNode}
    firstAssigneeCandidates={launchConfig?.firstAssigneeCandidates}
  />;
}
