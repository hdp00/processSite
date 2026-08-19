import { Alert } from "antd";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { getPublishedVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { ConfiguredProcessStartPage } from "./ConfiguredProcessStartPage";
import "./launch-pages.css";

const resolveDefinitionId = (paramId: string | undefined, pathname: string) =>
  paramId ?? pathname.split("/").filter(Boolean).at(-1) ?? "";

export function ProcessStartPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { definitionId } = useParams<{ definitionId?: string }>();
  const resolvedDefinitionId = resolveDefinitionId(definitionId, location.pathname);
  const definition = useProcessDefinitionStore((state) =>
    state.definitions.find((candidate) => candidate.id === resolvedDefinitionId),
  );
  const effectiveVersion = getPublishedVersion(definition);

  if (!definition || definition.disabled || !effectiveVersion) {
    return (
      <div className="page-stack process-start-page">
        <Alert
          type="error"
          showIcon
          message="流程当前不可发起"
          description="没有找到可用的生效流程版本，或流程已经停用。"
          action={<AppBackButton onClick={() => navigate("/launch")} />}
        />
      </div>
    );
  }

  return <ConfiguredProcessStartPage definition={definition} version={effectiveVersion} />;
}
